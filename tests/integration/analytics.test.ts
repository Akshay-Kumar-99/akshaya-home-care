import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsOverview } from '../../src/shared/api-types.ts';
import { withTransaction } from '../../src/server/db/client.ts';
import { issueOwn } from '../../src/server/services/invoices.ts';
import { issueInvoice } from '../../src/server/services/issue.ts';
import { createSubmission } from '../../src/server/services/submissions.ts';
import type { Actor } from '../../src/server/services/types.ts';
import { reject } from '../../src/server/services/workinv.ts';
import { voidInvoice } from '../../src/server/services/invoices.ts';
import {
  activateAccount,
  buildTestApp,
  createTestPool,
  hasTestDatabase,
  loadActors,
  makeSubmission,
  resetDatabaseWithAccounts,
  type SeededAccount,
  type TestClient,
} from './helpers.ts';

// A fixed dataset with hand-computed answers (₹):
//   A (Adyar):     2000/500 cash · 3000/1000 unpaid          → issued today
//   B (Velachery): 1500/0 UPI today · 1200/200 cash 10 days ago (backdated) → returning customer
//   C:             999/100 → rejected (never counts)
//   D (Adyar):     4000/4500 → issued then voided (never counts)
//   E:             700 → still submitted (pipeline only)
//   F (Velachery): 2500/500 cash, Admin Technician's own job (self-issued)
// Today: revenue 9000, expense 2000, 4 invoices, 3 customers (A, B returning), outstanding 3000.
describe.skipIf(!hasTestDatabase)('master analytics (Neon test branch)', () => {
  let pool: pg.Pool;
  let master: TestClient;
  let admin: TestClient;
  let tech: TestClient;
  let today: string;
  let tenDaysAgo: string;

  beforeAll(async () => {
    pool = createTestPool();
    const accounts: SeededAccount[] = await resetDatabaseWithAccounts(pool);
    const built = buildTestApp(pool);
    const by = (n: string) => accounts.find((a) => a.displayName === n)!;
    master = await activateAccount(built.app, by('Master'), 'desktop');
    admin = await activateAccount(built.app, by('Admin Technician'));
    tech = await activateAccount(built.app, by('Technician 1'));

    const actors = await loadActors(pool);
    const tech1 = actors.technician.find((a) => a.id === by('Technician 1').id)!;
    const tech2 = actors.technician.find((a) => a.id === by('Technician 2').id)!;
    const masterActor: Actor = actors.master[0]!;
    const adminActor: Actor = actors.admin_technician[0]!;

    const dates = await pool.query<{ today: string; ago: string }>(
      "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today, ((now() AT TIME ZONE 'Asia/Kolkata')::date - 10) AS ago",
    );
    today = dates.rows[0]!.today;
    tenDaysAgo = dates.rows[0]!.ago;

    const areas = await pool.query<{ id: string; name: string }>("SELECT id, name FROM areas WHERE name IN ('Adyar', 'Velachery')");
    const area = (n: string) => areas.rows.find((a) => a.name === n)!.id;

    const submit = async (actor: Actor, o: Record<string, unknown>) =>
      (await createSubmission(pool, actor, makeSubmission(o))).invoiceId;

    // A: two issued today, one unpaid.
    await issueInvoice(pool, masterActor, await submit(tech1, { phone: '9500000001', customerName: 'Anand', areaId: area('Adyar'), totalRupees: 2000, spareCostRupees: 500, payment: { status: 'paid', mode: 'cash' } }));
    await issueInvoice(pool, masterActor, await submit(tech1, { phone: '9500000001', customerName: 'Anand', areaId: area('Adyar'), totalRupees: 3000, spareCostRupees: 1000, payment: { status: 'unpaid' } }));
    // B: one today, one backdated 10 days (Master backdate path), both issued.
    await issueInvoice(pool, masterActor, await submit(tech2, { phone: '9500000002', customerName: 'Bala', areaId: area('Velachery'), totalRupees: 1500, spareCostRupees: 0, payment: { status: 'paid', mode: 'upi' } }));
    const old = await submit(tech2, { phone: '9500000002', customerName: 'Bala', areaId: area('Velachery'), totalRupees: 1200, spareCostRupees: 200, payment: { status: 'paid', mode: 'cash' } });
    await withTransaction(pool, async (client) => {
      await client.query("SELECT set_config('ahc.allow_backdate', 'on', true)");
      await client.query("UPDATE invoices SET invoice_date = invoice_date - 10, backdate_reason = 'Entered late' WHERE id = $1", [old]);
    });
    await issueInvoice(pool, masterActor, old);
    // C: rejected. D: voided. E: pending.
    await reject(pool, adminActor, await submit(tech2, { phone: '9500000003', customerName: 'Chitra', totalRupees: 999, spareCostRupees: 100 }), 'Duplicate entry');
    const d = await submit(tech1, { phone: '9500000004', customerName: 'Devi', areaId: area('Adyar'), totalRupees: 4000, spareCostRupees: 4500, confirmNegativeMargin: true, payment: { status: 'paid', mode: 'cash' } });
    await issueInvoice(pool, masterActor, d);
    await voidInvoice(pool, masterActor, d, 'Wrong customer');
    await submit(tech1, { phone: '9500000005', customerName: 'Ezhil', totalRupees: 700, spareCostRupees: 0 });
    // F: the Admin Technician's own job, Copy invoice (self-issued).
    await issueOwn(pool, adminActor, makeSubmission({ phone: '9500000006', customerName: 'Farooq', areaId: area('Velachery'), totalRupees: 2500, spareCostRupees: 500, payment: { status: 'paid', mode: 'cash' } }));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function overview(from: string, to: string): Promise<AnalyticsOverview> {
    const res = await master.get(`/api/analytics/overview?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    return res.json;
  }

  it('totals sales, expense, profit and margin from issued invoices only', async () => {
    const o = await overview(today, today);
    expect(o.kpis).toEqual({
      revenuePaise: 900000,
      expensePaise: 200000,
      grossProfitPaise: 700000,
      marginPct: 77.8,
      invoices: 4,
      avgTicketPaise: 225000,
      customers: 3,
      repeatCustomerPct: 66.7,
      outstandingPaise: 300000,
      pendingCount: 1,
      pendingPaise: 70000,
    });
  });

  it('ranks revenue by customer (by phone) and by area', async () => {
    const o = await overview(today, today);
    expect(o.byCustomer.map((c) => [c.phone, c.revenuePaise, c.invoices])).toEqual([
      ['+919500000001', 500000, 2],
      ['+919500000006', 250000, 1],
      ['+919500000002', 150000, 1],
    ]);
    expect(o.byArea).toEqual([
      { area: 'Adyar', revenuePaise: 500000, invoices: 2, grossProfitPaise: 350000 },
      { area: 'Velachery', revenuePaise: 400000, invoices: 2, grossProfitPaise: 350000 },
    ]);
  });

  it('splits payments and reports quality flags', async () => {
    const o = await overview(today, today);
    expect(o.paymentMix).toEqual({ cashPaise: 450000, upiPaise: 150000, otherPaise: 0, unpaidPaise: 300000 });
    expect(o.quality).toMatchObject({ selfIssuedPct: 25, negativeMarginCount: 0, voided: 1, rejected: 1 });
  });

  it('attributes work to the technician who submitted it', async () => {
    const o = await overview(today, today);
    const t1 = o.byTechnician.find((t) => t.name === 'Technician 1')!;
    const t2 = o.byTechnician.find((t) => t.name === 'Technician 2')!;
    expect(t1).toMatchObject({ invoices: 2, revenuePaise: 500000, submitted: 4, rejectedPct: 0 });
    expect(t2).toMatchObject({ invoices: 1, revenuePaise: 150000, submitted: 3, rejectedPct: 33.3 });
    expect(o.byTechnician.find((t) => t.name === 'Admin Technician')).toMatchObject({ revenuePaise: 250000 });
  });

  it('builds a daily trend with zero-filled days and compares against the previous period', async () => {
    const o = await overview(tenDaysAgo, today);
    expect(o.range).toMatchObject({ days: 11, granularity: 'day' });
    expect(o.trend).toHaveLength(11);
    expect(o.trend[0]).toEqual({ bucket: tenDaysAgo, revenuePaise: 120000, expensePaise: 20000, invoices: 1 });
    expect(o.trend[10]).toMatchObject({ bucket: today, revenuePaise: 900000 });
    expect(o.trend.slice(1, 10).every((d) => d.revenuePaise === 0)).toBe(true);
    expect(o.kpis.revenuePaise).toBe(1020000);

    const oneDay = await overview(today, today);
    expect(oneDay.previous.revenuePaise).toBe(0);
    expect((await overview(tenDaysAgo, tenDaysAgo)).kpis.revenuePaise).toBe(120000);
  });

  it('shows a customer\'s full history by phone', async () => {
    const res = await master.get('/api/analytics/customer?phone=9500000002');
    expect(res.json).toMatchObject({ phone: '+919500000002', name: 'Bala', lifetimeRevenuePaise: 270000, lifetimeInvoices: 2 });
    expect(res.json.invoices).toHaveLength(2);
    expect((await master.get('/api/analytics/customer?phone=9000000009')).status).toBe(404);
  });

  it('is Master-only and validates the range', async () => {
    expect((await admin.get('/api/analytics/overview')).json).toEqual({ error: 'forbidden' });
    expect((await tech.get('/api/analytics/overview')).json).toEqual({ error: 'forbidden' });
    expect((await master.get(`/api/analytics/overview?from=${today}&to=${tenDaysAgo}`)).status).toBe(400);
    expect((await master.get('/api/analytics/overview')).status).toBe(200); // defaults to the last 30 days
  });
});
