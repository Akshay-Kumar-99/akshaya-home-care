import type pg from 'pg';
import type { PaymentMode } from '../../shared/api-types.ts';
import { INVOICE_TEMPLATE_VERSION, renderInvoiceMessage } from '../../shared/invoice-template.ts';
import { withTransaction } from '../db/client.ts';
import type { Actor } from './types.ts';

export type IssueResult =
  | { kind: 'issued'; invoiceId: string; invoiceNumber: number; message: string; selfIssued: boolean }
  | {
      kind: 'already_issued';
      invoiceId: string;
      invoiceNumber: number;
      message: string;
      issuedByName: string;
      issuedAt: Date;
    }
  | { kind: 'not_issuable'; invoiceId: string; state: 'void' | 'rejected' }
  | { kind: 'not_found' };

interface LockedInvoice {
  id: string;
  state: 'submitted' | 'issued' | 'void' | 'rejected';
  invoice_number: number | null;
  rendered_message: string | null;
  invoice_date: string;
  total_paise: number;
  submitted_by: string;
  issued_at: Date | null;
  issued_by_name: string | null;
  customer_name: string;
  appliance_label: string;
  service_description: string;
  payment_mode: PaymentMode | null;
  warranty_until: string;
  warranty_for_number: number | null;
}

/**
 * Everything the customer message needs, for one invoice. A warranty service shows the
 * covering invoice's number and warranty end date. Shared with the Work Inv preview.
 */
export const MESSAGE_FIELDS = `
  c.name AS customer_name, apt.label AS appliance_label, j.service_description,
  (SELECT p.mode FROM payments p WHERE p.invoice_id = i.id ORDER BY p.received_at LIMIT 1) AS payment_mode,
  coalesce(cover.warranty_expires_at, i.warranty_expires_at) AS warranty_until,
  cover.invoice_number AS warranty_for_number`;

export const MESSAGE_JOINS = `
  JOIN jobs j ON j.id = i.job_id
  JOIN customers c ON c.id = j.customer_id
  JOIN appliance_types apt ON apt.key = j.appliance_type_key
  LEFT JOIN invoices cover ON cover.id = i.warranty_of_invoice_id`;

/** Official phone and Terms & Conditions link, read in the issuing transaction. */
export async function businessSettings(client: pg.PoolClient | pg.Pool): Promise<{ officialPhoneE164: string; termsUrl: string | null }> {
  const res = await client.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM settings WHERE key IN ('official_phone', 'terms_url')",
  );
  const values = new Map(res.rows.map((r) => [r.key, r.value]));
  const officialPhoneE164 = values.get('official_phone');
  if (typeof officialPhoneE164 !== 'string') throw new Error('settings.official_phone is missing');
  const terms = values.get('terms_url');
  return { officialPhoneE164, termsUrl: typeof terms === 'string' && terms ? terms : null };
}

/**
 * Issues an invoice: the checker's first "Copy", or an admin's "Issue & Copy" on their own job.
 *
 * One transaction:
 *   1. lock the invoice row (FOR UPDATE) so concurrent copies of the same item serialise;
 *   2. if it is already issued, return the stored snapshot, and no second number is drawn;
 *   3. otherwise advance the single-row counter (its row lock serialises all issuers);
 *   4. render the one template, freeze it on the invoice, and log the issue.
 * A rollback anywhere also rolls back the counter, so the sequence stays gapless.
 * Authorization is enforced by the route layer.
 */
export async function issueInvoice(pool: pg.Pool, actor: Actor, invoiceId: string): Promise<IssueResult> {
  return withTransaction(pool, (client) => issueWithClient(client, actor, invoiceId));
}

/** The issue steps inside an open transaction (also used by "Issue & Copy" in one transaction). */
export async function issueWithClient(
  client: pg.PoolClient,
  actor: Actor,
  invoiceId: string,
): Promise<IssueResult> {
  // Lock first, then read. Under READ COMMITTED, a SELECT … FOR UPDATE that had to wait
  // re-checks only the locked row; joined rows (e.g. the issuer's name) would come from
  // the stale snapshot. A separate statement after the lock sees the committed state.
  const lock = await client.query('SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  if (lock.rowCount === 0) return { kind: 'not_found' };

  const current = await client.query<LockedInvoice>(
    `SELECT i.id, i.state, i.invoice_number, i.rendered_message, i.invoice_date, i.total_paise,
            i.submitted_by, i.issued_at, u.display_name AS issued_by_name, ${MESSAGE_FIELDS}
     FROM invoices i
     ${MESSAGE_JOINS}
     LEFT JOIN users u ON u.id = i.issued_by
     WHERE i.id = $1`,
    [invoiceId],
  );
  const inv = current.rows[0];
  if (!inv) return { kind: 'not_found' };

  if (inv.state === 'issued') {
    return {
      kind: 'already_issued',
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number!,
      message: inv.rendered_message!,
      issuedByName: inv.issued_by_name ?? 'another user',
      issuedAt: inv.issued_at!,
    };
  }
  if (inv.state !== 'submitted') {
    return { kind: 'not_issuable', invoiceId: inv.id, state: inv.state };
  }

  const business = await businessSettings(client);

  const counter = await client.query<{ n: number }>(
    'UPDATE invoice_counter SET next_value = next_value + 1 WHERE id = 1 RETURNING next_value - 1 AS n',
  );
  const invoiceNumber = counter.rows[0]?.n;
  if (invoiceNumber === undefined) throw new Error('invoice_counter is not seeded');

  const message = renderInvoiceMessage({
    customerName: inv.customer_name,
    invoiceNumber,
    invoiceDate: inv.invoice_date,
    totalPaise: inv.total_paise,
    officialPhoneE164: business.officialPhoneE164,
    applianceLabel: inv.appliance_label,
    serviceDescription: inv.service_description,
    paymentMode: inv.payment_mode,
    warrantyUntil: inv.warranty_until,
    warrantyForInvoiceNumber: inv.warranty_for_number,
    termsUrl: business.termsUrl,
  });
  const selfIssued = inv.submitted_by === actor.id;

  // One round trip for the update and both log rows keeps the counter lock short.
  await client.query(
    `WITH upd AS (
       UPDATE invoices
          SET state = 'issued', invoice_number = $2, template_version = $3, rendered_message = $4,
              issued_by = $5, issued_at = now(), copy_count = 1, last_copied_by = $5,
              last_copied_at = now(), self_issued_flag = $6
        WHERE id = $1
        RETURNING id
     ), msg AS (
       INSERT INTO message_log (invoice_id, action, actor_id) SELECT id, 'issue', $5 FROM upd
     )
     INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, ip)
     SELECT $5, 'invoice.issued', 'invoice', id, $7, $8, $9 FROM upd`,
    [
      inv.id,
      invoiceNumber,
      INVOICE_TEMPLATE_VERSION,
      message,
      actor.id,
      selfIssued,
      JSON.stringify({ state: 'submitted' }),
      JSON.stringify({ state: 'issued', invoice_number: invoiceNumber, self_issued: selfIssued }),
      actor.ip ?? null,
    ],
  );

  return { kind: 'issued', invoiceId: inv.id, invoiceNumber, message, selfIssued };
}
