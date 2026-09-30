import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomerLookup, InvoiceDetail, QueueCard } from '../../src/shared/api-types.ts';
import { istDateString } from '../../src/shared/dates.ts';
import {
  activateAccount,
  buildTestApp,
  createTestPool,
  hasTestDatabase,
  resetDatabaseWithAccounts,
  type SeededAccount,
  type TestClient,
} from './helpers.ts';

let phoneSeq = 0;
function newPhone(): string {
  phoneSeq += 1;
  return `95${String(10_000_000 + phoneSeq).slice(-8)}`;
}

function job(phone: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    phone,
    customerName: `Warranty Customer ${phone.slice(-4)}`,
    areaId: null,
    applianceTypeKey: 'ac_split',
    brandId: null,
    serviceDescription: 'Gas refilling',
    totalRupees: 2300,
    spareCostRupees: 800,
    payment: { status: 'paid', mode: 'upi' },
    ...overrides,
  };
}

// Owner request (30 Sep 2026): a phone with a live 90-day service warranty can be booked as a
// "Warranty service" (free, or with a visit charge), linked to the covering invoice; the new
// invoice message (v2) and the Master's Terms & Conditions link.
describe.skipIf(!hasTestDatabase)('warranty service and invoice message v2 (Neon test branch)', () => {
  let pool: pg.Pool;
  let built: ReturnType<typeof buildTestApp>;
  let accounts: SeededAccount[];
  let tech1: TestClient;
  let tech2: TestClient;
  let admin: TestClient;
  let master: TestClient;
  let masterAccount: SeededAccount;

  const phone = newPhone();
  let originalId: string;
  let originalNumber: number;

  const pending = async (): Promise<QueueCard[]> => (await admin.get('/api/workinv/pending')).json.items;
  const lookup = async (client: TestClient, p: string): Promise<CustomerLookup> =>
    (await client.get(`/api/lookups/customer?phone=${p}`)).json;
  const issue = async (invoiceId: string) => (await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'submitted' })).json;

  beforeAll(async () => {
    pool = createTestPool();
    accounts = await resetDatabaseWithAccounts(pool);
    built = buildTestApp(pool);
    const by = (name: string) => accounts.find((a) => a.displayName === name)!;
    masterAccount = by('Master');
    tech1 = await activateAccount(built.app, by('Technician 1'));
    tech2 = await activateAccount(built.app, by('Technician 2'));
    admin = await activateAccount(built.app, by('Admin Technician'));
    master = await activateAccount(built.app, masterAccount, 'desktop');

    const saved = await tech1.post('/api/jobs', job(phone));
    originalId = saved.json.invoiceId;
    originalNumber = (await issue(originalId)).invoiceNumber;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('invoice message v2', () => {
    it('uses bold labels, the service done, payment and a service-only warranty; no long rules', async () => {
      const detail: InvoiceDetail = (await admin.get(`/api/invoices/${originalId}`)).json;
      const message = detail.message!;
      expect(message).toContain(`*Invoice:* INV-${originalNumber}`);
      expect(message).toContain('*Service:* AC (split) - Gas refilling');
      expect(message).toContain('*Amount:* ₹2,300.00');
      expect(message).toMatch(/^\*Payment:\* Paid$/m);
      expect(message).not.toMatch(/\(upi\)|\(cash\)/i);
      expect(message).toContain('*Warranty:* 90 days on our service, till');
      expect(message).not.toContain('labour');
      expect(message).toContain('Spare parts are not covered.');
      expect(message).not.toContain('----');
      expect(message).not.toContain('Terms');
    });
  });

  describe('customer lookup', () => {
    it('shows another technician the visits and the live warranty, without amounts', async () => {
      const found = await lookup(tech2, phone);
      expect(found.found).toBe(true);
      if (!found.found) return;
      expect(found.visits[0]).toMatchObject({ invoiceNumber: originalNumber, appliance: 'AC (split)', warrantyService: false });
      expect(found.warranties).toHaveLength(1);
      expect(found.warranties[0]).toMatchObject({
        invoiceId: originalId,
        invoiceNumber: originalNumber,
        applianceTypeKey: 'ac_split',
        serviceDescription: 'Gas refilling',
      });
      expect(JSON.stringify(found)).not.toMatch(/paise|profit|margin|message/i);
    });

    it('offers no warranty for an invoice that is not issued yet', async () => {
      const other = newPhone();
      await tech1.post('/api/jobs', job(other));
      const found = await lookup(tech1, other);
      expect(found.found && found.warranties).toEqual([]);
    });
  });

  describe('saving a warranty service', () => {
    let freeId: string;

    it('refuses ₹0 unless it is a warranty service', async () => {
      const res = await tech2.post('/api/jobs', job(phone, { totalRupees: 0, spareCostRupees: 0 }));
      expect(res.status).toBe(422);
      expect(res.json.issues.map((i: { path: string }) => i.path)).toContain('totalRupees');
    });

    it('saves a free warranty service from another technician, linked to the covering invoice', async () => {
      const res = await tech2.post(
        '/api/jobs',
        job(phone, {
          serviceDescription: `Warranty service (INV-${originalNumber}): gas leak re-check`,
          totalRupees: 0,
          spareCostRupees: 0,
          payment: { status: 'unpaid' },
          warrantyOfInvoiceId: originalId,
        }),
      );
      expect(res.status).toBe(200);
      freeId = res.json.invoiceId;
      const card = (await pending()).find((c) => c.id === freeId)!;
      expect(card.warrantyForNumber).toBe(originalNumber);
      expect(card.totalPaise).toBe(0);
      expect(card.preview).toContain(`*Warranty service* for INV-${originalNumber}`);
      expect(card.preview).toContain('*Amount:* No charge');
      expect(card.preview).not.toContain('*Payment:*');
      const payments = await pool.query('SELECT 1 FROM payments WHERE invoice_id = $1', [freeId]);
      expect(payments.rowCount).toBe(0);
    });

    it('issues it with the covering invoice’s warranty, not a new one', async () => {
      const copied = await issue(freeId);
      expect(copied.message).toContain(`covered under INV-${originalNumber}`);
      const own = await pool.query<{ warranty_expires_at: string | null }>(
        'SELECT warranty_expires_at FROM invoices WHERE id = $1',
        [freeId],
      );
      expect(own.rows[0]!.warranty_expires_at).toBeNull();
      const original: InvoiceDetail = (await admin.get(`/api/invoices/${originalId}`)).json;
      const detail: InvoiceDetail = (await admin.get(`/api/invoices/${freeId}`)).json;
      expect(detail.warrantyExpiresAt).toBe(original.warrantyExpiresAt);
      expect(detail.warrantyForNumber).toBe(originalNumber);
      // It does not become a warranty of its own: no chaining.
      const found = await lookup(tech1, phone);
      expect(found.found && found.warranties.map((w) => w.invoiceId)).toEqual([originalId]);
      expect(found.found && found.visits[0]?.warrantyService).toBe(true);
    });

    it('can carry a visit charge, paid as usual', async () => {
      const res = await tech1.post(
        '/api/jobs',
        job(phone, { totalRupees: 300, spareCostRupees: 0, payment: { status: 'paid', mode: 'cash' }, warrantyOfInvoiceId: originalId }),
      );
      expect(res.status).toBe(200);
      const copied = await issue(res.json.invoiceId);
      expect(copied.message).toContain('*Visit charge:* ₹300.00');
      expect(copied.message).toMatch(/^\*Payment:\* Paid$/m);
    });

    it('refuses a warranty link for another phone, a warranty service, or an unissued invoice', async () => {
      const wrongPhone = await tech1.post('/api/jobs', job(newPhone(), { totalRupees: 0, spareCostRupees: 0, warrantyOfInvoiceId: originalId }));
      expect(wrongPhone.json.error).toBe('invalid_warranty');
      const chained = await tech1.post('/api/jobs', job(phone, { totalRupees: 0, spareCostRupees: 0, warrantyOfInvoiceId: freeId }));
      expect(chained.json.error).toBe('invalid_warranty');
      const unissuedPhone = newPhone();
      const unissued = await tech1.post('/api/jobs', job(unissuedPhone));
      const onUnissued = await tech1.post('/api/jobs', job(unissuedPhone, { totalRupees: 0, spareCostRupees: 0, warrantyOfInvoiceId: unissued.json.invoiceId }));
      expect(onUnissued.json.error).toBe('invalid_warranty');
    });

    it('lets the office Copy invoice a warranty service of its own', async () => {
      const res = await admin.post(
        '/api/invoices/issue-own',
        job(phone, { totalRupees: 0, spareCostRupees: 0, payment: { status: 'unpaid' }, warrantyOfInvoiceId: originalId }),
      );
      expect(res.status).toBe(200);
      expect(res.json.message).toContain('*Amount:* No charge');
    });

    it('works when completing an assigned work order', async () => {
      const tech3 = accounts.find((a) => a.displayName === 'Technician 3')!;
      await master.post('/api/auth/verify-pin', { pin: masterAccount.pin, purpose: 'step_up' });
      await master.request('PATCH', `/api/admin/users/${tech3.id}`, { technicianMode: 'invoice_and_work' });
      const worker = await activateAccount(built.app, tech3);
      const order = await admin.post('/api/work', {
        phone,
        customerName: 'Warranty Customer',
        areaId: null,
        visitAddress: null,
        applianceTypeKey: 'ac_split',
        brandId: null,
        complaint: 'Cooling low again',
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        assignedTo: tech3.id,
      });
      expect(order.status).toBe(200);
      const done = await worker.post(`/api/work/${order.json.jobId}/complete`, {
        idempotencyKey: randomUUID(),
        brandId: null,
        serviceDescription: 'Warranty re-check',
        totalRupees: 0,
        spareCostRupees: 0,
        payment: { status: 'unpaid' },
        warrantyOfInvoiceId: originalId,
      });
      expect(done.status).toBe(200);
      expect((await pending()).find((c) => c.id === done.json.invoiceId)?.warrantyForNumber).toBe(originalNumber);
    });

    it('counts issued warranty services on the dashboard', async () => {
      const today = istDateString();
      const res = await master.get(`/api/analytics/overview?from=${today}&to=${today}`);
      expect(res.json.quality.warrantyCallbacks).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Terms & Conditions link (Master settings)', () => {
    const termsUrl = 'https://drive.google.com/file/d/terms-pdf/view';

    it('is Master-only, needs a full https link, and is audited', async () => {
      expect((await admin.request('PATCH', '/api/admin/settings', { termsUrl, officialPhone: '9841459657' })).status).toBe(403);
      await master.post('/api/auth/verify-pin', { pin: masterAccount.pin, purpose: 'step_up' });
      const bad = await master.request('PATCH', '/api/admin/settings', { termsUrl: 'drive.google.com/x', officialPhone: '9841459657' });
      expect(bad.status).toBe(422);
      const ok = await master.request('PATCH', '/api/admin/settings', { termsUrl, officialPhone: '98414 59657' });
      expect(ok.json).toEqual({ termsUrl, officialPhone: '+919841459657' });
      expect((await master.get('/api/admin/settings')).json.termsUrl).toBe(termsUrl);
      const audit = await pool.query("SELECT 1 FROM audit_log WHERE action = 'settings.updated'");
      expect(audit.rowCount).toBe(1);
    });

    it('appears on new messages and previews; issued invoices keep their snapshot', async () => {
      const res = await tech1.post('/api/jobs', job(newPhone()));
      const card = (await pending()).find((c) => c.id === res.json.invoiceId)!;
      expect(card.preview).toContain(`*Terms & Conditions:* ${termsUrl}`);
      expect((await issue(res.json.invoiceId)).message).toContain(termsUrl);
      const old: InvoiceDetail = (await admin.get(`/api/invoices/${originalId}`)).json;
      expect(old.message).not.toContain(termsUrl);
    });
  });
});
