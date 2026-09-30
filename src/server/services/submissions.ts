import type pg from 'pg';
import { rupeesToPaise } from '../../shared/money.ts';
import type { SubmissionInput } from '../../shared/schemas.ts';
import { withActorContext } from '../db/actor-context.ts';
import { isUniqueViolation } from '../db/client.ts';
import type { Actor } from './types.ts';
import { assertWarrantyCover } from './warranty.ts';

export interface SubmissionResult {
  invoiceId: string;
  jobId: string;
  /** false when this idempotency key was already stored (a retry); nothing new was written. */
  created: boolean;
}

/** Thrown inside the transaction when a concurrent request with the same key won. */
export class DuplicateSubmission extends Error {}

export async function findByIdempotencyKey(
  client: pg.PoolClient,
  key: string,
): Promise<SubmissionResult | null> {
  const res = await client.query<{ id: string; job_id: string }>(
    'SELECT id, job_id FROM invoices WHERE idempotency_key = $1',
    [key],
  );
  const row = res.rows[0];
  return row ? { invoiceId: row.id, jobId: row.job_id, created: false } : null;
}

/**
 * Writes a completed job plus an invoice in state `submitted` (no number yet) using an
 * open transaction. Returns the existing record if the idempotency key is already stored;
 * throws DuplicateSubmission if a concurrent request with the same key committed first.
 */
export async function insertSubmission(
  client: pg.PoolClient,
  actor: Actor,
  input: SubmissionInput,
): Promise<SubmissionResult> {
  const existing = await findByIdempotencyKey(client, input.idempotencyKey);
  if (existing) return existing;

  const totalPaise = rupeesToPaise(input.totalRupees);
  const spareCostPaise = rupeesToPaise(input.spareCostRupees);
  if (input.warrantyOfInvoiceId) await assertWarrantyCover(client, input.warrantyOfInvoiceId, input.phone);

  const customer = await client.query<{ id: string }>(
    `INSERT INTO customers (phone_e164, name, area_id) VALUES ($1, $2, $3)
     ON CONFLICT (phone_e164) DO UPDATE
       SET name = EXCLUDED.name,
           area_id = coalesce(EXCLUDED.area_id, customers.area_id),
           updated_at = now()
     RETURNING id`,
    [input.phone, input.customerName, input.areaId],
  );
  const customerId = customer.rows[0]!.id;

  const job = await client.query<{ id: string }>(
    `INSERT INTO jobs (customer_id, appliance_type_key, brand_id, area_id, service_description,
                       status, completed_at, source, created_by)
     VALUES ($1, $2, $3, $4, $5, 'completed', now(), 'app', $6)
     RETURNING id`,
    [customerId, input.applianceTypeKey, input.brandId, input.areaId, input.serviceDescription, actor.id],
  );
  const jobId = job.rows[0]!.id;

  // If a concurrent request with the same key committed first, this waits for it and
  // then inserts nothing; the caller's transaction is rolled back.
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

  // A free warranty service has nothing to pay.
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
        total_paise: totalPaise,
        spare_cost_paise: spareCostPaise,
        payment: input.payment,
        warranty_of_invoice_id: input.warrantyOfInvoiceId,
      }),
      actor.ip ?? null,
    ],
  );

  return { invoiceId, jobId, created: true };
}

export function isDuplicateSubmission(err: unknown): boolean {
  return err instanceof DuplicateSubmission || isUniqueViolation(err, 'invoices_idempotency_key_unique');
}

/**
 * Stores a completed job plus an invoice in state `submitted` (no number yet).
 * Idempotent on `input.idempotencyKey`: offline retries, double taps and concurrent
 * duplicates all resolve to the single record created first.
 * Runs in the actor's DB context, so a technician's writes are also checked by row-level security.
 * Authorization (who may submit) is enforced by the route layer.
 */
export async function createSubmission(
  pool: pg.Pool,
  actor: Actor,
  input: SubmissionInput,
): Promise<SubmissionResult> {
  try {
    return await withActorContext(pool, actor, (client) => insertSubmission(client, actor, input));
  } catch (err) {
    if (isDuplicateSubmission(err)) {
      const winner = await withActorContext(pool, actor, (client) =>
        findByIdempotencyKey(client, input.idempotencyKey),
      );
      if (winner) return winner;
    }
    throw err;
  }
}
