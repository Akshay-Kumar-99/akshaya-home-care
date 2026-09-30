import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { roleUsesPin } from '../../src/shared/constants.ts';
import { isWeakPin } from '../../src/shared/credentials.ts';
import { generatePassword, generatePin } from '../../src/server/auth/hashing.ts';
import { SlidingWindowLimiter } from '../../src/server/auth/rate-limit.ts';
import {
  buildTestApp,
  createTestPool,
  hasTestDatabase,
  resetDatabaseWithAccounts,
  TestClient,
  type SeededAccount,
} from './helpers.ts';

function strongPin(): string {
  for (;;) {
    const pin = generatePin();
    if (!isWeakPin(pin)) return pin;
  }
}

describe.skipIf(!hasTestDatabase)('authentication and authorization (Neon test branch)', () => {
  let pool: pg.Pool;
  let accounts: SeededAccount[];
  let app: ReturnType<typeof buildTestApp>['app'];

  const byName = (displayName: string) => accounts.find((a) => a.displayName === displayName)!;

  /** Logs in and completes the forced first-login credential change. */
  async function activate(account: SeededAccount, kind: 'mobile' | 'desktop' = 'mobile') {
    const client = new TestClient(app);
    expect((await client.login(account, kind)).status).toBe(200);
    const newPassword = generatePassword();
    const newPin = roleUsesPin(account.role) ? strongPin() : undefined;
    const res = await client.post('/api/auth/change-credentials', {
      currentPassword: account.password,
      newPassword,
      newPin,
    });
    expect(res.status).toBe(200);
    account.password = newPassword;
    account.pin = newPin;
    return { client, recoveryCodes: res.json.recoveryCodes as string[] | null };
  }

  beforeAll(async () => {
    pool = createTestPool();
    accounts = await resetDatabaseWithAccounts(pool);
    app = buildTestApp(pool).app;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('login', () => {
    it('gives the same generic answer for a bad password and an unknown user', async () => {
      const tech = byName('Technician 1');
      const office = byName('Admin Technician');
      const client = new TestClient(app, '198.51.100.1');
      const badPassword = await client.login({ ...tech, password: 'wrong-password-123' });
      const badOfficePassword = await client.login({ ...office, password: 'wrong-password-123' });
      const unknown = await client.login({ username: 'nobody-here', password: 'x'.repeat(14) });
      for (const res of [badPassword, badOfficePassword, unknown]) {
        expect(res.status).toBe(401);
        expect(res.json).toEqual({
          error: 'invalid_credentials',
          message: 'Username or password is incorrect.',
        });
      }
      expect(client.cookies.size).toBe(0);
    });

    it('asks the Master and Admin Technician for the PIN on a second page', async () => {
      const office = byName('Admin Technician');
      const client = new TestClient(app, '198.51.100.2');
      const step1 = await client.loginPassword(office);
      expect(step1.status).toBe(200);
      expect(step1.json).toEqual({ pinRequired: true, displayName: office.displayName });
      // No session yet: only the short-lived, HttpOnly PIN-page cookie.
      const challenge = step1.headers.getSetCookie().find((c) => c.startsWith('ahc_pin='))!;
      expect(challenge).toMatch(/HttpOnly/i);
      expect(challenge).toMatch(/SameSite=Strict/i);
      expect(client.cookies.has('ahc_session')).toBe(false);
      expect((await client.get('/api/auth/session')).json).toEqual({ authenticated: false });

      const wrong = await client.post('/api/auth/login/pin', { pin: office.pin === '482913' ? '591824' : '482913' });
      expect(wrong.status).toBe(401);
      expect(wrong.json).toEqual({ error: 'invalid_pin', remainingAttempts: 4 });

      const ok = await client.post('/api/auth/login/pin', { pin: office.pin });
      expect(ok.status).toBe(200);
      expect(ok.json.pinEnabled).toBe(true);
      expect(ok.json.user.role).toBe('admin_technician');
      expect(client.cookies.has('ahc_session')).toBe(true);
      expect(client.cookies.has('ahc_pin')).toBe(false);
    });

    it('refuses the PIN page without a fresh challenge, and each challenge works once', async () => {
      const office = byName('Admin Technician');
      const none = await new TestClient(app).post('/api/auth/login/pin', { pin: office.pin });
      expect(none.json).toEqual({ error: 'pin_challenge_expired' });

      const client = new TestClient(app);
      await client.loginPassword(office);
      const challenge = client.cookies.get('ahc_pin')!;
      expect((await client.post('/api/auth/login/pin', { pin: office.pin })).status).toBe(200);
      const replay = new TestClient(app);
      replay.cookies.set('ahc_pin', challenge);
      expect((await replay.post('/api/auth/login/pin', { pin: office.pin })).json).toEqual({
        error: 'pin_challenge_expired',
      });
    });

    it('expires the PIN page after 5 minutes', async () => {
      const office = byName('Admin Technician');
      const client = new TestClient(app);
      await client.loginPassword(office);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      expect((await client.post('/api/auth/login/pin', { pin: office.pin })).json).toEqual({
        error: 'pin_challenge_expired',
      });
    });

    it('sets an HttpOnly, SameSite=Strict session cookie and a readable CSRF cookie', async () => {
      const client = new TestClient(app);
      const res = await client.login(byName('Technician 1'));
      expect(res.status).toBe(200);
      const cookies = res.headers.getSetCookie();
      const session = cookies.find((c) => c.startsWith('ahc_session='))!;
      const csrf = cookies.find((c) => c.startsWith('ahc_csrf='))!;
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Strict/i);
      expect(csrf).not.toMatch(/HttpOnly/i);
      expect(res.json.mustChange).toBe(true);
      expect(res.json.user.role).toBe('technician');
      expect(res.json.permissions).not.toContain('profit.view');
      expect(res.json.permissions).not.toContain('message.view');
    });

    it('forces the seeded credentials to be changed before anything else', async () => {
      const client = new TestClient(app);
      await client.login(byName('Master'), 'desktop');
      expect((await client.get('/api/admin/users')).json).toEqual({ error: 'must_change_credentials' });
    });

    it('rejects weak PINs and short passwords when changing credentials', async () => {
      const office = byName('Admin Technician');
      const client = new TestClient(app);
      await client.login(office);
      const weak = await client.post('/api/auth/change-credentials', {
        currentPassword: office.password,
        newPassword: generatePassword(),
        newPin: '123456',
      });
      expect(weak.json).toEqual({ error: 'pin_weak' });
      const short = await client.post('/api/auth/change-credentials', {
        currentPassword: office.password,
        newPassword: 'short',
        newPin: strongPin(),
      });
      expect(short.json).toEqual({ error: 'password_length' });
    });

    it('after a credential change: old credentials fail, new ones work, other sessions are revoked', async () => {
      const tech = byName('Technician 1');
      const other = new TestClient(app);
      await other.login(tech);
      const old = { ...tech };
      const { recoveryCodes } = await activate(tech);
      expect(recoveryCodes).toBeNull(); // only the Master gets recovery codes

      expect((await other.get('/api/auth/session')).json).toEqual({ authenticated: false });
      expect((await new TestClient(app).login(old)).status).toBe(401);
      const fresh = await new TestClient(app).login(tech);
      expect(fresh.status).toBe(200);
      expect(fresh.json.mustChange).toBe(false);
    });
  });

  describe('technicians have no PIN (owner decision)', () => {
    it('stores no PIN for technicians, and one for each office role', async () => {
      const res = await pool.query<{ role_key: string; pins: number }>(
        `SELECT u.role_key, count(c.id)::int AS pins
         FROM users u LEFT JOIN auth_credentials c
           ON c.user_id = u.id AND c.factor_type = 'pin' AND c.revoked_at IS NULL
         GROUP BY u.id, u.role_key`,
      );
      for (const row of res.rows) expect(row.pins).toBe(row.role_key === 'technician' ? 0 : 1);
    });

    it('logs a technician in with username and password only; any PIN sent is ignored', async () => {
      const tech = byName('Technician 3');
      const noPin = await new TestClient(app).login({ username: tech.username, password: tech.password });
      expect(noPin.status).toBe(200);
      expect(noPin.json.pinEnabled).toBe(false);
      const junkPin = await new TestClient(app).login({ ...tech, pin: '000' });
      expect(junkPin.status).toBe(200);
    });

    it('never asks a technician for a PIN', async () => {
      const tech = byName('Technician 3');
      const res = await new TestClient(app).loginPassword(tech);
      expect(res.json.pinRequired).toBeUndefined();
      expect(res.json.authenticated).toBe(true);
    });

    it('never idle-locks a technician session, and has no PIN to verify', async () => {
      const client = new TestClient(app);
      await client.login(byName('Technician 3'));
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60 * 60_000);
      const session = await client.get('/api/auth/session');
      expect(session.json.authenticated).toBe(true);
      expect(session.json.locked).toBe(false);
      expect((await client.post('/api/auth/verify-pin', { pin: '482913' })).json).toEqual({
        error: 'pin_not_applicable',
      });
    });
  });

  describe('progressive lockout', () => {
    it('locks an account after 5 consecutive failures, even for the right credentials', async () => {
      const tech = byName('Technician 3');
      const client = new TestClient(app, '198.51.100.3');
      for (let i = 0; i < 5; i++) {
        expect((await client.login({ ...tech, password: `wrong-password-${i}` })).status).toBe(401);
      }
      const locked = await client.login(tech);
      expect(locked.status).toBe(429);
      expect(locked.json.error).toBe('too_many_attempts');
      expect(locked.json.retryAfterSec).toBeGreaterThan(0);
      expect(locked.headers.get('retry-after')).not.toBeNull();
    });

    it('locks unknown usernames the same way (no account enumeration)', async () => {
      const client = new TestClient(app, '198.51.100.4');
      const ghost = { username: 'ghost-user', password: 'x'.repeat(14) };
      for (let i = 0; i < 5; i++) expect((await client.login(ghost)).status).toBe(401);
      expect((await client.login(ghost)).status).toBe(429);
    });

    it('rate-limits login attempts per IP', async () => {
      const limitedApp = buildTestApp(pool, { limiter: new SlidingWindowLimiter(3, 60_000) }).app;
      const client = new TestClient(limitedApp, '198.51.100.5');
      const ghost = { username: 'ip-limit-probe', password: 'x'.repeat(14) };
      for (let i = 0; i < 3; i++) expect((await client.login(ghost)).status).toBe(401);
      expect((await client.login(ghost)).status).toBe(429);
    });
  });

  describe('sessions: idle PIN lock, step-up, CSRF', () => {
    let master: SeededAccount;
    let masterClient: TestClient;
    let recoveryCodes: string[];

    beforeAll(async () => {
      master = byName('Master');
      const activated = await activate(master, 'desktop');
      masterClient = activated.client;
      recoveryCodes = activated.recoveryCodes!;
    });

    it('gives the Master 10 single-use recovery codes on the first credential change', () => {
      expect(recoveryCodes).toHaveLength(10);
      for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('requires the CSRF token and a same-origin request for state changes', async () => {
      const noToken = await masterClient.post('/api/auth/verify-pin', { pin: master.pin }, { 'x-csrf-token': 'forged' });
      expect(noToken.json).toEqual({ error: 'csrf_failed' });
      const crossOrigin = await masterClient.post(
        '/api/auth/verify-pin',
        { pin: master.pin },
        { origin: 'https://evil.example' },
      );
      expect(crossOrigin.json).toEqual({ error: 'bad_origin' });
      const crossSite = await masterClient.post('/api/auth/verify-pin', { pin: master.pin }, { 'sec-fetch-site': 'cross-site' });
      expect(crossSite.json).toEqual({ error: 'bad_origin' });
    });

    it('locks the session after 10 idle minutes; the PIN unlocks it (server-side)', async () => {
      const client = new TestClient(app);
      await client.login(master, 'desktop');
      expect((await client.get('/api/admin/users')).status).toBe(200);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await client.get('/api/admin/users')).json).toEqual({ error: 'pin_required' });
      expect((await client.get('/api/auth/session')).json.locked).toBe(true);

      const wrong = await client.post('/api/auth/verify-pin', { pin: master.pin === '482913' ? '591824' : '482913' });
      expect(wrong.json).toEqual({ error: 'invalid_pin', remainingAttempts: 4 });
      expect((await client.post('/api/auth/verify-pin', { pin: master.pin })).json).toEqual({ ok: true });
      expect((await client.get('/api/admin/users')).status).toBe(200);
    });

    it('does not count background polls as activity', async () => {
      const client = new TestClient(app);
      await client.login(master, 'desktop');
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      vi.setSystemTime(start + 6 * 60_000);
      const poll = await client.get('/api/auth/session', { 'x-ahc-background': '1' });
      expect(poll.json.locked).toBe(false);
      vi.setSystemTime(start + 11 * 60_000);
      expect((await client.get('/api/admin/users')).json).toEqual({ error: 'pin_required' });
    });

    it('revokes the session after 5 wrong PINs', async () => {
      const client = new TestClient(app);
      await client.login(master, 'desktop');
      const wrongPin = master.pin === '482913' ? '591824' : '482913';
      for (let i = 0; i < 4; i++) {
        expect((await client.post('/api/auth/verify-pin', { pin: wrongPin })).status).toBe(403);
      }
      const last = await client.post('/api/auth/verify-pin', { pin: wrongPin });
      expect(last.json).toEqual({ error: 'unauthenticated', reason: 'pin_lockout' });
      expect((await client.get('/api/auth/session')).json).toEqual({ authenticated: false });
    });

    it('requires a fresh PIN (step-up) for sensitive admin actions', async () => {
      const client = new TestClient(app);
      await client.login(master, 'desktop');
      const target = byName('Technician 1');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const stale = await client.post(`/api/admin/users/${target.id}/revoke-sessions`);
      expect(stale.json).toEqual({ error: 'step_up_required' });
      expect((await client.post('/api/auth/verify-pin', { pin: master.pin, purpose: 'step_up' })).status).toBe(200);
      const fresh = await client.post(`/api/admin/users/${target.id}/revoke-sessions`);
      expect(fresh.status).toBe(200);
    });

    it('shows the Master the login history, including failures', async () => {
      const res = await masterClient.get('/api/admin/login-history?limit=200');
      expect(res.status).toBe(200);
      const attempts = res.json.attempts as Array<{ success: boolean; failureReason: string | null }>;
      expect(attempts.some((a) => !a.success && a.failureReason === 'bad_password')).toBe(true);
      expect(attempts.some((a) => !a.success && a.failureReason === 'unknown_user')).toBe(true);
      expect(attempts.some((a) => a.success)).toBe(true);
    });

    describe('role-based access', () => {
      it('refuses admin routes to technicians and the admin technician', async () => {
        const techClient = new TestClient(app);
        await techClient.login(byName('Technician 1'));
        expect((await techClient.get('/api/admin/users')).json).toEqual({ error: 'forbidden' });
        expect((await techClient.get('/api/admin/login-history')).json).toEqual({ error: 'forbidden' });

        const { client: adminClient } = await activate(byName('Admin Technician'));
        expect((await adminClient.get('/api/admin/users')).json).toEqual({ error: 'forbidden' });
      });
    });

    describe('user administration', () => {
      it('resets a technician: temporary credentials, old sessions revoked, change forced', async () => {
        const tech = byName('Technician 2');
        const techClient = new TestClient(app);
        await techClient.login(tech);

        await masterClient.post('/api/auth/verify-pin', { pin: master.pin, purpose: 'step_up' });
        const res = await masterClient.post(`/api/admin/users/${tech.id}/reset-credentials`);
        expect(res.status).toBe(200);
        expect(res.json.username).toBe(tech.username);
        expect(res.json.temporaryPin).toBeNull(); // technicians have no PIN

        expect((await techClient.get('/api/auth/session')).json).toEqual({ authenticated: false });
        expect((await new TestClient(app).login(tech)).status).toBe(401);
        tech.password = res.json.temporaryPassword;
        const relog = await new TestClient(app).login(tech);
        expect(relog.status).toBe(200);
        expect(relog.json.mustChange).toBe(true);
      });

      it('disables and re-enables a user; a disabled user cannot log in', async () => {
        const tech = byName('Technician 2');
        await masterClient.post('/api/auth/verify-pin', { pin: master.pin, purpose: 'step_up' });
        expect((await masterClient.post(`/api/admin/users/${tech.id}/disable`, { reason: 'Left the job' })).status).toBe(200);
        expect((await new TestClient(app).login(tech)).status).toBe(401);
        expect((await masterClient.post(`/api/admin/users/${tech.id}/enable`, { reason: 'Rejoined' })).status).toBe(200);
        expect((await new TestClient(app).login(tech)).status).toBe(200);
      });

      it('does not let the Master disable or reset their own account', async () => {
        await masterClient.post('/api/auth/verify-pin', { pin: master.pin, purpose: 'step_up' });
        expect((await masterClient.post(`/api/admin/users/${master.id}/disable`, { reason: 'x' })).json).toEqual({
          error: 'self_not_allowed',
        });
        expect((await masterClient.post(`/api/admin/users/${master.id}/reset-credentials`)).json).toEqual({
          error: 'self_not_allowed',
        });
      });

      it('writes every admin change to the audit log', async () => {
        const res = await pool.query<{ action: string }>(
          "SELECT action FROM audit_log WHERE action LIKE 'user.%' ORDER BY id",
        );
        const actions = res.rows.map((r) => r.action);
        for (const expected of ['user.credentials_changed', 'user.credentials_reset', 'user.disabled', 'user.enabled', 'user.sessions_revoked']) {
          expect(actions).toContain(expected);
        }
      });
    });

    describe('Master recovery without email', () => {
      it('resets the password and PIN with a single-use code and revokes all sessions', async () => {
        const newPassword = generatePassword();
        const newPin = strongPin();
        const code = recoveryCodes[0]!;
        const res = await new TestClient(app).post('/api/auth/recover', {
          username: master.username,
          recoveryCode: code.toLowerCase().replace(/-/g, ' '),
          newPassword,
          newPin,
        });
        expect(res.json).toEqual({ ok: true, remainingCodes: 9 });
        expect((await masterClient.get('/api/auth/session')).json).toEqual({ authenticated: false });

        master.password = newPassword;
        master.pin = newPin;
        expect((await new TestClient(app).login(master, 'desktop')).status).toBe(200);

        const reuse = await new TestClient(app).post('/api/auth/recover', {
          username: master.username,
          recoveryCode: code,
          newPassword: generatePassword(),
          newPin: strongPin(),
        });
        expect(reuse.json).toEqual({ error: 'invalid_recovery' });
      });

      it('refuses recovery codes for non-Master accounts', async () => {
        const res = await new TestClient(app).post('/api/auth/recover', {
          username: byName('Technician 1').username,
          recoveryCode: recoveryCodes[1]!,
          newPassword: generatePassword(),
          newPin: strongPin(),
        });
        expect(res.json).toEqual({ error: 'invalid_recovery' });
      });
    });
  });
});
