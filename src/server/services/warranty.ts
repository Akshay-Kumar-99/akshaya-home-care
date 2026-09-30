import type pg from 'pg';
import type { CustomerVisit, WarrantyCover } from '../../shared/api-types.ts';

// Warranty service (owner, 30 Sep 2026). Every invoice carries a 90-day warranty on our service
// (labour, not parts). When a phone with a live warranty calls again, the form offers
// "Warranty service": the new invoice links to the covering one, may be free (₹0) or carry a
// visit charge, and does not start a new warranty (drizzle/0008_warranty_service.sql).
//
// These reads run as the app's owner role, not the technician's row-level-security role:
// a technician needs the covering invoice even if a colleague did the original job. The DTOs
// carry no amounts, profit or customer message.

type Queryable = pg.Pool | pg.PoolClient;

/** Thrown when a submission links to an invoice that does not cover this phone (any more). */
export class InvalidWarranty extends Error {}

export const INVALID_WARRANTY_ISSUE = {
  path: 'warrantyOfInvoiceId',
  message: 'That warranty no longer applies to this customer. Untick Warranty service and save again.',
};

/** Issued invoices for this phone whose service warranty is still running, latest first. */
export async function liveWarranties(db: Queryable, phoneE164: string): Promise<WarrantyCover[]> {
  const res = await db.query<{
    id: string;
    invoice_number: number;
    invoice_date: string;
    warranty_expires_at: string;
    appliance_type_key: string;
    appliance: string;
    brand_id: string | null;
    brand: string | null;
    area_id: string | null;
    area: string | null;
    service_description: string;
  }>(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.warranty_expires_at, j.appliance_type_key,
            apt.label AS appliance, j.brand_id, b.name AS brand, j.area_id, a.name AS area,
            j.service_description
     FROM invoices i
     JOIN jobs j ON j.id = i.job_id
     JOIN customers c ON c.id = j.customer_id
     JOIN appliance_types apt ON apt.key = j.appliance_type_key
     LEFT JOIN brands b ON b.id = j.brand_id
     LEFT JOIN areas a ON a.id = j.area_id
     WHERE c.phone_e164 = $1
       AND i.state = 'issued'
       AND i.warranty_of_invoice_id IS NULL
       AND i.warranty_expires_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY i.invoice_date DESC, i.issued_at DESC
     LIMIT 5`,
    [phoneE164],
  );
  return res.rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    warrantyUntil: r.warranty_expires_at,
    applianceTypeKey: r.appliance_type_key,
    appliance: r.appliance,
    brandId: r.brand_id,
    brand: r.brand,
    areaId: r.area_id,
    area: r.area,
    serviceDescription: r.service_description,
  }));
}

/** The customer's last few visits (pending or issued), newest first. */
export async function recentVisits(db: Queryable, phoneE164: string, limit = 3): Promise<CustomerVisit[]> {
  const res = await db.query<{
    invoice_number: number | null;
    invoice_date: string;
    appliance: string;
    service_description: string;
    warranty_service: boolean;
  }>(
    `SELECT i.invoice_number, i.invoice_date, apt.label AS appliance, j.service_description,
            i.warranty_of_invoice_id IS NOT NULL AS warranty_service
     FROM invoices i
     JOIN jobs j ON j.id = i.job_id
     JOIN customers c ON c.id = j.customer_id
     JOIN appliance_types apt ON apt.key = j.appliance_type_key
     WHERE c.phone_e164 = $1 AND i.state IN ('submitted', 'issued')
     ORDER BY i.submitted_at DESC
     LIMIT $2`,
    [phoneE164, limit],
  );
  return res.rows.map((r) => ({
    invoiceNumber: r.invoice_number,
    date: r.invoice_date,
    appliance: r.appliance,
    serviceDescription: r.service_description,
    warrantyService: r.warranty_service,
  }));
}

/**
 * Checks the covering invoice inside the saving transaction. Uses the SECURITY DEFINER
 * function from 0008, so it also works in a technician's row-level-security context.
 */
export async function assertWarrantyCover(client: pg.PoolClient, invoiceId: string, phoneE164: string): Promise<void> {
  const res = await client.query<{ ok: boolean }>('SELECT ahc_warranty_cover_ok($1, $2) AS ok', [invoiceId, phoneE164]);
  if (!res.rows[0]?.ok) throw new InvalidWarranty();
}
