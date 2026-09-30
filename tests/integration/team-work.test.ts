import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TeamMember, WorkOrder } from '../../src/shared/api-types.ts';
import { generatePassword } from '../../src/server/auth/hashing.ts';
import { withActorContext } from '../../src/server/db/actor-context.ts';
import {
  activateAccount,
  buildTestApp,
  createTestPool,
  hasTestDatabase,
  resetDatabaseWithAccounts,
  strongPin,
  TestClient,
  type SeededAccount,
} from './helpers.ts';

let phoneSeq = 0;
function workOrder(assignedTo: string, overrides: Record<string, unknown> = {}) {
  phoneSeq += 1;
  return {
    phone: `96${String(10_000_000 + phoneSeq).slice(-8)}`,
    customerName: `Work Customer ${phoneSeq}`,
    areaId: null,
    visitAddress: `${phoneSeq}, 2nd Street, Adyar`,
    applianceTypeKey: 'ac_split',
    brandId: null,
    complaint: 'AC not cooling',
    scheduledAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    assignedTo,
    ...overrides,
  };
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    brandId: null,
    serviceDescription: 'Gas refilling',
    totalRupees: 2500,
    spareCostRupees: 900,
    payment: { status: 'paid', mode: 'cash' },
    ...overrides,
  };
}

// Owner request (Sep 2026): the Master's Team panel, the technician label (Invoice only /
// Invoice + Work allocation) and the Works assigned flow.
describe.skipIf(!hasTestDatabase)('team management and work allocation (Neon test branch)', () => {
  let pool: pg.Pool;
  let built: ReturnType<typeof buildTestApp>;
  let accounts: SeededAccount[];
  let master: TestClient;
  let admin: TestClient;
  let masterAccount: SeededAccount;

  // Accounts created through the Team panel.
  let office2: SeededAccount;
  let field1: SeededAccount;
  let field2: SeededAccount;
  let shop1: SeededAccount;
  let field1Client: TestClient;
  let field2Client: TestClient;
  let shopClient: TestClient;

  const stepUp = () => master.post('/api/auth/verify-pin', { pin: masterAccount.pin, purpose: 'step_up' });
  const team = async (): Promise<TeamMember[]> => (await master.get('/api/admin/users')).json.users;
  const myWork = async (client: TestClient): Promise<WorkOrder[]> => (await client.get('/api/work/mine')).json.items;

  async function createAccount(input: {
    displayName: string;
    username: string;
    role: 'admin_technician' | 'technician';
    technicianMode: 'invoice_only' | 'invoice_and_work' | null;
  }): Promise<SeededAccount> {
    const password = generatePassword();
    const pin = input.role === 'admin_technician' ? strongPin() : undefined;
    await stepUp();
    const res = await master.post('/api/admin/users', { ...input, password, pin: pin ?? null });
    expect(res.status).toBe(200);
    return { id: res.json.userId, role: input.role, displayName: input.displayName, username: input.username, password, pin };
  }

  beforeAll(async () => {
    pool = createTestPool();
    accounts = await resetDatabaseWithAccounts(pool);
    built = buildTestApp(pool);
    const by = (name: string) => accounts.find((a) => a.displayName === name)!;
    masterAccount = by('Master');
    master = await activateAccount(built.app, masterAccount, 'desktop');
    admin = await activateAccount(built.app, by('Admin Technician'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('Team panel (Master)', () => {
    it('creates an Admin Technician, who signs in with password and then PIN', async () => {
      office2 = await createAccount({
        displayName: 'Office Two',
        username: 'office-2',
        role: 'admin_technician',
        technicianMode: null,
      });
      const client = new TestClient(built.app);
      expect((await client.loginPassword(office2)).json.pinRequired).toBe(true);
      const res = await client.login(office2);
      expect(res.status).toBe(200);
      expect(res.json.user.role).toBe('admin_technician');
      expect(res.json.mustChange).toBe(true);
    });

    it('creates both kinds of technician; only Invoice + Work gets Works assigned', async () => {
      field1 = await createAccount({ displayName: 'Field One', username: 'field-1', role: 'technician', technicianMode: 'invoice_and_work' });
      field2 = await createAccount({ displayName: 'Field Two', username: 'field-2', role: 'technician', technicianMode: 'invoice_and_work' });
      shop1 = await createAccount({ displayName: 'Shop One', username: 'shop-1', role: 'technician', technicianMode: 'invoice_only' });
      field1Client = await activateAccount(built.app, field1);
      field2Client = await activateAccount(built.app, field2);
      shopClient = await activateAccount(built.app, shop1);

      const fieldSession = (await field1Client.get('/api/auth/session')).json;
      expect(fieldSession.user.technicianMode).toBe('invoice_and_work');
      expect(fieldSession.permissions).toContain('work.do');
      expect(fieldSession.permissions).toContain('invoice.submit');
      const shopSession = (await shopClient.get('/api/auth/session')).json;
      expect(shopSession.user.technicianMode).toBe('invoice_only');
      expect(shopSession.permissions).not.toContain('work.do');
      expect((await shopClient.get('/api/work/mine')).json).toEqual({ error: 'forbidden' });
    });

    it('demands the technician type for a technician, and a PIN for an Admin Technician', async () => {
      await stepUp();
      const base = { displayName: 'Nobody', username: 'nobody-x', password: generatePassword(), pin: null };
      const noType = await master.post('/api/admin/users', { ...base, role: 'technician', technicianMode: null });
      expect(noType.status).toBe(400);
      const noPin = await master.post('/api/admin/users', { ...base, role: 'admin_technician', technicianMode: null });
      expect(noPin.status).toBe(400);
      const asMaster = await master.post('/api/admin/users', { ...base, role: 'master', technicianMode: null });
      expect(asMaster.status).toBe(400);
    });

    it('refuses a taken username and a weak password', async () => {
      await stepUp();
      const taken = await master.post('/api/admin/users', {
        displayName: 'Copy',
        username: 'FIELD-1',
        role: 'technician',
        technicianMode: 'invoice_only',
        password: generatePassword(),
        pin: null,
      });
      expect(taken.json).toEqual({ error: 'username_taken' });
      const weak = await master.post('/api/admin/users', {
        displayName: 'Weak',
        username: 'weak-1',
        role: 'technician',
        technicianMode: 'invoice_only',
        password: 'short',
        pin: null,
      });
      expect(weak.json).toEqual({ error: 'password_length' });
    });

    it('lists the team with each technician label', async () => {
      const members = await team();
      const byUsername = new Map(members.map((m) => [m.username, m]));
      expect(byUsername.get('field-1')).toMatchObject({ technicianMode: 'invoice_and_work', status: 'active', openJobs: 0 });
      expect(byUsername.get('shop-1')?.technicianMode).toBe('invoice_only');
      expect(byUsername.get('office-2')?.technicianMode).toBeNull();
      expect(members.find((m) => m.roleKey === 'master')).toBeDefined();
    });

    it('sets a specific password or PIN; a technician has no PIN to set', async () => {
      await stepUp();
      const newPassword = generatePassword();
      const set = await master.post(`/api/admin/users/${shop1.id}/credentials`, { password: newPassword, mustChange: false });
      expect(set.status).toBe(200);
      expect((await shopClient.get('/api/auth/session')).json).toEqual({ authenticated: false });
      expect((await new TestClient(built.app).login(shop1)).status).toBe(401);
      shop1.password = newPassword;
      shopClient = new TestClient(built.app);
      const relog = await shopClient.login(shop1);
      expect(relog.status).toBe(200);
      expect(relog.json.mustChange).toBe(false);

      const techPin = await master.post(`/api/admin/users/${shop1.id}/credentials`, { pin: strongPin() });
      expect(techPin.json).toEqual({ error: 'pin_not_applicable' });

      const newPin = strongPin();
      expect((await master.post(`/api/admin/users/${office2.id}/credentials`, { pin: newPin })).status).toBe(200);
      office2.pin = newPin;
      expect((await new TestClient(built.app).login(office2)).status).toBe(200);
    });

    it('renames a user and switches the technician label', async () => {
      await stepUp();
      const renamed = await master.request('PATCH', `/api/admin/users/${shop1.id}`, {
        displayName: 'Shop Renamed',
        technicianMode: 'invoice_and_work',
      });
      expect(renamed.status).toBe(200);
      const session = (await shopClient.get('/api/auth/session')).json;
      expect(session.user.displayName).toBe('Shop Renamed');
      expect(session.permissions).toContain('work.do');
      expect((await master.request('PATCH', `/api/admin/users/${shop1.id}`, { technicianMode: 'invoice_only' })).status).toBe(200);
      expect((await shopClient.get('/api/work/mine')).status).toBe(403);

      const office = await master.request('PATCH', `/api/admin/users/${office2.id}`, { technicianMode: 'invoice_only' });
      expect(office.json).toEqual({ error: 'not_a_technician' });
    });

    it('removes and restores a user', async () => {
      await stepUp();
      expect((await master.post(`/api/admin/users/${shop1.id}/disable`, { reason: 'Left' })).status).toBe(200);
      expect((await new TestClient(built.app).login(shop1)).status).toBe(401);
      expect((await team()).find((m) => m.id === shop1.id)?.status).toBe('disabled');
      expect((await master.post(`/api/admin/users/${shop1.id}/enable`, { reason: 'Back' })).status).toBe(200);
      expect((await new TestClient(built.app).login(shop1)).status).toBe(200);
    });

    it('keeps the Team panel Master-only', async () => {
      expect((await admin.get('/api/admin/users')).json).toEqual({ error: 'forbidden' });
      const create = await admin.post('/api/admin/users', {
        displayName: 'Sneaky',
        username: 'sneaky-1',
        role: 'admin_technician',
        technicianMode: null,
        password: generatePassword(),
        pin: strongPin(),
      });
      expect(create.status).toBe(403);
    });

    it('writes Team changes to the audit log', async () => {
      const res = await pool.query<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'user.%'");
      const actions = res.rows.map((r) => r.action);
      for (const expected of ['user.created', 'user.updated', 'user.credentials_set', 'user.disabled', 'user.enabled']) {
        expect(actions).toContain(expected);
      }
      const secrets = await pool.query("SELECT 1 FROM audit_log WHERE new_values::text ILIKE '%password\":\"%'");
      expect(secrets.rowCount).toBe(0);
    });
  });

  describe('work allocation', () => {
    let jobId: string;
    let invoiceId: string;
    const bg = { 'x-ahc-background': '1' };

    it('offers only active Invoice + Work technicians for assignment', async () => {
      const res = await admin.get('/api/work/technicians');
      const names = (res.json.technicians as Array<{ displayName: string }>).map((t) => t.displayName);
      expect(names).toEqual(['Field One', 'Field Two']);
      const refused = await admin.post('/api/work', workOrder(shop1.id));
      expect(refused.json).toEqual({ error: 'invalid_assignee' });
    });

    it('assigns work; only that technician sees it, and their badge poll needs no database', async () => {
      const before = (await field1Client.get('/api/work/mine/version', bg)).json.version;
      const res = await admin.post('/api/work', workOrder(field1.id));
      expect(res.status).toBe(200);
      jobId = res.json.jobId;
      const after = (await field1Client.get('/api/work/mine/version', bg)).json.version;
      expect(after).toBeGreaterThan(before);

      const query = vi.spyOn(built.deps.pool, 'query');
      const connect = vi.spyOn(built.deps.pool, 'connect');
      for (let i = 0; i < 3; i++) expect((await field1Client.get('/api/work/mine/version', bg)).json.version).toBe(after);
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      vi.restoreAllMocks();

      const mine = await myWork(field1Client);
      const card = mine.find((w) => w.id === jobId)!;
      expect(card).toMatchObject({ status: 'assigned', complaint: 'AC not cooling', assignedByName: 'Admin Technician', invoice: null });
      expect(card.address).toContain('Adyar');
      expect((await myWork(field2Client)).some((w) => w.id === jobId)).toBe(false);
    });

    it('hides other technicians’ jobs at the database level too (RLS)', async () => {
      const count = await withActorContext(pool, { id: field2.id, roleKey: 'technician' }, (client) =>
        client.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs WHERE id = $1', [jobId]),
      );
      expect(count.rows[0]!.n).toBe(0);
    });

    it('refuses work-order management to technicians', async () => {
      expect((await field1Client.post('/api/work', workOrder(field1.id))).status).toBe(403);
      expect((await field1Client.get('/api/work')).status).toBe(403);
    });

    it('start → complete raises an invoice into Work Inv; a retry does not duplicate it', async () => {
      expect((await field2Client.post(`/api/work/${jobId}/start`)).status).toBe(404);
      expect((await field1Client.post(`/api/work/${jobId}/start`)).status).toBe(200);
      expect((await myWork(field1Client)).find((w) => w.id === jobId)?.status).toBe('in_progress');

      const body = completion();
      expect((await field2Client.post(`/api/work/${jobId}/complete`, completion())).status).toBe(404);
      const done = await field1Client.post(`/api/work/${jobId}/complete`, body);
      expect(done.status).toBe(200);
      expect(done.json.created).toBe(true);
      invoiceId = done.json.invoiceId;
      const retry = await field1Client.post(`/api/work/${jobId}/complete`, body);
      expect(retry.json).toEqual({ invoiceId, created: false, state: 'submitted' });

      const pending = (await admin.get('/api/workinv/pending')).json.items as Array<{ id: string }>;
      expect(pending.map((p) => p.id)).toContain(invoiceId);
      const card = (await myWork(field1Client)).find((w) => w.id === jobId)!;
      expect(card.status).toBe('completed');
      expect(card.invoice).toMatchObject({ id: invoiceId, state: 'submitted', invoiceNumber: null });
      const submissions = (await field1Client.get('/api/jobs/mine')).json.items as Array<{ id: string }>;
      expect(submissions.map((s) => s.id)).toContain(invoiceId);
    });

    it('a rejected invoice sends the job back to its technician to redo', async () => {
      const before = (await field1Client.get('/api/work/mine/version', bg)).json.version;
      const res = await admin.post(`/api/workinv/${invoiceId}/reject`, { reason: 'Amount looks wrong' });
      expect(res.json).toEqual({ ok: true, returnedToTechnician: true });
      expect((await field1Client.get('/api/work/mine/version', bg)).json.version).toBeGreaterThan(before);
      const card = (await myWork(field1Client)).find((w) => w.id === jobId)!;
      expect(card.status).toBe('in_progress');
      expect(card.invoice).toMatchObject({ state: 'rejected', rejectedReason: 'Amount looks wrong' });

      const redo = await field1Client.post(`/api/work/${jobId}/complete`, completion({ totalRupees: 2000 }));
      expect(redo.json.created).toBe(true);
      expect(redo.json.invoiceId).not.toBe(invoiceId);
    });

    it('re-assigns and cancels; a cancelled job cannot be completed', async () => {
      const second = (await admin.post('/api/work', workOrder(field1.id))).json.jobId as string;
      expect((await master.request('PATCH', `/api/work/${second}`, { assignedTo: field2.id })).status).toBe(200);
      expect((await myWork(field1Client)).some((w) => w.id === second)).toBe(false);
      expect((await myWork(field2Client)).find((w) => w.id === second)?.status).toBe('assigned');
      expect((await field1Client.post(`/api/work/${second}/complete`, completion())).status).toBe(404);

      expect((await admin.post(`/api/work/${second}/cancel`, { reason: 'Customer cancelled' })).status).toBe(200);
      const card = (await myWork(field2Client)).find((w) => w.id === second)!;
      expect(card).toMatchObject({ status: 'cancelled', cancelReason: 'Customer cancelled' });
      expect((await field2Client.post(`/api/work/${second}/complete`, completion())).json).toEqual({ error: 'wrong_state' });

      const views = await Promise.all(
        (['open', 'completed', 'cancelled'] as const).map(async (view) =>
          ((await master.get(`/api/work?view=${view}`)).json.items as WorkOrder[]).map((w) => w.id),
        ),
      );
      expect(views[1]).toContain(jobId);
      expect(views[2]).toContain(second);
    });

    it('will not remove or relabel a technician who still has open work', async () => {
      const third = (await admin.post('/api/work', workOrder(field1.id))).json.jobId as string;
      await stepUp();
      const relabel = await master.request('PATCH', `/api/admin/users/${field1.id}`, { technicianMode: 'invoice_only' });
      expect(relabel.json).toEqual({ error: 'has_open_work' });
      expect((await master.post(`/api/admin/users/${field1.id}/disable`, { reason: 'Left' })).json).toEqual({
        error: 'has_open_work',
      });
      expect((await team()).find((m) => m.id === field1.id)?.openJobs).toBe(1);
      expect((await admin.post(`/api/work/${third}/cancel`, { reason: 'Test cleanup' })).status).toBe(200);
      expect((await master.request('PATCH', `/api/admin/users/${field1.id}`, { technicianMode: 'invoice_only' })).status).toBe(200);
    });
  });

  describe('PIN page lockout', () => {
    it('counts wrong PINs toward the account lockout, across sign-in attempts', async () => {
      const wrong = office2.pin === '482913' ? '591824' : '482913';
      const client = new TestClient(built.app, '198.51.100.40');
      await client.loginPassword(office2);
      for (const remaining of [4, 3, 2]) {
        expect((await client.post('/api/auth/login/pin', { pin: wrong })).json).toEqual({ error: 'invalid_pin', remainingAttempts: remaining });
      }
      await client.loginPassword(office2);
      expect((await client.post('/api/auth/login/pin', { pin: wrong })).status).toBe(401);
      const locked = await client.post('/api/auth/login/pin', { pin: wrong });
      expect(locked.status).toBe(429);
      expect(locked.json.error).toBe('too_many_attempts');
      // Even the right password is refused while locked.
      expect((await client.loginPassword(office2)).status).toBe(429);
    });
  });
});
