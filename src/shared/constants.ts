export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;
export const PASSWORD_MIN_LENGTH = 12;

/** Invoice counter start is drawn uniformly from this inclusive range, once, at first seed. */
export const COUNTER_START_MIN = 10000;
export const COUNTER_START_MAX = 89999;

export const WARRANTY_DAYS = 90;
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

/** Largest single invoice total accepted from the form, in whole rupees. [ASSUMPTION] */
export const MAX_INVOICE_RUPEES = 1_000_000;

export const ROLE_KEYS = ['master', 'admin_technician', 'technician'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * Roles that have a PIN (second factor at login, idle unlock, step-up). Owner decision
 * (29 Sep 2026): technicians sign in with username + password only: no PIN and no idle PIN
 * lock. Their blast radius is small (own submissions only) and the Master can revoke sessions.
 */
export const PIN_ROLES: readonly RoleKey[] = ['master', 'admin_technician'];

export function roleUsesPin(role: RoleKey): boolean {
  return PIN_ROLES.includes(role);
}
