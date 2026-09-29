import type pg from 'pg';
import type {
  AnalyticsKpis,
  AnalyticsOverview,
  CustomerHistory,
  Granularity,
  InvoiceState,
} from '../../shared/api-types.ts';
import type { RoleKey } from '../../shared/constants.ts';

// Master analytics. Rules:
//  - "Sales" = issued invoices whose invoice date (IST service date) is in the range.
//    Void and rejected invoices never count; submitted-but-not-issued jobs are shown
//    separately as the pipeline.
//  - "Expense" = spare cost on those invoices: the only cost the app records today.
//  - Customers are identified by their unique phone number.
// All aggregation happens in Postgres; money stays integer paise end to end.

const ISSUED_IN_RANGE = `i.state = 'issued' AND i.invoice_date BETWEEN $1::date AND $2::date`;
const SUBMITTED_IN_RANGE = `(i.submitted_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`;

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The equally long period immediately before [from, to]. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = daysBetween(from, to);
  return { from: shiftDate(from, -days), to: shiftDate(from, -1) };
}

export function granularityFor(days: number): Granularity {
  if (days <= 35) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

async function kpis(pool: pg.Pool, from: string, to: string): Promise<AnalyticsKpis> {
  const res = await pool.query<{
    invoices: number;
    revenue: number;
    expense: number;
    customers: number;
    returning: number;
    outstanding: number;
    pending_count: number;
    pending: number;
  }>(
    `WITH inv AS (
       SELECT i.id, i.total_paise, i.spare_cost_paise, j.customer_id
       FROM invoices i JOIN jobs j ON j.id = i.job_id
       WHERE ${ISSUED_IN_RANGE}
     ), paid AS (
       SELECT p.invoice_id, sum(p.amount_paise) AS paid
       FROM payments p JOIN inv ON inv.id = p.invoice_id
       GROUP BY p.invoice_id
     ), cust AS (
       SELECT customer_id, count(*) AS n FROM inv GROUP BY customer_id
     ), returning_customers AS (
       SELECT c.customer_id FROM cust c
       WHERE c.n > 1 OR EXISTS (
         SELECT 1 FROM invoices i2 JOIN jobs j2 ON j2.id = i2.job_id
         WHERE j2.customer_id = c.customer_id AND i2.state = 'issued' AND i2.invoice_date < $1::date
       )
     )
     SELECT
       (SELECT count(*)::int FROM inv) AS invoices,
       (SELECT coalesce(sum(total_paise), 0)::bigint FROM inv) AS revenue,
       (SELECT coalesce(sum(spare_cost_paise), 0)::bigint FROM inv) AS expense,
       (SELECT count(*)::int FROM cust) AS customers,
       (SELECT count(*)::int FROM returning_customers) AS returning,
       (SELECT coalesce(sum(inv.total_paise - coalesce(paid.paid, 0)), 0)::bigint
          FROM inv LEFT JOIN paid ON paid.invoice_id = inv.id) AS outstanding,
       (SELECT count(*)::int FROM invoices
          WHERE state = 'submitted' AND invoice_date BETWEEN $1::date AND $2::date) AS pending_count,
       (SELECT coalesce(sum(total_paise), 0)::bigint FROM invoices
          WHERE state = 'submitted' AND invoice_date BETWEEN $1::date AND $2::date) AS pending`,
    [from, to],
  );
  const r = res.rows[0]!;
  const gross = r.revenue - r.expense;
  return {
    revenuePaise: r.revenue,
    expensePaise: r.expense,
    grossProfitPaise: gross,
    marginPct: pct(gross, r.revenue),
    invoices: r.invoices,
    avgTicketPaise: r.invoices > 0 ? Math.round(r.revenue / r.invoices) : null,
    customers: r.customers,
    repeatCustomerPct: pct(r.returning, r.customers),
    outstandingPaise: r.outstanding,
    pendingCount: r.pending_count,
    pendingPaise: r.pending,
  };
}

export async function overview(pool: pg.Pool, from: string, to: string): Promise<AnalyticsOverview> {
  const days = daysBetween(from, to);
  const granularity = granularityFor(days);
  const prev = previousRange(from, to);
  const params = [from, to];

  const [current, previous, trend, byArea, byCustomer, byAppliance, byTechnician, payments, quality] = await Promise.all([
    kpis(pool, from, to),
    kpis(pool, prev.from, prev.to),

    pool.query<{ bucket: string; revenue: number; expense: number; invoices: number }>(
      `SELECT to_char(b, 'YYYY-MM-DD') AS bucket,
              coalesce(sum(i.total_paise), 0)::bigint AS revenue,
              coalesce(sum(i.spare_cost_paise), 0)::bigint AS expense,
              count(i.id)::int AS invoices
       FROM generate_series(date_trunc($3, $1::date::timestamp), date_trunc($3, $2::date::timestamp), ('1 ' || $3)::interval) AS b
       LEFT JOIN invoices i
         ON ${ISSUED_IN_RANGE} AND date_trunc($3, i.invoice_date::timestamp) = b
       GROUP BY b ORDER BY b`,
      [from, to, granularity],
    ),

    pool.query<{ area: string; revenue: number; invoices: number; profit: number }>(
      `SELECT coalesce(a.name, 'Area not set') AS area, sum(i.total_paise)::bigint AS revenue,
              count(*)::int AS invoices, sum(i.total_paise - i.spare_cost_paise)::bigint AS profit
       FROM invoices i JOIN jobs j ON j.id = i.job_id LEFT JOIN areas a ON a.id = j.area_id
       WHERE ${ISSUED_IN_RANGE}
       GROUP BY 1 ORDER BY revenue DESC, area LIMIT 12`,
      params,
    ),

    pool.query<{ phone: string; name: string; area: string | null; invoices: number; revenue: number; profit: number; last_date: string }>(
      `SELECT c.phone_e164 AS phone, c.name, a.name AS area, count(*)::int AS invoices,
              sum(i.total_paise)::bigint AS revenue, sum(i.total_paise - i.spare_cost_paise)::bigint AS profit,
              max(i.invoice_date) AS last_date
       FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN customers c ON c.id = j.customer_id
       LEFT JOIN areas a ON a.id = c.area_id
       WHERE ${ISSUED_IN_RANGE}
       GROUP BY c.id, c.phone_e164, c.name, a.name
       ORDER BY revenue DESC, last_date DESC LIMIT 25`,
      params,
    ),

    pool.query<{ appliance: string; revenue: number; invoices: number }>(
      `SELECT apt.label AS appliance, sum(i.total_paise)::bigint AS revenue, count(*)::int AS invoices
       FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN appliance_types apt ON apt.key = j.appliance_type_key
       WHERE ${ISSUED_IN_RANGE}
       GROUP BY apt.label, apt.sort_order ORDER BY revenue DESC`,
      params,
    ),

    pool.query<{
      name: string;
      role: RoleKey;
      invoices: number;
      revenue: number;
      profit: number;
      submitted: number;
      edited: number;
      rejected: number;
      avg_min: number | null;
    }>(
      `SELECT u.display_name AS name, u.role_key AS role,
              count(i.id) FILTER (WHERE ${ISSUED_IN_RANGE})::int AS invoices,
              coalesce(sum(i.total_paise) FILTER (WHERE ${ISSUED_IN_RANGE}), 0)::bigint AS revenue,
              coalesce(sum(i.total_paise - i.spare_cost_paise) FILTER (WHERE ${ISSUED_IN_RANGE}), 0)::bigint AS profit,
              count(i.id) FILTER (WHERE ${SUBMITTED_IN_RANGE})::int AS submitted,
              count(i.id) FILTER (WHERE ${SUBMITTED_IN_RANGE} AND i.edited_flag)::int AS edited,
              count(i.id) FILTER (WHERE ${SUBMITTED_IN_RANGE} AND i.state = 'rejected')::int AS rejected,
              (avg(extract(epoch FROM i.issued_at - i.submitted_at) / 60)
                 FILTER (WHERE ${SUBMITTED_IN_RANGE} AND i.issued_at IS NOT NULL AND NOT i.self_issued_flag))::float8 AS avg_min
       FROM users u LEFT JOIN invoices i ON i.submitted_by = u.id
       GROUP BY u.id, u.display_name, u.role_key
       HAVING count(i.id) FILTER (WHERE ${ISSUED_IN_RANGE} OR ${SUBMITTED_IN_RANGE}) > 0
       ORDER BY revenue DESC, name`,
      params,
    ),

    pool.query<{ cash: number; upi: number; other: number }>(
      `WITH inv AS (SELECT i.id FROM invoices i WHERE ${ISSUED_IN_RANGE})
       SELECT coalesce(sum(p.amount_paise) FILTER (WHERE p.mode = 'cash'), 0)::bigint AS cash,
              coalesce(sum(p.amount_paise) FILTER (WHERE p.mode = 'upi'), 0)::bigint AS upi,
              coalesce(sum(p.amount_paise) FILTER (WHERE p.mode = 'other'), 0)::bigint AS other
       FROM payments p JOIN inv ON inv.id = p.invoice_id`,
      params,
    ),

    pool.query<{
      self_issued: number;
      negative: number;
      callbacks: number;
      completed: number;
      voided: number;
      rejected: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM invoices i WHERE ${ISSUED_IN_RANGE} AND i.self_issued_flag) AS self_issued,
         (SELECT count(*)::int FROM invoices i WHERE ${ISSUED_IN_RANGE} AND i.negative_margin_flag) AS negative,
         (SELECT count(*)::int FROM warranty_callbacks_v w
            WHERE (w.completed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date) AS callbacks,
         (SELECT count(*)::int FROM jobs j
            WHERE j.status = 'completed'
              AND (j.completed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date) AS completed,
         (SELECT count(*)::int FROM invoices i
            WHERE i.state = 'void' AND (i.voided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date) AS voided,
         (SELECT count(*)::int FROM invoices i
            WHERE i.state = 'rejected' AND (i.rejected_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date) AS rejected`,
      params,
    ),
  ]);

  const p = payments.rows[0]!;
  const q = quality.rows[0]!;
  return {
    range: { from, to, days, granularity },
    previousRange: prev,
    kpis: current,
    previous,
    trend: trend.rows.map((r) => ({ bucket: r.bucket, revenuePaise: r.revenue, expensePaise: r.expense, invoices: r.invoices })),
    byArea: byArea.rows.map((r) => ({ area: r.area, revenuePaise: r.revenue, invoices: r.invoices, grossProfitPaise: r.profit })),
    byCustomer: byCustomer.rows.map((r) => ({
      phone: r.phone,
      name: r.name,
      area: r.area,
      invoices: r.invoices,
      revenuePaise: r.revenue,
      grossProfitPaise: r.profit,
      lastInvoiceDate: r.last_date,
    })),
    byAppliance: byAppliance.rows.map((r) => ({ appliance: r.appliance, revenuePaise: r.revenue, invoices: r.invoices })),
    byTechnician: byTechnician.rows.map((r) => ({
      name: r.name,
      role: r.role,
      invoices: r.invoices,
      revenuePaise: r.revenue,
      grossProfitPaise: r.profit,
      avgTicketPaise: r.invoices > 0 ? Math.round(r.revenue / r.invoices) : null,
      submitted: r.submitted,
      editedPct: pct(r.edited, r.submitted),
      rejectedPct: pct(r.rejected, r.submitted),
      avgMinutesToIssue: r.avg_min === null ? null : Math.round(r.avg_min),
    })),
    paymentMix: { cashPaise: p.cash, upiPaise: p.upi, otherPaise: p.other, unpaidPaise: current.outstandingPaise },
    quality: {
      selfIssuedPct: pct(q.self_issued, current.invoices),
      negativeMarginCount: q.negative,
      warrantyCallbacks: q.callbacks,
      warrantyCallbackPct: pct(q.callbacks, q.completed),
      voided: q.voided,
      rejected: q.rejected,
    },
  };
}

/** Everything about one customer (identified by phone): lifetime value and every invoice. */
export async function customerHistory(pool: pg.Pool, phoneE164: string): Promise<CustomerHistory | null> {
  const customer = await pool.query<{ id: string; name: string; area: string | null }>(
    `SELECT c.id, c.name, a.name AS area FROM customers c LEFT JOIN areas a ON a.id = c.area_id
     WHERE c.phone_e164 = $1`,
    [phoneE164],
  );
  const c = customer.rows[0];
  if (!c) return null;
  const invoices = await pool.query<{
    id: string;
    invoice_number: number | null;
    state: InvoiceState;
    invoice_date: string;
    appliance: string;
    service_description: string;
    total_paise: number;
    spare_cost_paise: number;
    warranty_expires_at: string;
  }>(
    `SELECT i.id, i.invoice_number, i.state, i.invoice_date, apt.label AS appliance, j.service_description,
            i.total_paise, i.spare_cost_paise, i.warranty_expires_at
     FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN appliance_types apt ON apt.key = j.appliance_type_key
     WHERE j.customer_id = $1
     ORDER BY i.invoice_date DESC, i.submitted_at DESC
     LIMIT 200`,
    [c.id],
  );
  const issued = invoices.rows.filter((r) => r.state === 'issued');
  return {
    phone: phoneE164,
    name: c.name,
    area: c.area,
    lifetimeRevenuePaise: issued.reduce((sum, r) => sum + r.total_paise, 0),
    lifetimeInvoices: issued.length,
    firstInvoiceDate: issued.length ? issued[issued.length - 1]!.invoice_date : null,
    invoices: invoices.rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      state: r.state,
      invoiceDate: r.invoice_date,
      appliance: r.appliance,
      serviceDescription: r.service_description,
      totalPaise: r.total_paise,
      spareCostPaise: r.spare_cost_paise,
      warrantyExpiresAt: r.warranty_expires_at,
    })),
  };
}
