import type pg from 'pg';
import type { InvoiceState, WorkOrder, WorkStatus, WorkTechnician } from '../../shared/api-types.ts';
import { rupeesToPaise } from '../../shared/money.ts';
import type { WorkCompleteInput, WorkOrderInput, WorkOrderUpdate } from '../../shared/schemas.ts';
import { withActorContext } from '../db/actor-context.ts';
import { withTransaction } from '../db/client.ts';
import { DuplicateSubmission, findByIdempotencyKey, isDuplicateSubmission } from './submissions.ts';
import type { Actor } from './types.ts';
import { assertWarrantyCover, InvalidWarranty } from './warranty.ts';

// Work allocation. The Master or Admin Technician creates a work order and assigns it to an
// "Invoice + Work allocation" technician. The technician sees it under Works assigned, starts
// it, and completes it by raising the invoice, which then enters the normal Work Inv queue.
// If the office rejects that invoice, the job returns to the technician (see workinv.reject).
// Technicians cannot hand a job back; only the office re-assigns or cancels.

const OPEN: WorkStatus[] = ['assigned', 'in_progress'];

interface WorkRow {
  id: string;
  status: WorkStatus;
  customer_name: string;
  phone_e164: string;
  area_id: string | null;
  area_name: string | null;
  visit_address: string | null;
  appliance_type_key: string;
  appliance_label: string;
  brand_id: string | null;
  brand_name: string | null;
  complaint: string | null;
  scheduled_at: Date | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  assigned_by_name: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancel_reason: string | null;
  invoice_id: string | null;
  invoice_state: InvoiceState | null;
  invoice_number: number | null;
  rejected_reason: string | null;
}

// Only columns a technician may read (see drizzle/0003_rls.sql and 0007_work_rls.sql): never the
// invoice message, and the invoice join is limited by row-level security to their own invoices.
const WORK_SELECT = `
  SELECT j.id, j.status, c.name AS customer_name, c.phone_e164, j.area_id, a.name AS area_name,
         j.visit_address, j.appliance_type_key, apt.label AS appliance_label, j.brand_id,
         b.name AS brand_name, j.complaint, j.scheduled_at, j.assigned_to,
         ut.display_name AS assigned_to_name, ub.display_name AS assigned_by_name,
         j.started_at, j.completed_at, j.cancel_reason,
         inv.id AS invoice_id, inv.state AS invoice_state, inv.invoice_number, inv.rejected_reason
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  JOIN appliance_types apt ON apt.key = j.appliance_type_key
  LEFT JOIN areas a ON a.id = j.area_id
  LEFT JOIN brands b ON b.id = j.brand_id
  LEFT JOIN users ut ON ut.id = j.assigned_to
  LEFT JOIN users ub ON ub.id = j.assigned_by
  LEFT JOIN LATERAL (
    SELECT id, state, invoice_number, rejected_reason FROM invoices
    WHERE job_id = j.id ORDER BY submitted_at DESC LIMIT 1
  ) inv ON true`;

function toWorkOrder(r: WorkRow): WorkOrder {
  return {
    id: r.id,
    status: r.status,
    customerName: r.customer_name,
    phone: r.phone_e164,
    areaId: r.area_id,
    area: r.area_name,
    address: r.visit_address,
    applianceTypeKey: r.appliance_type_key,
    appliance: r.appliance_label,
    brandId: r.brand_id,
    brand: r.brand_name,
    complaint: r.complaint,
    scheduledAt: r.scheduled_at?.toISOString() ?? null,
    assignedToId: r.assigned_to,
    assignedToName: r.assigned_to_name,
    assignedByName: r.assigned_by_name,
    startedAt: r.started_at?.toISOString() ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
    cancelReason: r.cancel_reason,
    invoice: r.invoice_id
      ? { id: r.invoice_id, state: r.invoice_state!, invoiceNumber: r.invoice_number, rejectedReason: r.rejected_reason }
      : null,
  };
}

// ------------------------------------------------------------------ office: Master + Admin Technician

export type WorkView = 'open' | 'completed' | 'cancelled';

export async function listWorkOrders(pool: pg.Pool, view: WorkView, limit: number): Promise<WorkOrder[]> {
  const where =
    view === 'open'
      ? "j.status IN ('assigned', 'in_progress') ORDER BY j.scheduled_at NULLS LAST, j.assigned_at"
      : view === 'completed'
        ? "j.status = 'completed' ORDER BY j.completed_at DESC"
        : "j.status = 'cancelled' ORDER BY j.cancelled_at DESC NULLS LAST";
  const res = await pool.query<WorkRow>(`${WORK_SELECT} WHERE j.assigned_to IS NOT NULL AND ${where} LIMIT $1`, [limit]);
  return res.rows.map(toWorkOrder);
}

/** Technicians who can take work: active, labelled "Invoice + Work allocation". */
export async function listWorkTechnicians(pool: pg.Pool): Promise<WorkTechnician[]> {
  const res = await pool.query<WorkTechnician>(
    `SELECT u.id, u.display_name AS "displayName",
            (SELECT count(*)::int FROM jobs j
              WHERE j.assigned_to = u.id AND j.status IN ('assigned', 'in_progress')) AS "openJobs"
     FROM users u
     WHERE u.role_key = 'technician' AND u.technician_mode = 'invoice_and_work' AND u.status = 'active'
     ORDER BY u.display_name`,
  );
  return res.rows;
}

export type WorkError = 'not_found' | 'wrong_state' | 'invalid_assignee' | 'invalid_reference' | 'invalid_warranty';
export type WorkResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: WorkError };

/** Locks the assignee row so their label can't change underneath the assignment. */
async function isWorkTechnician(client: pg.PoolClient, userId: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM users
     WHERE id = $1 AND role_key = 'technician' AND technician_mode = 'invoice_and_work' AND status = 'active'
     FOR SHARE`,
    [userId],
  );
  return res.rowCount === 1;
}

async function auditJob(
  client: pg.PoolClient,
  actor: Actor,
  action: string,
  jobId: string,
  oldValues: unknown,
  newValues: unknown,
  reason: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, reason, ip)
     VALUES ($1, $2, 'job', $3, $4, $5, $6, $7)`,
    [
      actor.id,
      action,
      jobId,
      oldValues === null ? null : JSON.stringify(oldValues),
      newValues === null ? null : JSON.stringify(newValues),
      reason,
      actor.ip ?? null,
    ],
  );
}

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23503';
}

export async function createWorkOrder(
  pool: pg.Pool,
  actor: Actor,
  input: WorkOrderInput,
): Promise<WorkResult<{ jobId: string }>> {
  try {
    return await withTransaction(pool, async (client) => {
      if (!(await isWorkTechnician(client, input.assignedTo))) return { ok: false, error: 'invalid_assignee' };
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers (phone_e164, name, area_id) VALUES ($1, $2, $3)
         ON CONFLICT (phone_e164) DO UPDATE
           SET name = EXCLUDED.name,
               area_id = coalesce(EXCLUDED.area_id, customers.area_id),
               updated_at = now()
         RETURNING id`,
        [input.phone, input.customerName, input.areaId],
      );
      const job = await client.query<{ id: string }>(
        `INSERT INTO jobs (customer_id, appliance_type_key, brand_id, area_id, complaint, visit_address,
                           status, assigned_to, assigned_by, assigned_at, scheduled_at, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'assigned', $7, $8, now(), $9, 'app', $8)
         RETURNING id`,
        [
          customer.rows[0]!.id,
          input.applianceTypeKey,
          input.brandId,
          input.areaId,
          input.complaint,
          input.visitAddress || null,
          input.assignedTo,
          actor.id,
          input.scheduledAt,
        ],
      );
      const jobId = job.rows[0]!.id;
      await auditJob(client, actor, 'work.assigned', jobId, null, {
        assigned_to: input.assignedTo,
        scheduled_at: input.scheduledAt,
        complaint: input.complaint,
      });
      return { ok: true, jobId };
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, error: 'invalid_reference' };
    throw err;
  }
}

interface OpenJobRow {
  status: WorkStatus;
  assigned_to: string | null;
  scheduled_at: Date | null;
  complaint: string | null;
  visit_address: string | null;
}

async function lockOpenJob(client: pg.PoolClient, jobId: string): Promise<OpenJobRow | 'not_found' | 'wrong_state'> {
  const res = await client.query<OpenJobRow>(
    'SELECT status, assigned_to, scheduled_at, complaint, visit_address FROM jobs WHERE id = $1 FOR UPDATE',
    [jobId],
  );
  const job = res.rows[0];
  if (!job || !job.assigned_to) return 'not_found';
  if (!OPEN.includes(job.status)) return 'wrong_state';
  return job;
}

/** Re-assign, reschedule or correct an open work order. Re-assigning restarts it as "assigned". */
export async function updateWorkOrder(
  pool: pg.Pool,
  actor: Actor,
  jobId: string,
  input: WorkOrderUpdate,
): Promise<WorkResult<{ previousAssignee: string; assignee: string }>> {
  return withTransaction(pool, async (client) => {
    const job = await lockOpenJob(client, jobId);
    if (typeof job === 'string') return { ok: false, error: job };
    const previousAssignee = job.assigned_to!;
    const reassign = input.assignedTo !== undefined && input.assignedTo !== previousAssignee;
    if (reassign && !(await isWorkTechnician(client, input.assignedTo!))) return { ok: false, error: 'invalid_assignee' };
    const next = {
      assigned_to: reassign ? input.assignedTo! : previousAssignee,
      scheduled_at: input.scheduledAt ?? job.scheduled_at?.toISOString() ?? null,
      complaint: input.complaint ?? job.complaint,
      visit_address: input.visitAddress !== undefined ? input.visitAddress || null : job.visit_address,
    };
    await client.query(
      `UPDATE jobs SET assigned_to = $2, scheduled_at = $3, complaint = $4, visit_address = $5,
              status = CASE WHEN $6 THEN 'assigned'::job_status ELSE status END,
              started_at = CASE WHEN $6 THEN NULL ELSE started_at END,
              assigned_by = CASE WHEN $6 THEN $7::uuid ELSE assigned_by END,
              assigned_at = CASE WHEN $6 THEN now() ELSE assigned_at END,
              updated_at = now()
       WHERE id = $1`,
      [jobId, next.assigned_to, next.scheduled_at, next.complaint, next.visit_address, reassign, actor.id],
    );
    await auditJob(
      client,
      actor,
      reassign ? 'work.reassigned' : 'work.updated',
      jobId,
      {
        assigned_to: previousAssignee,
        scheduled_at: job.scheduled_at?.toISOString() ?? null,
        complaint: job.complaint,
        visit_address: job.visit_address,
      },
      next,
    );
    return { ok: true, previousAssignee, assignee: next.assigned_to };
  });
}

export async function cancelWorkOrder(
  pool: pg.Pool,
  actor: Actor,
  jobId: string,
  reason: string,
): Promise<WorkResult<{ assignee: string }>> {
  return withTransaction(pool, async (client) => {
    const job = await lockOpenJob(client, jobId);
    if (typeof job === 'string') return { ok: false, error: job };
    await client.query(
      `UPDATE jobs SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, cancelled_at = now(),
              updated_at = now()
       WHERE id = $1`,
      [jobId, reason, actor.id],
    );
    await auditJob(client, actor, 'work.cancelled', jobId, { status: job.status }, { status: 'cancelled' }, reason);
    return { ok: true, assignee: job.assigned_to! };
  });
}

// ------------------------------------------------------------------ technician: Works assigned

/**
 * The technician's own work: open jobs first (by visit time), then what they completed in the
 * last 7 days and what the office cancelled in the last 2 days. Runs in the technician's DB
 * context, so row-level security also limits it to jobs assigned to them.
 */
export async function listMyWork(pool: pg.Pool, actor: Actor): Promise<WorkOrder[]> {
  const res = await withActorContext(pool, actor, (client) =>
    client.query<WorkRow>(
      `${WORK_SELECT}
       WHERE j.assigned_to = $1
         AND (j.status IN ('assigned', 'in_progress')
              OR (j.status = 'completed' AND j.completed_at > now() - interval '7 days')
              OR (j.status = 'cancelled' AND j.cancelled_at > now() - interval '2 days'))
       ORDER BY CASE WHEN j.status IN ('assigned', 'in_progress') THEN 0 ELSE 1 END,
                CASE WHEN j.status IN ('assigned', 'in_progress') THEN j.scheduled_at END NULLS LAST,
                coalesce(j.completed_at, j.cancelled_at) DESC
       LIMIT 200`,
      [actor.id],
    ),
  );
  return res.rows.map(toWorkOrder);
}

/** "Start": the technician is on the way / at the customer. */
export async function startWork(pool: pg.Pool, actor: Actor, jobId: string): Promise<WorkResult> {
  return withActorContext(pool, actor, async (client) => {
    const res = await client.query<{ status: WorkStatus }>(
      'SELECT status FROM jobs WHERE id = $1 AND assigned_to = $2 FOR UPDATE',
      [jobId, actor.id],
    );
    const job = res.rows[0];
    if (!job) return { ok: false, error: 'not_found' };
    if (job.status === 'in_progress') return { ok: true };
    if (job.status !== 'assigned') return { ok: false, error: 'wrong_state' };
    await client.query(
      "UPDATE jobs SET status = 'in_progress', started_at = now(), updated_at = now() WHERE id = $1",
      [jobId],
    );
    await auditJob(client, actor, 'work.started', jobId, { status: 'assigned' }, { status: 'in_progress' });
    return { ok: true };
  });
}

/**
 * Completes an assigned job and raises its invoice (state `submitted`, no number yet), which
 * then waits in Work Inv like any other submission. Idempotent on `input.idempotencyKey`, so
 * the offline outbox can retry safely.
 */
export async function completeWork(
  pool: pg.Pool,
  actor: Actor,
  jobId: string,
  input: WorkCompleteInput,
): Promise<WorkResult<{ invoiceId: string; created: boolean }>> {
  const run = () =>
    withActorContext(pool, actor, async (client): Promise<WorkResult<{ invoiceId: string; created: boolean }>> => {
      // Lock first: a concurrent retry with the same key then sees the winner's invoice below.
      const res = await client.query<{ status: WorkStatus }>(
        'SELECT status FROM jobs WHERE id = $1 AND assigned_to = $2 FOR UPDATE',
        [jobId, actor.id],
      );
      const job = res.rows[0];
      const existing = await findByIdempotencyKey(client, input.idempotencyKey);
      if (existing) {
        return existing.jobId === jobId ? { ok: true, invoiceId: existing.invoiceId, created: false } : { ok: false, error: 'wrong_state' };
      }
      if (!job) return { ok: false, error: 'not_found' };
      if (!OPEN.includes(job.status)) return { ok: false, error: 'wrong_state' };

      const totalPaise = rupeesToPaise(input.totalRupees);
      const spareCostPaise = rupeesToPaise(input.spareCostRupees);
      if (input.warrantyOfInvoiceId) {
        const phone = await client.query<{ phone_e164: string }>(
          'SELECT c.phone_e164 FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = $1',
          [jobId],
        );
        await assertWarrantyCover(client, input.warrantyOfInvoiceId, phone.rows[0]!.phone_e164);
      }
      await client.query(
        `UPDATE jobs SET status = 'completed', completed_at = now(), started_at = coalesce(started_at, now()),
                service_description = $2, brand_id = coalesce($3, brand_id), updated_at = now()
         WHERE id = $1`,
        [jobId, input.serviceDescription, input.brandId],
      );
      const invoice = await client.query<{ id: string }>(
        `INSERT INTO invoices (job_id, idempotency_key, total_paise, spare_cost_paise,
                               negative_margin_flag, submitted_by, warranty_of_invoice_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [jobId, input.idempotencyKey, totalPaise, spareCostPaise, spareCostPaise > totalPaise, actor.id, input.warrantyOfInvoiceId],
      );
      const invoiceId = invoice.rows[0]?.id;
      if (!invoiceId) throw new DuplicateSubmission();
      if (input.payment.status === 'paid' && totalPaise > 0) {
        await client.query(
          `INSERT INTO payments (invoice_id, mode, amount_paise, collected_by_user_id)
           VALUES ($1, $2, $3, $4)`,
          [invoiceId, input.payment.mode, totalPaise, actor.id],
        );
      }
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, new_values, ip)
         VALUES ($1, 'invoice.submitted', 'invoice', $2, $3, $4)`,
        [
          actor.id,
          invoiceId,
          JSON.stringify({
            job_id: jobId,
            source: 'work_order',
            total_paise: totalPaise,
            spare_cost_paise: spareCostPaise,
            payment: input.payment,
            warranty_of_invoice_id: input.warrantyOfInvoiceId,
          }),
          actor.ip ?? null,
        ],
      );
      await auditJob(client, actor, 'work.completed', jobId, { status: job.status }, { status: 'completed', invoice_id: invoiceId });
      return { ok: true, invoiceId, created: true };
    });
  try {
    return await run();
  } catch (err) {
    if (err instanceof InvalidWarranty) return { ok: false, error: 'invalid_warranty' };
    // A concurrent request with the same key committed first: answer with its invoice.
    if (isDuplicateSubmission(err)) return run();
    if (isForeignKeyViolation(err)) return { ok: false, error: 'invalid_reference' };
    throw err;
  }
}
