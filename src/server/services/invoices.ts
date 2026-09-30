import type pg from 'pg';
import type {
  InvoiceDetail,
  InvoiceRow,
  InvoiceState,
  MySubmission,
  PaymentMode,
  VoidRequestRow,
} from '../../shared/api-types.ts';
import type { SubmissionInput } from '../../shared/schemas.ts';
import { withActorContext } from '../db/actor-context.ts';
import { isUniqueViolation, withTransaction } from '../db/client.ts';
import { issueWithClient } from './issue.ts';
import { findByIdempotencyKey, insertSubmission, isDuplicateSubmission } from './submissions.ts';
import type { Actor } from './types.ts';

// ------------------------------------------------------------------ technician: own submissions

interface MineRow {
  id: string;
  state: InvoiceState;
  invoice_number: number | null;
  invoice_date: string;
  submitted_at: Date;
  customer_name: string;
  phone_e164: string;
  area_name: string | null;
  appliance_label: string;
  brand_name: string | null;
  service_description: string;
  total_paise: number;
  spare_cost_paise: number;
  payment_mode: PaymentMode | null;
  rejected_reason: string | null;
  edited_flag: boolean;
  warranty_service: boolean;
}

/**
 * The actor's own submissions with status. Runs in the actor's DB context: for technicians,
 * row-level security enforces "own rows only" and `rendered_message` is not even selectable.
 * The DTO has no message, profit or WhatsApp link by construction.
 */
export async function listMine(pool: pg.Pool, actor: Actor, limit: number): Promise<MySubmission[]> {
  const res = await withActorContext(pool, actor, (client) =>
    client.query<MineRow>(
      `SELECT i.id, i.state, i.invoice_number, i.invoice_date, i.submitted_at,
              c.name AS customer_name, c.phone_e164, a.name AS area_name, apt.label AS appliance_label,
              b.name AS brand_name, j.service_description, i.total_paise, i.spare_cost_paise,
              pay.mode AS payment_mode, i.rejected_reason, i.edited_flag,
              i.warranty_of_invoice_id IS NOT NULL AS warranty_service
       FROM invoices i
       JOIN jobs j ON j.id = i.job_id
       JOIN customers c ON c.id = j.customer_id
       JOIN appliance_types apt ON apt.key = j.appliance_type_key
       LEFT JOIN areas a ON a.id = j.area_id
       LEFT JOIN brands b ON b.id = j.brand_id
       LEFT JOIN LATERAL (SELECT mode FROM payments WHERE invoice_id = i.id ORDER BY received_at LIMIT 1) pay ON true
       WHERE i.submitted_by = $1
       ORDER BY i.submitted_at DESC
       LIMIT $2`,
      [actor.id, limit],
    ),
  );
  return res.rows.map((r) => ({
    id: r.id,
    state: r.state,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    submittedAt: r.submitted_at.toISOString(),
    customerName: r.customer_name,
    phone: r.phone_e164,
    area: r.area_name,
    appliance: r.appliance_label,
    brand: r.brand_name,
    serviceDescription: r.service_description,
    totalPaise: r.total_paise,
    spareCostPaise: r.spare_cost_paise,
    paymentMode: r.payment_mode,
    rejectedReason: r.rejected_reason,
    editedByOffice: r.edited_flag,
    warrantyService: r.warranty_service,
  }));
}

// ------------------------------------------------------------------ admin: all invoices

interface RowData {
  id: string;
  state: InvoiceState;
  invoice_number: number | null;
  invoice_date: string;
  submitted_at: Date;
  technician_name: string;
  customer_name: string;
  phone_e164: string;
  area_name: string | null;
  appliance_label: string;
  total_paise: number;
  spare_cost_paise: number;
  payment_mode: PaymentMode | null;
  self_issued_flag: boolean;
  edited_flag: boolean;
  negative_margin_flag: boolean;
  void_request_pending: boolean;
  warranty_for_number: number | null;
}

const ROW_SELECT = `
  SELECT i.id, i.state, i.invoice_number, i.invoice_date, i.submitted_at,
         sub.display_name AS technician_name, c.name AS customer_name, c.phone_e164,
         a.name AS area_name, apt.label AS appliance_label, i.total_paise, i.spare_cost_paise,
         pay.mode AS payment_mode, i.self_issued_flag, i.edited_flag, i.negative_margin_flag,
         EXISTS (SELECT 1 FROM void_requests vr WHERE vr.invoice_id = i.id AND vr.status = 'pending')
           AS void_request_pending,
         (SELECT w.invoice_number FROM invoices w WHERE w.id = i.warranty_of_invoice_id) AS warranty_for_number
  FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  JOIN customers c ON c.id = j.customer_id
  JOIN users sub ON sub.id = i.submitted_by
  JOIN appliance_types apt ON apt.key = j.appliance_type_key
  LEFT JOIN areas a ON a.id = j.area_id
  LEFT JOIN LATERAL (SELECT mode FROM payments WHERE invoice_id = i.id ORDER BY received_at LIMIT 1) pay ON true`;

function toRow(r: RowData): InvoiceRow {
  return {
    id: r.id,
    state: r.state,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    submittedAt: r.submitted_at.toISOString(),
    technicianName: r.technician_name,
    customerName: r.customer_name,
    phone: r.phone_e164,
    area: r.area_name,
    appliance: r.appliance_label,
    totalPaise: r.total_paise,
    spareCostPaise: r.spare_cost_paise,
    grossProfitPaise: r.total_paise - r.spare_cost_paise,
    paymentMode: r.payment_mode,
    selfIssued: r.self_issued_flag,
    edited: r.edited_flag,
    negativeMargin: r.negative_margin_flag,
    voidRequestPending: r.void_request_pending,
    warrantyForNumber: r.warranty_for_number,
  };
}

export interface ListFilters {
  state?: InvoiceState;
  q?: string;
  /** Invoice (service) date range, IST calendar dates "YYYY-MM-DD", inclusive. */
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** Server-side paginated list, newest first (keyset pagination on submitted_at, id). */
export async function listInvoices(
  pool: pg.Pool,
  filters: ListFilters,
): Promise<{ items: InvoiceRow[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.state) add('i.state = ?', filters.state);
  if (filters.from) add('i.invoice_date >= ?::date', filters.from);
  if (filters.to) add('i.invoice_date <= ?::date', filters.to);
  const q = filters.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    if (/^(inv-?)?\s*\d{1,7}$/i.test(q)) {
      // "48213" or "INV-48213": an invoice number, or the tail of a phone number.
      params.push(Number(digits), digits);
      where.push(`(i.invoice_number = $${params.length - 1} OR c.phone_e164 LIKE '%' || $${params.length})`);
    } else if (digits.length >= 4 && /^[\d\s+()-]+$/.test(q)) {
      add("c.phone_e164 LIKE '%' || ?", digits);
    } else {
      add("c.name ILIKE '%' || ? || '%'", q.replace(/[%_\\]/g, (m) => `\\${m}`));
    }
  }
  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    params.push(cursor.at, cursor.id);
    where.push(`(i.submitted_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(filters.limit + 1);
  const res = await pool.query<RowData>(
    `${ROW_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY i.submitted_at DESC, i.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.slice(0, filters.limit);
  const last = rows[rows.length - 1];
  const nextCursor =
    res.rows.length > filters.limit && last
      ? Buffer.from(`${last.submitted_at.toISOString()}|${last.id}`).toString('base64url')
      : null;
  return { items: rows.map(toRow), nextCursor };
}

export async function getInvoice(pool: pg.Pool, invoiceId: string): Promise<InvoiceDetail | null> {
  const res = await pool.query<
    RowData & {
      service_description: string;
      brand_name: string | null;
      rendered_message: string | null;
      issued_by_name: string | null;
      issued_at: Date | null;
      rejected_reason: string | null;
      void_reason: string | null;
      warranty_expires_at: string;
    }
  >(
    `SELECT r.*, j.service_description, b.name AS brand_name, i.rendered_message,
            iu.display_name AS issued_by_name, i.issued_at, i.rejected_reason, i.void_reason,
            coalesce(cover.warranty_expires_at, i.warranty_expires_at) AS warranty_expires_at
     FROM (${ROW_SELECT} WHERE i.id = $1) r
     JOIN invoices i ON i.id = r.id
     LEFT JOIN invoices cover ON cover.id = i.warranty_of_invoice_id
     JOIN jobs j ON j.id = i.job_id
     LEFT JOIN brands b ON b.id = j.brand_id
     LEFT JOIN users iu ON iu.id = i.issued_by`,
    [invoiceId],
  );
  const r = res.rows[0];
  if (!r) return null;
  const history = await pool.query<{ at: Date; action: string; actor_name: string | null; reason: string | null }>(
    `SELECT at, action, actor_name, reason FROM (
       SELECT a.occurred_at AS at, a.action, u.display_name AS actor_name, a.reason
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.entity_type = 'invoice' AND a.entity_id = $1
       UNION ALL
       SELECT m.created_at, 'message.' || m.action::text, u.display_name, NULL
       FROM message_log m LEFT JOIN users u ON u.id = m.actor_id
       WHERE m.invoice_id = $2 AND m.action <> 'issue'
     ) h ORDER BY at`,
    [invoiceId, invoiceId],
  );
  return {
    ...toRow(r),
    serviceDescription: r.service_description,
    brand: r.brand_name,
    message: r.rendered_message,
    issuedByName: r.issued_by_name,
    issuedAt: r.issued_at?.toISOString() ?? null,
    rejectedReason: r.rejected_reason,
    voidReason: r.void_reason,
    warrantyExpiresAt: r.warranty_expires_at,
    history: history.rows.map((h) => ({
      at: h.at.toISOString(),
      action: h.action,
      actorName: h.actor_name,
      reason: h.reason,
    })),
  };
}

// ------------------------------------------------------------------ Issue & Copy (own jobs)

export type IssueOwnResult =
  | { ok: true; created: boolean; invoiceId: string; invoiceNumber: number; message: string; customerName: string; phone: string }
  | { ok: false; error: 'not_issuable' };

/**
 * Master / Admin Technician's own job: submit AND issue in ONE transaction, skipping the queue.
 * The invoice is flagged self-issued for the Master's analytics. Idempotent on the key.
 */
export async function issueOwn(pool: pg.Pool, actor: Actor, input: SubmissionInput): Promise<IssueOwnResult> {
  const run = () =>
    withTransaction(pool, async (client) => {
      const submission = await insertSubmission(client, actor, input);
      const issued = await issueWithClient(client, actor, submission.invoiceId);
      if (issued.kind !== 'issued' && issued.kind !== 'already_issued') return { ok: false as const, error: 'not_issuable' as const };
      return {
        ok: true as const,
        created: submission.created,
        invoiceId: submission.invoiceId,
        invoiceNumber: issued.invoiceNumber,
        message: issued.message,
        customerName: input.customerName,
        phone: input.phone,
      };
    });
  try {
    return await run();
  } catch (err) {
    // A concurrent retry with the same key committed first: return that invoice.
    if (isDuplicateSubmission(err)) return run();
    throw err;
  }
}

// ------------------------------------------------------------------ void

export type VoidResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'wrong_state' | 'already_requested' };

async function voidWithClient(
  client: pg.PoolClient,
  actor: Actor,
  invoiceId: string,
  reason: string,
): Promise<VoidResult> {
  const locked = await client.query<{ state: string; job_id: string }>(
    'SELECT state, job_id FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId],
  );
  const inv = locked.rows[0];
  if (!inv) return { ok: false, error: 'not_found' };
  if (inv.state !== 'issued') return { ok: false, error: 'wrong_state' };
  await client.query(
    `UPDATE invoices SET state = 'void', void_reason = $2, voided_by = $3, voided_at = now(),
            requeued_at = NULL, requeued_by = NULL
     WHERE id = $1`,
    [invoiceId, reason, actor.id],
  );
  // A voided job drops out of warranty and reminder views; the correction is re-entered.
  await client.query("UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE id = $1", [inv.job_id]);
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, reason, ip)
     VALUES ($1, 'invoice.voided', 'invoice', $2, $3, $4, $5, $6)`,
    [actor.id, invoiceId, JSON.stringify({ state: 'issued' }), JSON.stringify({ state: 'void' }), reason, actor.ip ?? null],
  );
  return { ok: true };
}

/** Master: void directly (any pending void request for it is marked approved). */
export async function voidInvoice(pool: pg.Pool, actor: Actor, invoiceId: string, reason: string): Promise<VoidResult> {
  return withTransaction(pool, async (client) => {
    const result = await voidWithClient(client, actor, invoiceId, reason);
    if (result.ok) {
      await client.query(
        `UPDATE void_requests SET status = 'approved', decided_by = $2, decided_at = now(),
                decision_note = 'Voided directly by Master'
         WHERE invoice_id = $1 AND status = 'pending'`,
        [invoiceId, actor.id],
      );
    }
    return result;
  });
}

/** Admin Technician: ask the Master to void an issued invoice. */
export async function requestVoid(pool: pg.Pool, actor: Actor, invoiceId: string, reason: string): Promise<VoidResult> {
  try {
    return await withTransaction(pool, async (client) => {
      const inv = await client.query<{ state: string }>('SELECT state FROM invoices WHERE id = $1', [invoiceId]);
      if (!inv.rows[0]) return { ok: false, error: 'not_found' };
      if (inv.rows[0].state !== 'issued') return { ok: false, error: 'wrong_state' };
      const req = await client.query<{ id: string }>(
        'INSERT INTO void_requests (invoice_id, requested_by, reason) VALUES ($1, $2, $3) RETURNING id',
        [invoiceId, actor.id, reason],
      );
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, new_values, reason, ip)
         VALUES ($1, 'invoice.void_requested', 'invoice', $2, $3, $4, $5)`,
        [actor.id, invoiceId, JSON.stringify({ void_request_id: req.rows[0]!.id }), reason, actor.ip ?? null],
      );
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'void_requests_one_pending_uq')) return { ok: false, error: 'already_requested' };
    throw err;
  }
}

export async function listVoidRequests(
  pool: pg.Pool,
  status: 'pending' | 'approved' | 'rejected',
): Promise<VoidRequestRow[]> {
  const res = await pool.query<{
    id: string;
    invoice_id: string;
    invoice_number: number;
    customer_name: string;
    total_paise: number;
    reason: string;
    requested_by_name: string;
    created_at: Date;
    status: 'pending' | 'approved' | 'rejected';
  }>(
    `SELECT vr.id, vr.invoice_id, i.invoice_number, c.name AS customer_name, i.total_paise, vr.reason,
            u.display_name AS requested_by_name, vr.created_at, vr.status
     FROM void_requests vr
     JOIN invoices i ON i.id = vr.invoice_id
     JOIN jobs j ON j.id = i.job_id
     JOIN customers c ON c.id = j.customer_id
     JOIN users u ON u.id = vr.requested_by
     WHERE vr.status = $1
     ORDER BY vr.created_at ${status === 'pending' ? 'ASC' : 'DESC'}
     LIMIT 200`,
    [status],
  );
  return res.rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    customerName: r.customer_name,
    totalPaise: r.total_paise,
    reason: r.reason,
    requestedByName: r.requested_by_name,
    createdAt: r.created_at.toISOString(),
    status: r.status,
  }));
}

/** Master approves (voids the invoice) or refuses a pending void request. */
export async function decideVoidRequest(
  pool: pg.Pool,
  actor: Actor,
  requestId: string,
  approve: boolean,
  note: string | null,
): Promise<VoidResult> {
  return withTransaction(pool, async (client) => {
    const req = await client.query<{ invoice_id: string; reason: string; status: string }>(
      'SELECT invoice_id, reason, status FROM void_requests WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const row = req.rows[0];
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'pending') return { ok: false, error: 'wrong_state' };
    if (approve) {
      const voided = await voidWithClient(client, actor, row.invoice_id, row.reason);
      if (!voided.ok) return voided;
    }
    await client.query(
      `UPDATE void_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
      [requestId, approve ? 'approved' : 'rejected', actor.id, note],
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, new_values, reason, ip)
       VALUES ($1, $2, 'void_request', $3, $4, $5, $6)`,
      [
        actor.id,
        approve ? 'void_request.approved' : 'void_request.rejected',
        requestId,
        JSON.stringify({ invoice_id: row.invoice_id }),
        note,
        actor.ip ?? null,
      ],
    );
    return { ok: true };
  });
}

export { findByIdempotencyKey };
