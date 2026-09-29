# Phase 3: Authentication and authorization

Written: 29 Sep 2026.

## Decision summary

- **Owner decision (29 Sep 2026): only the Master and Admin Technician have a PIN.** Technicians sign in with username and password only. They have no PIN at login, no idle PIN lock and no step-up (they have no sensitive actions). The login form keeps one optional PIN field ("office staff only"), which the server ignores for technicians. A two-step form would tell an attacker when a password is correct.

- **Login** sends username, password and PIN in one request. The PIN is verified only after the password succeeds. Every failure, including an unknown user, costs the same Argon2 work and returns the same generic message.
- **Sessions** are random 256-bit tokens. Only their SHA-256 hash is stored, in `HttpOnly; SameSite=Strict` cookies that are `__Host-`-prefixed and `Secure` in production. Mobile sessions last 30 days and desktop sessions 12 hours. The PIN idle lock (10 minutes, a setting) is enforced on the server.
- **Access control** runs through one permission matrix ([src/server/rbac/policy.ts](../src/server/rbac/policy.ts)) that every route uses. Technicians get a second, Postgres-level layer: requests run as the restricted `ahc_technician_ctx` role, and row-level security (RLS) plus column privileges limit what they can see ([drizzle/0003_rls.sql](../drizzle/0003_rls.sql)).
- **Zero-DB polls.** Background polls (`X-Ahc-Background: 1`) are validated from the in-process session cache. They touch no database, so Neon can scale to zero, and they don't count as activity, so a phone left open on a table still locks.

## Controls

| Control | Where | Behaviour |
|---|---|---|
| Password and PIN hashing | `auth/hashing.ts` | Argon2id (m=19 MiB, t=2, p=1). PINs are also keyed with `PIN_PEPPER`. |
| PIN only after password | `auth/service.ts` `login` | Timing is equalised for unknown users and wrong passwords. |
| Per-IP rate limit | `auth/rate-limit.ts` | 10 login or recovery attempts per IP per 5 minutes (in memory, single instance). |
| Progressive lockout | `auth/service.ts` | After 5 consecutive failures the lock is 1 minute, then 2, 4 … up to a cap of 60, per username. Unknown usernames are locked the same way, so accounts can't be discovered this way. |
| Idle PIN lock | `http/middleware.ts` `requireAuth` | Office roles only. After 10 minutes with no activity the API returns `401 pin_required` until `POST /api/auth/verify-pin`. Technician sessions never lock. |
| Session PIN lockout | `auth/sessions.ts` | 5 wrong PINs on a session revoke it, forcing a full login. |
| Step-up | `requireRecentPin` | Sensitive admin actions need the PIN from the last 5 minutes (`403 step_up_required`). |
| Forced first change | `requireAuth` | Seeded accounts get `403 must_change_credentials` until `POST /api/auth/change-credentials`. Weak PINs (000000, 123456, 121212 …) are refused. |
| CSRF | `sameOriginGuard` + `requireAuth` | Origin must match Host, Sec-Fetch-Site must not be cross-site, and there's a per-session `X-CSRF-Token` (derived from the session token, sent from the readable `ahc_csrf` cookie). |
| Session revocation | `SessionStore` | Changing credentials revokes the user's other sessions. A Master reset or disable revokes all of that user's sessions. |
| Recovery without email | `/api/auth/recover` | The Master gets 10 single-use Argon2-hashed codes, shown once at the first credential change and replaceable by the Master (with step-up). `npm run emergency-reset` is the last resort. |
| Login history | `GET /api/admin/login-history` | The Master sees every attempt, failures included. |
| Audit | `audit_log` | Credential changes, resets, enable/disable, renames and session revocations are logged, with old and new values and never any secrets. |

## API (Phase 3)

| Method and path | Who | Notes |
|---|---|---|
| `POST /api/auth/login` | anyone | `{username, password, pin, deviceKind}` |
| `GET /api/auth/session` | anyone | `{authenticated, locked, mustChange, user, permissions, …}` |
| `POST /api/auth/verify-pin` | session (even when locked) | `{pin, purpose: unlock \| step_up}` |
| `POST /api/auth/change-credentials` | session | `{currentPassword, newPassword, newPin}`. The Master receives `recoveryCodes` once. |
| `POST /api/auth/logout` | session | |
| `POST /api/auth/recover` | anyone (Master username) | `{username, recoveryCode, newPassword, newPin}` |
| `POST /api/auth/recovery-codes` | Master + step-up | Replaces the codes and returns the new ones once. |
| `GET /api/admin/users`, `GET /api/admin/users/:id/sessions` | Master | |
| `POST /api/admin/users/:id/{reset-credentials,disable,enable,revoke-sessions}`, `PATCH /api/admin/users/:id` | Master + step-up | |
| `GET /api/admin/login-history` | Master | |

## Honest limits

- **Technician sessions have no PIN lock.** A stolen technician phone stays signed in until the 30-day limit or until the Master revokes it. The damage is limited to that technician's permissions: submitting jobs, seeing their own submissions, and looking up customer name and area by phone. Technicians never see profit, the customer message or other technicians' work, and Postgres enforces that too. Options if this needs tightening: a shorter technician session (e.g. 7 days), or re-entering the password after idle.

- **"Device-bound" means an HttpOnly cookie on that device.** True cryptographic device binding (DBSC) isn't widely available yet. A stolen phone is covered by the PIN lock, the session PIN lockout and remote revocation.
- **The emergency script edits the database directly.** A running server honours its revocation on the user's next foreground request, which can take up to 5 minutes.
- **Client IP.** `TRUST_PROXY=true` takes the first `X-Forwarded-For` entry on Render. [TO VERIFY] Check on the first deploy that Render overwrites a client-supplied header. If it doesn't, the per-IP limit can be dodged, but the per-account lockout still holds.
- Settings are cached in the process until changed through the app. A manual database edit needs a redeploy.

## Assumptions

- [ASSUMPTION] Desktop sessions last 12 hours in total; mobile sessions last 30 days.
- [ASSUMPTION] Step-up is valid for 5 minutes.
- [ASSUMPTION] 5 wrong PINs on a session revoke it.
- [ASSUMPTION] Technicians can look up any customer by phone, to auto-fill name and area as the spec requires. They can't see other technicians' jobs or invoices.
- [ASSUMPTION] User-management endpoints ship now; the admin screens come in Phase 5.
