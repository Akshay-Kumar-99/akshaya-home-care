import type pg from 'pg';
import type { CopyResponse, PaymentMode, QueueCard } from '../../shared/api-types.ts';
import { renderInvoiceMessage } from '../../shared/invoice-template.ts';
import { rupeesToPaise } from '../../shared/money.ts';
import type { EditPendingInput } from '../../shared/schemas.ts';
import { withTransaction } from '../db/client.ts';
import { issueWithClient } from './issue.ts';

/** What every customer message prints besides the invoice itself (from settings). */
export interface Business {
  officialPhoneE164: string;
  termsUrl: string | null;
}
import type { Actor } from './types.ts';

// Technician Work Inv: the checkers' queue. Routes require `workinv.use` (and `invoice.reject`
// / `invoice.edit_pending` for those actions). The database is the source of truth; nothing is
// ever deleted. "Cleared" items move to "Recently copied" (48 h).

interface CardRow {
  id: string;
  state: 'submitted' | 'issued';
  requeued_at: Date | null;
  invoice_number: number | null;
  invoice_date: string;
  submitted_at: Date;
  technician_name: string;
  customer_name: string;
  phone_e164: string;
  area_id: string | null;
  area_name: string | null;
  appliance_type_key: string;
  appliance_label: string;
  brand_id: string | null;
  brand_name: string | null;
  service_description: string;
  total_paise: number;
  spare_cost_paise: number;
  payment_mode: PaymentMode | null;
  negative_margin_flag: boolean;
  edited_flag: boolean;
  possible_duplicate: boolean;
  rendered_message: string | null;
  warranty_until: string;
  warranty_for_number: number | null;
  copied_by_name: string | null;
  last_copied_at: Date | null;
  copy_count: number;
}

const CARD_SELECT = `
  SELECT i.id, i.state, i.requeued_at, i.invoice_number, i.invoice_date, i.submitted_at,
         sub.display_name AS technician_name,
         c.name AS customer_name, c.phone_e164,
         j.area_id, a.name AS area_name,
         j.appliance_type_key, apt.label AS appliance_label,
         j.brand_id, b.name AS brand_name, j.service_description,
         i.total_paise, i.spare_cost_paise, pay.mode AS payment_mode,
         i.negative_margin_flag, i.edited_flag, i.rendered_message,
         coalesce(cover.warranty_expires_at, i.warranty_expires_at) AS warranty_until,
         cover.invoice_number AS warranty_for_number,
         lc.display_name AS copied_by_name, i.last_copied_at, i.copy_count,
         EXISTS (
           SELECT 1 FROM invoices i2 JOIN jobs j2 ON j2.id = i2.job_id
           WHERE j2.customer_id = j.customer_id AND i2.id <> i.id
             AND i2.total_paise = i.total_paise
             AND i2.state NOT IN ('rejected', 'void')
             AND i2.submitted_at BETWEEN i.submitted_at - interval '24 hours' AND i.submitted_at + interval '24 hours'
         ) AS possible_duplicate
  FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  JOIN customers c ON c.id = j.customer_id
  JOIN users sub ON sub.id = i.submitted_by
  JOIN appliance_types apt ON apt.key = j.appliance_type_key
  LEFT JOIN areas a ON a.id = j.area_id
  LEFT JOIN brands b ON b.id = j.brand_id
  LEFT JOIN users lc ON lc.id = i.last_copied_by
  LEFT JOIN invoices cover ON cover.id = i.warranty_of_invoice_id
  LEFT JOIN LATERAL (
    SELECT mode FROM payments WHERE invoice_id = i.id ORDER BY received_at LIMIT 1
  ) pay ON true`;

function toCard(row: CardRow, business: Business): QueueCard {
  const preview =
    row.rendered_message ??
    renderInvoiceMessage({
      customerName: row.customer_name,
      invoiceNumber: null,
      invoiceDate: row.invoice_date,
      totalPaise: row.total_paise,
      officialPhoneE164: business.officialPhoneE164,
      applianceLabel: row.appliance_label,
      serviceDescription: row.service_description,
      paymentMode: row.payment_mode,
      warrantyUntil: row.warranty_until,
      warrantyForInvoiceNumber: row.warranty_for_number,
      termsUrl: business.termsUrl,
    });
  return {
    id: row.id,
    state: row.state,
    requeued: row.requeued_at !== null,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    submittedAt: row.submitted_at.toISOString(),
    technicianName: row.technician_name,
    customerName: row.customer_name,
    phone: row.phone_e164,
    areaId: row.area_id,
    area: row.area_name,
    applianceTypeKey: row.appliance_type_key,
    appliance: row.appliance_label,
    brandId: row.brand_id,
    brand: row.brand_name,
    serviceDescription: row.service_description,
    totalPaise: row.total_paise,
    spareCostPaise: row.spare_cost_paise,
    paymentMode: row.payment_mode,
    negativeMargin: row.negative_margin_flag,
    edited: row.edited_flag,
    possibleDuplicate: row.possible_duplicate,
    warrantyForNumber: row.warranty_for_number,
    preview,
    copiedByName: row.copied_by_name,
    copiedAt: row.last_copied_at?.toISOString() ?? null,
    copyCount: row.copy_count,
  };
}

/** Pending: submitted items plus issued items put back in the queue. Oldest first. */
export async function listPending(pool: pg.Pool, business: Business): Promise<QueueCard[]> {
  const res = await pool.query<CardRow>(
    `${CARD_SELECT}
     WHERE i.state = 'submitted' OR (i.state = 'issued' AND i.requeued_at IS NOT NULL)
     ORDER BY i.submitted_at ASC
     LIMIT 200`,
  );
  return res.rows.map((r) => toCard(r, business));
}

/** Recently copied: issued and copied in the last 48 hours, not put back. Newest first. */
export async function listRecent(pool: pg.Pool, business: Business): Promise<QueueCard[]> {
  const res = await pool.query<CardRow>(
    `${CARD_SELECT}
     WHERE i.state = 'issued' AND i.requeued_at IS NULL
       AND i.last_copied_at > now() - interval '48 hours'
     ORDER BY i.last_copied_at DESC
     LIMIT 200`,
  );
  return res.rows.map((r) => toCard(r, business));
}

export type CopyResult =
  | ({ ok: true } & CopyResponse)
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'already_copied'; by: string; at: string }
  | { ok: false; error: 'not_copyable'; state: string };

async function customerOf(client: pg.PoolClient, invoiceId: string): Promise<{ name: string; phone: string }> {
  const res = await client.query<{ name: string; phone_e164: string }>(
    `SELECT c.name, c.phone_e164 FROM invoices i JOIN jobs j ON j.id = i.job_id
     JOIN customers c ON c.id = j.customer_id WHERE i.id = $1`,
    [invoiceId],
  );
  const row = res.rows[0]!;
  return { name: row.name, phone: row.phone_e164 };
}

/**
 * "Copy message". `expect` is the state the checker's card showed:
 *  - "submitted": first copy → issue (number assigned). If someone else issued it meanwhile,
 *    the second checker gets "Already copied by X at T" and no number is drawn.
 *  - "issued": Copy again / requeued item → return the frozen message, log a re-copy.
 */
export async function copyMessage(
  pool: pg.Pool,
  actor: Actor,
  invoiceId: string,
  expect: 'submitted' | 'issued',
): Promise<CopyResult> {
  return withTransaction(pool, async (client) => {
    if (expect === 'submitted') {
      const result = await issueWithClient(client, actor, invoiceId);
      if (result.kind === 'not_found') return { ok: false, error: 'not_found' };
      if (result.kind === 'not_issuable') return { ok: false, error: 'not_copyable', state: result.state };
      if (result.kind === 'already_issued') {
        return { ok: false, error: 'already_copied', by: result.issuedByName, at: result.issuedAt.toISOString() };
      }
      const customer = await customerOf(client, invoiceId);
      return {
        ok: true,
        outcome: 'issued',
        invoiceNumber: result.invoiceNumber,
        message: result.message,
        customerName: customer.name,
        phone: customer.phone,
      };
    }

    const locked = await client.query<{ state: string; invoice_number: number | null; rendered_message: string | null }>(
      'SELECT state, invoice_number, rendered_message FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    );
    const inv = locked.rows[0];
    if (!inv) return { ok: false, error: 'not_found' };
    if (inv.state !== 'issued') return { ok: false, error: 'not_copyable', state: inv.state };

    await client.query(
      `WITH upd AS (
         UPDATE invoices SET copy_count = copy_count + 1, last_copied_by = $2, last_copied_at = now(),
                requeued_at = NULL, requeued_by = NULL
          WHERE id = $1 RETURNING id
       )
       INSERT INTO message_log (invoice_id, action, actor_id) SELECT id, 'recopy', $2 FROM upd`,
      [invoiceId, actor.id],
    );
    const customer = await customerOf(client, invoiceId);
    return {
      ok: true,
      outcome: 'recopied',
      invoiceNumber: inv.invoice_number!,
      message: inv.rendered_message!,
      customerName: customer.name,
      phone: customer.phone,
    };
  });
}

export type SimpleResult = { ok: true } | { ok: false; error: 'not_found' | 'wrong_state' };

/** "Put back in queue": an issued item returns to Pending (it keeps its number and message). */
export async function requeue(pool: pg.Pool, actor: Actor, invoiceId: string): Promise<SimpleResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ state: string; requeued_at: Date | null }>(
      'SELECT state, requeued_at FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    );
    const inv = locked.rows[0];
    if (!inv) return { ok: false, error: 'not_found' };
    if (inv.state !== 'issued' || inv.requeued_at) return { ok: false, error: 'wrong_state' };
    await client.query(
      `WITH upd AS (
         UPDATE invoices SET requeued_at = now(), requeued_by = $2 WHERE id = $1 RETURNING id
       )
       INSERT INTO message_log (invoice_id, action, actor_id) SELECT id, 'requeue', $2 FROM upd`,
      [invoiceId, actor.id],
    );
    return { ok: true };
  });
}

/**
 * Rejects a pending item with a reason the technician will see. A walk-in job is cancelled;
 * an assigned work order goes back to its technician's Works assigned list (in progress) so
 * they can correct it and complete it again. Returns that technician, if any.
 */
export async function reject(
  pool: pg.Pool,
  actor: Actor,
  invoiceId: string,
  reason: string,
): Promise<{ ok: true; returnedTo: string | null } | { ok: false; error: 'not_found' | 'wrong_state' }> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ state: string; job_id: string }>(
      'SELECT state, job_id FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    );
    const inv = locked.rows[0];
    if (!inv) return { ok: false, error: 'not_found' };
    if (inv.state !== 'submitted') return { ok: false, error: 'wrong_state' };
    await client.query(
      `UPDATE invoices SET state = 'rejected', rejected_reason = $2, rejected_by = $3, rejected_at = now()
       WHERE id = $1`,
      [invoiceId, reason, actor.id],
    );
    const job = await client.query<{ assigned_to: string | null }>(
      'SELECT assigned_to FROM jobs WHERE id = $1 FOR UPDATE',
      [inv.job_id],
    );
    const returnedTo = job.rows[0]?.assigned_to ?? null;
    if (returnedTo) {
      await client.query(
        "UPDATE jobs SET status = 'in_progress', completed_at = NULL, updated_at = now() WHERE id = $1",
        [inv.job_id],
      );
    } else {
      await client.query(
        "UPDATE jobs SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now() WHERE id = $1",
        [inv.job_id, actor.id, reason],
      );
    }
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, reason, ip)
       VALUES ($1, 'invoice.rejected', 'invoice', $2, $3, $4, $5, $6)`,
      [
        actor.id,
        invoiceId,
        JSON.stringify({ state: 'submitted' }),
        JSON.stringify({ state: 'rejected' }),
        reason,
        actor.ip ?? null,
      ],
    );
    return { ok: true, returnedTo };
  });
}

export type EditResult =
  | { ok: true; changed: string[] }
  | { ok: false; error: 'not_found' | 'wrong_state' | 'step_up_required' | 'invalid_reference' };

interface EditableRow {
  state: string;
  job_id: string;
  customer_id: string;
  customer_name: string;
  phone_e164: string;
  area_id: string | null;
  appliance_type_key: string;
  brand_id: string | null;
  service_description: string;
  total_paise: number;
  spare_cost_paise: number;
}

/**
 * Checker edit of a pending item. Every changed field is written to audit_log (old → new),
 * the item is flagged "edited by office" for the technician, and amount changes need a
 * fresh PIN (the caller passes whether step-up is fresh).
 */
export async function editPending(
  pool: pg.Pool,
  actor: Actor,
  invoiceId: string,
  input: EditPendingInput,
  stepUpFresh: boolean,
): Promise<EditResult> {
  try {
    return await withTransaction(pool, async (client) => {
      await client.query('SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      const res = await client.query<EditableRow>(
        `SELECT i.state, i.job_id, j.customer_id, c.name AS customer_name, c.phone_e164, j.area_id,
                j.appliance_type_key, j.brand_id, j.service_description, i.total_paise, i.spare_cost_paise
         FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN customers c ON c.id = j.customer_id
         WHERE i.id = $1`,
        [invoiceId],
      );
      const cur = res.rows[0];
      if (!cur) return { ok: false, error: 'not_found' };
      if (cur.state !== 'submitted') return { ok: false, error: 'wrong_state' };

      const next = {
        customer_name: input.customerName ?? cur.customer_name,
        phone_e164: input.phone ?? cur.phone_e164,
        area_id: input.areaId !== undefined ? input.areaId : cur.area_id,
        appliance_type_key: input.applianceTypeKey ?? cur.appliance_type_key,
        brand_id: input.brandId !== undefined ? input.brandId : cur.brand_id,
        service_description: input.serviceDescription ?? cur.service_description,
        total_paise: input.totalRupees !== undefined ? rupeesToPaise(input.totalRupees) : cur.total_paise,
        spare_cost_paise:
          input.spareCostRupees !== undefined ? rupeesToPaise(input.spareCostRupees) : cur.spare_cost_paise,
      };
      const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => next[k] !== cur[k]);
      if (changed.length === 0) return { ok: true, changed: [] };

      const amountsChanged = changed.includes('total_paise') || changed.includes('spare_cost_paise');
      if (amountsChanged && !stepUpFresh) return { ok: false, error: 'step_up_required' };

      let customerId = cur.customer_id;
      if (changed.includes('phone_e164')) {
        // A different phone means a different customer record.
        const upsert = await client.query<{ id: string }>(
          `INSERT INTO customers (phone_e164, name, area_id) VALUES ($1, $2, $3)
           ON CONFLICT (phone_e164) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
           RETURNING id`,
          [next.phone_e164, next.customer_name, next.area_id],
        );
        customerId = upsert.rows[0]!.id;
      } else if (changed.includes('customer_name')) {
        await client.query('UPDATE customers SET name = $2, updated_at = now() WHERE id = $1', [
          customerId,
          next.customer_name,
        ]);
      }

      await client.query(
        `UPDATE jobs SET customer_id = $2, area_id = $3, appliance_type_key = $4, brand_id = $5,
                service_description = $6, updated_at = now()
         WHERE id = $1`,
        [cur.job_id, customerId, next.area_id, next.appliance_type_key, next.brand_id, next.service_description],
      );
      await client.query(
        `UPDATE invoices SET total_paise = $2, spare_cost_paise = $3, negative_margin_flag = $4, edited_flag = true
         WHERE id = $1`,
        [invoiceId, next.total_paise, next.spare_cost_paise, next.spare_cost_paise > next.total_paise],
      );

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const key of changed) {
        oldValues[key] = cur[key];
        newValues[key] = next[key];
      }
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, ip)
         VALUES ($1, 'invoice.edited', 'invoice', $2, $3, $4, $5)`,
        [actor.id, invoiceId, JSON.stringify(oldValues), JSON.stringify(newValues), actor.ip ?? null],
      );
      return { ok: true, changed };
    });
  } catch (err) {
    // Unknown appliance type / brand / area id (foreign key violation).
    if ((err as { code?: string }).code === '23503') return { ok: false, error: 'invalid_reference' };
    throw err;
  }
}
