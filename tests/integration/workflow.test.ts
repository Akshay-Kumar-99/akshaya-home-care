import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InvoiceRow, MySubmission, QueueCard } from '../../src/shared/api-types.ts';
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
function job(overrides: Record<string, unknown> = {}) {
  phoneSeq += 1;
  return {
    idempotencyKey: randomUUID(),
    phone: `97${String(10_000_000 + phoneSeq).slice(-8)}`,
    customerName: `Customer ${phoneSeq}`,
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

// Phase 4 end-to-end API flows against the Neon test branch: maker → checker → issue,
// Work Inv actions, Issue & Copy, void, zero-DB polling, and what a technician can never see.
describe.skipIf(!hasTestDatabase)('invoice workflow API (Neon test branch)', () => {
  let pool: pg.Pool;
  let built: ReturnType<typeof buildTestApp>;
  let accounts: SeededAccount[];
  let tech1: TestClient;
  let tech2: TestClient;
  let admin: TestClient;
  let master: TestClient;
  let adminAccount: SeededAccount;
  let masterAccount: SeededAccount;

  const pending = async (): Promise<QueueCard[]> => (await admin.get('/api/workinv/pending')).json.items;
  const mine = async (client: TestClient): Promise<MySubmission[]> => (await client.get('/api/jobs/mine')).json.items;

  beforeAll(async () => {
    pool = createTestPool();
    accounts = await resetDatabaseWithAccounts(pool);
    built = buildTestApp(pool);
    const by = (name: string) => accounts.find((a) => a.displayName === name)!;
    adminAccount = by('Admin Technician');
    masterAccount = by('Master');
    tech1 = await activateAccount(built.app, by('Technician 1'));
    tech2 = await activateAccount(built.app, by('Technician 2'));
    admin = await activateAccount(built.app, adminAccount);
    master = await activateAccount(built.app, masterAccount, 'desktop');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('technician: Save to Server', () => {
    it('serves the form vocabularies', async () => {
      const res = await tech1.get('/api/lookups');
      expect(res.status).toBe(200);
      expect(res.json.applianceTypes.map((t: { key: string }) => t.key)).toContain('ac_split');
      expect(res.json.areas.length).toBeGreaterThan(0);
      expect(res.json.servicePresets).toContain('Gas refilling');
    });

    it('submits a job idempotently, and auto-fills a known phone next time', async () => {
      const body = job({ phone: '98400 11111', customerName: 'Lakshmi' });
      const first = await tech1.post('/api/jobs', body);
      expect(first.json).toMatchObject({ created: true, state: 'submitted' });
      const retry = await tech1.post('/api/jobs', body);
      expect(retry.json).toEqual({ ...first.json, created: false });

      const lookup = await tech2.get('/api/lookups/customer?phone=9840011111');
      expect(lookup.json).toMatchObject({ found: true, name: 'Lakshmi' });
      expect((await tech2.get('/api/lookups/customer?phone=9000000001')).json).toEqual({ found: false });
    });

    it('returns field errors for bad input and unknown vocabulary', async () => {
      const badPhone = await tech1.post('/api/jobs', job({ phone: '12345' }));
      expect(badPhone.status).toBe(422);
      expect(badPhone.json.issues[0].path).toBe('phone');
      const noConfirm = await tech1.post('/api/jobs', job({ totalRupees: 500, spareCostRupees: 900 }));
      expect(noConfirm.json.issues[0].path).toBe('confirmNegativeMargin');
      const unknown = await tech1.post('/api/jobs', job({ applianceTypeKey: 'spaceship' }));
      expect(unknown.json).toEqual({ error: 'invalid_reference' });
    });

    it('shows each technician only their own submissions, with status and no message or profit', async () => {
      await tech2.post('/api/jobs', job({ customerName: 'Only For Tech2' }));
      const list1 = await mine(tech1);
      const list2 = await mine(tech2);
      expect(list1.every((s) => s.customerName !== 'Only For Tech2')).toBe(true);
      expect(list2.map((s) => s.customerName)).toContain('Only For Tech2');
      expect(list1[0]).toMatchObject({ state: 'submitted', invoiceNumber: null, editedByOffice: false });
      const raw = JSON.stringify(list1);
      for (const banned of ['preview', 'message', 'grossProfit', 'wa.me', '*Invoice:*']) {
        expect(raw).not.toContain(banned);
      }
    });
  });

  describe('Technician Work Inv', () => {
    it('lists pending items oldest first with a live preview and flags', async () => {
      const dupe = job({ phone: '9840022222', totalRupees: 1500, spareCostRupees: 0 });
      await tech1.post('/api/jobs', dupe);
      await tech1.post('/api/jobs', { ...dupe, idempotencyKey: randomUUID() });
      await tech1.post('/api/jobs', job({ totalRupees: 500, spareCostRupees: 900, confirmNegativeMargin: true }));

      const items = await pending();
      const times = items.map((i) => Date.parse(i.submittedAt));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      const card = items.find((i) => i.phone === '+919840022222')!;
      expect(card.possibleDuplicate).toBe(true);
      expect(card.preview).toContain('*Invoice:* (assigned on copy)');
      expect(card.preview).toContain('*Amount:* ₹1,500.00');
      expect(card.preview).not.toMatch(/spare cost|profit|margin/i);
      expect(items.some((i) => i.negativeMargin)).toBe(true);
    });

    it('Copy issues the next number; a second checker gets "already copied"; the technician sees the number', async () => {
      const { invoiceId } = (await tech1.post('/api/jobs', job({ customerName: 'Copy Test' }))).json;
      const counter = await pool.query<{ next_value: number }>('SELECT next_value FROM invoice_counter');
      const expected = counter.rows[0]!.next_value;

      const copied = await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'submitted' });
      expect(copied.status).toBe(200);
      expect(copied.json).toMatchObject({ outcome: 'issued', invoiceNumber: expected, customerName: 'Copy Test' });
      expect(copied.json.message).toContain(`*Invoice:* INV-${expected}`);

      const second = await master.post(`/api/workinv/${invoiceId}/copy`, { expect: 'submitted' });
      expect(second.status).toBe(409);
      expect(second.json).toMatchObject({ error: 'already_copied', by: 'Admin Technician' });

      expect((await pending()).some((i) => i.id === invoiceId)).toBe(false);
      const techView = (await mine(tech1)).find((s) => s.id === invoiceId)!;
      expect(techView).toMatchObject({ state: 'issued', invoiceNumber: expected });
    });

    it('Recently copied: copy again, put back in queue, and copy from the queue again', async () => {
      const { invoiceId } = (await tech1.post('/api/jobs', job({ customerName: 'Recent Test' }))).json;
      const issued = await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'submitted' });
      const recent: QueueCard[] = (await admin.get('/api/workinv/recent')).json.items;
      const card = recent.find((i) => i.id === invoiceId)!;
      expect(card).toMatchObject({ copiedByName: 'Admin Technician', copyCount: 1 });

      const again = await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'issued' });
      expect(again.json).toMatchObject({ outcome: 'recopied', invoiceNumber: issued.json.invoiceNumber });
      expect(again.json.message).toBe(issued.json.message);

      expect((await admin.post(`/api/workinv/${invoiceId}/requeue`)).status).toBe(200);
      const back = (await pending()).find((i) => i.id === invoiceId)!;
      expect(back).toMatchObject({ requeued: true, state: 'issued', invoiceNumber: issued.json.invoiceNumber });
      expect(back.preview).toBe(issued.json.message);

      await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'issued' });
      expect((await pending()).some((i) => i.id === invoiceId)).toBe(false);
      const log = await pool.query<{ action: string }>(
        'SELECT action FROM message_log WHERE invoice_id = $1 ORDER BY id',
        [invoiceId],
      );
      expect(log.rows.map((r) => r.action)).toEqual(['issue', 'recopy', 'requeue', 'recopy']);
    });

    it('Reject needs a reason, which the technician sees; issued items cannot be rejected', async () => {
      const { invoiceId } = (await tech1.post('/api/jobs', job({ customerName: 'Reject Test' }))).json;
      expect((await admin.post(`/api/workinv/${invoiceId}/reject`, { reason: '' })).json).toEqual({ error: 'reason_required' });
      expect((await admin.post(`/api/workinv/${invoiceId}/reject`, { reason: 'Duplicate of an earlier job' })).status).toBe(200);
      const techView = (await mine(tech1)).find((s) => s.id === invoiceId)!;
      expect(techView).toMatchObject({ state: 'rejected', rejectedReason: 'Duplicate of an earlier job' });
      expect((await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'submitted' })).json).toMatchObject({
        error: 'not_copyable',
        state: 'rejected',
      });
    });

    it('Edit records old and new values, flags "edited by office", and amount changes need a fresh PIN', async () => {
      const { invoiceId } = (await tech1.post('/api/jobs', job({ customerName: 'Edit Test' }))).json;
      expect((await admin.request('PATCH', `/api/workinv/${invoiceId}`, { customerName: 'Edit Test Fixed' })).status).toBe(200);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const stale = await admin.request('PATCH', `/api/workinv/${invoiceId}`, { totalRupees: 2500 });
      expect(stale.json).toEqual({ error: 'step_up_required' });
      await admin.post('/api/auth/verify-pin', { pin: adminAccount.pin, purpose: 'step_up' });
      const fresh = await admin.request('PATCH', `/api/workinv/${invoiceId}`, { totalRupees: 2500 });
      expect(fresh.json).toEqual({ ok: true, changed: ['total_paise'] });

      const audit = await pool.query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
        "SELECT old_values, new_values FROM audit_log WHERE entity_id = $1 AND action = 'invoice.edited' ORDER BY id",
        [invoiceId],
      );
      expect(audit.rows[0]).toEqual({
        old_values: { customer_name: 'Edit Test' },
        new_values: { customer_name: 'Edit Test Fixed' },
      });
      expect(audit.rows[1]).toEqual({ old_values: { total_paise: 230000 }, new_values: { total_paise: 250000 } });

      const techView = (await mine(tech1)).find((s) => s.id === invoiceId)!;
      expect(techView).toMatchObject({ editedByOffice: true, totalPaise: 250000, customerName: 'Edit Test Fixed' });
    });
  });

  describe('Issue & Copy (own jobs) and all invoices', () => {
    it('submits and issues in one step, flagged self-issued, idempotent on retry', async () => {
      const body = job({ customerName: 'Own Job' });
      const res = await admin.post('/api/invoices/issue-own', body);
      expect(res.status).toBe(200);
      expect(res.json.message).toContain(`INV-${res.json.invoiceNumber}`);
      const retry = await admin.post('/api/invoices/issue-own', body);
      expect(retry.json.invoiceNumber).toBe(res.json.invoiceNumber);

      const list: InvoiceRow[] = (await master.get('/api/invoices?q=Own%20Job')).json.items;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ selfIssued: true, state: 'issued', grossProfitPaise: 150000 });
      expect((await tech1.post('/api/invoices/issue-own', job())).json).toEqual({ error: 'forbidden' });
    });

    it('paginates newest first and finds invoices by number or phone', async () => {
      const page1 = await master.get('/api/invoices?limit=3');
      expect(page1.json.items).toHaveLength(3);
      const page2 = await master.get(`/api/invoices?limit=3&cursor=${page1.json.nextCursor}`);
      const ids1 = page1.json.items.map((i: InvoiceRow) => i.id);
      expect(page2.json.items.some((i: InvoiceRow) => ids1.includes(i.id))).toBe(false);

      const issued = (await master.get('/api/invoices?state=issued&limit=1')).json.items[0] as InvoiceRow;
      const byNumber = await master.get(`/api/invoices?q=INV-${issued.invoiceNumber}`);
      expect(byNumber.json.items.map((i: InvoiceRow) => i.id)).toContain(issued.id);
      const detail = await master.get(`/api/invoices/${issued.id}`);
      expect(detail.json.message).toContain(`INV-${issued.invoiceNumber}`);
    });
  });

  describe('All Invoices date filter', () => {
    it('filters by invoice date: today, yesterday and a custom range', async () => {
      const dates = await pool.query<{ today: string; yesterday: string }>(
        "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today, ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1) AS yesterday",
      );
      const { today, yesterday } = dates.rows[0]!;
      const todays = (await master.get(`/api/invoices?from=${today}&to=${today}&limit=100`)).json.items as InvoiceRow[];
      expect(todays.length).toBeGreaterThan(0);
      expect(todays.every((i) => i.invoiceDate === today)).toBe(true);
      expect((await master.get(`/api/invoices?from=${yesterday}&to=${yesterday}`)).json.items).toEqual([]);
      const range = (await master.get(`/api/invoices?from=${yesterday}&to=${today}&limit=100`)).json.items as InvoiceRow[];
      expect(range.length).toBe(todays.length);
      expect((await master.get(`/api/invoices?from=${today}&to=${yesterday}`)).status).toBe(400);
      expect((await master.get('/api/invoices?from=29-09-2026')).status).toBe(400);
    });
  });

  describe('void', () => {
    it('Admin Technician requests; the Master approves with a fresh PIN; the number is kept', async () => {
      const { invoiceId } = (await tech1.post('/api/jobs', job({ customerName: 'Void Test' }))).json;
      const issued = await admin.post(`/api/workinv/${invoiceId}/copy`, { expect: 'submitted' });

      expect((await admin.post(`/api/invoices/${invoiceId}/void`, { reason: 'Wrong amount' })).json).toEqual({ error: 'forbidden' });
      expect((await admin.post(`/api/invoices/${invoiceId}/void-request`, { reason: 'Wrong amount entered' })).status).toBe(200);
      expect((await admin.post(`/api/invoices/${invoiceId}/void-request`, { reason: 'again' })).json).toEqual({
        error: 'already_requested',
      });

      const requests = (await master.get('/api/void-requests')).json.items;
      const request = requests.find((r: { invoiceId: string }) => r.invoiceId === invoiceId);
      expect(request).toMatchObject({ reason: 'Wrong amount entered', requestedByName: 'Admin Technician' });

      await master.post('/api/auth/verify-pin', { pin: masterAccount.pin, purpose: 'step_up' });
      expect((await master.post(`/api/void-requests/${request.id}/approve`, {})).status).toBe(200);
      const detail = (await master.get(`/api/invoices/${invoiceId}`)).json;
      expect(detail).toMatchObject({ state: 'void', invoiceNumber: issued.json.invoiceNumber, voidReason: 'Wrong amount entered' });
      expect((await mine(tech1)).find((s) => s.id === invoiceId)!.state).toBe('void');
    });
  });

  describe('badge poll', () => {
    it('reports the pending count and version, and repeat polls touch no database', async () => {
      const bg = { 'x-ahc-background': '1' };
      const before = (await admin.get('/api/workinv/version', bg)).json;
      await tech1.post('/api/jobs', job());
      const after = (await admin.get('/api/workinv/version', bg)).json;
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.pendingCount).toBe(before.pendingCount + 1);

      const query = vi.spyOn(built.deps.pool, 'query');
      const connect = vi.spyOn(built.deps.pool, 'connect');
      for (let i = 0; i < 3; i++) expect((await admin.get('/api/workinv/version', bg)).status).toBe(200);
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });
  });

  describe('a technician can never reach checker or Master data', () => {
    it('is refused every checker, invoice, void, push and admin endpoint', async () => {
      const someId = randomUUID();
      const calls: Array<[string, string, unknown?]> = [
        ['GET', '/api/workinv/version'],
        ['GET', '/api/workinv/pending'],
        ['GET', '/api/workinv/recent'],
        ['POST', `/api/workinv/${someId}/copy`, { expect: 'submitted' }],
        ['POST', `/api/workinv/${someId}/requeue`],
        ['POST', `/api/workinv/${someId}/reject`, { reason: 'nope nope' }],
        ['PATCH', `/api/workinv/${someId}`, { customerName: 'x' }],
        ['GET', '/api/invoices'],
        ['GET', `/api/invoices/${someId}`],
        ['POST', '/api/invoices/issue-own', job()],
        ['POST', `/api/invoices/${someId}/void`, { reason: 'nope nope' }],
        ['POST', `/api/invoices/${someId}/void-request`, { reason: 'nope nope' }],
        ['GET', '/api/void-requests'],
        ['GET', '/api/push/config'],
        ['GET', '/api/admin/users'],
        ['GET', '/api/admin/login-history'],
      ];
      for (const [method, path, body] of calls) {
        const res = await tech1.request(method, path, body);
        expect({ path, status: res.status, body: res.json }).toEqual({ path, status: 403, body: { error: 'forbidden' } });
      }
    });

    it('sees no message, profit, margin or WhatsApp link in anything it can fetch', async () => {
      const allowed = ['/api/auth/session', '/api/lookups', '/api/jobs/mine', '/api/lookups/customer?phone=9840011111'];
      for (const path of allowed) {
        const res = await tech1.get(path);
        expect(res.status).toBe(200);
        const raw = JSON.stringify(res.json);
        for (const banned of ['preview', 'rendered', '"message"', 'grossProfit', 'profit.view', 'wa.me', '*Invoice:*']) {
          expect({ path, banned, found: raw.includes(banned) }).toEqual({ path, banned, found: false });
        }
      }
    });
  });
});
