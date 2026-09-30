import { describe, expect, it } from 'vitest';
import { checkNewPassword, checkNewPin, isWeakPin } from '../../src/shared/credentials.ts';
import { SlidingWindowLimiter } from '../../src/server/auth/rate-limit.ts';
import {
  generateRecoveryCode,
  lockoutMinutes,
  normalizeRecoveryCode,
  usernameKey,
} from '../../src/server/auth/service.ts';
import { csrfTokenFor, hashToken } from '../../src/server/auth/sessions.ts';
import { ACTIONS, can, canActor, permissionsFor } from '../../src/server/rbac/policy.ts';

describe('RBAC policy matrix', () => {
  it('gives the Master every action except doing field work', () => {
    expect(permissionsFor('master')).toEqual(ACTIONS.filter((a) => a !== 'work.do'));
  });

  it('gives Works assigned only to "Invoice + Work allocation" technicians', () => {
    expect(permissionsFor('technician', 'invoice_and_work').sort()).toEqual([
      'invoice.submit',
      'invoice.view_own',
      'spare_cost.view',
      'work.do',
    ]);
    expect(canActor({ roleKey: 'technician', technicianMode: 'invoice_only' }, 'work.do')).toBe(false);
    expect(canActor({ roleKey: 'technician', technicianMode: 'invoice_and_work' }, 'work.assign')).toBe(false);
    expect(canActor({ roleKey: 'admin_technician', technicianMode: 'invoice_and_work' }, 'work.do')).toBe(false);
    expect(can('admin_technician', 'work.assign')).toBe(true);
  });

  it('never lets a technician see profit, margin, the message or other people\'s work', () => {
    expect(permissionsFor('technician').sort()).toEqual(['invoice.submit', 'invoice.view_own', 'spare_cost.view']);
    for (const action of ['profit.view', 'message.view', 'invoice.view_all', 'workinv.use', 'snapshot.view'] as const) {
      expect(can('technician', action)).toBe(false);
    }
  });

  it('keeps the admin technician out of users, settings, export, audit, direct void and backdating', () => {
    for (const action of ['users.manage', 'settings.manage', 'export.run', 'audit.view', 'invoice.void', 'invoice.backdate', 'void.approve'] as const) {
      expect(can('admin_technician', action)).toBe(false);
    }
    for (const action of ['workinv.use', 'invoice.issue_own', 'void.request', 'snapshot.view', 'invoice.reject'] as const) {
      expect(can('admin_technician', action)).toBe(true);
    }
  });
});

describe('credential rules', () => {
  it.each(['000000', '111111', '123456', '654321', '121212', '123123', '1234567', '98765432'])('flags %s as weak', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
  });

  it.each(['482913', '590271', '8401736'])('accepts %s', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
    expect(checkNewPin(pin)).toBeNull();
  });

  it('enforces PIN format and password rules', () => {
    expect(checkNewPin('12345')).toBe('pin_format');
    expect(checkNewPin('48291a')).toBe('pin_format');
    expect(checkNewPassword('short', 'tech-ab12')).toBe('password_length');
    expect(checkNewPassword('my-tech-ab12-password', 'tech-ab12')).toBe('password_contains_username');
    expect(checkNewPassword('aaaaaaaaaaaaaa', 'x')).toBe('password_repetitive');
    expect(checkNewPassword('Kadalai-Mittai-2026', 'tech-ab12')).toBeNull();
  });
});

describe('lockout schedule', () => {
  it('allows 4 failures, then doubles from 1 minute, capped at 60', () => {
    expect([0, 4].map(lockoutMinutes)).toEqual([0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 20].map(lockoutMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('treats usernames case-insensitively', () => {
    expect(usernameKey('  Tech-AB12 ')).toBe('tech-ab12');
  });
});

describe('per-IP sliding window', () => {
  it('allows `limit` hits per window, then reports when to retry', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect([0, 1, 2].map((i) => limiter.hit('ip', t0 + i).allowed)).toEqual([true, true, true]);
    const blocked = limiter.hit('ip', t0 + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
    expect(limiter.hit('other-ip', t0 + 10).allowed).toBe(true);
    expect(limiter.hit('ip', t0 + 60_001).allowed).toBe(true);
  });
});

describe('tokens and recovery codes', () => {
  it('hashes session tokens and derives a CSRF token bound to the session', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(csrfTokenFor('token-a')).not.toBe(csrfTokenFor('token-b'));
    expect(csrfTokenFor('token-a')).toBe(csrfTokenFor('token-a'));
  });

  it('formats recovery codes and normalises what people type', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
  });
});

describe('which roles have a PIN (owner decision)', () => {
  it('gives a PIN to the Master and the Admin Technician only', async () => {
    const { roleUsesPin } = await import('../../src/shared/constants.ts');
    expect(roleUsesPin('master')).toBe(true);
    expect(roleUsesPin('admin_technician')).toBe(true);
    expect(roleUsesPin('technician')).toBe(false);
  });
});
