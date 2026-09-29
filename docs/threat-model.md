# Threat model (Phase 1)

Written: 29 Sep 2026. Scope: invoice vertical slice, Technician Work Inv, auth, admin layer.

## Assets

| Asset | Why it matters |
|---|---|
| Invoice records (totals, spare cost, state, numbers) | Revenue truth. Under-reporting here is direct financial loss. |
| Invoice counter | Gapless sequence. Gaps or duplicates undermine the audit trail and any future GST numbering. |
| Customer PII (name, phone, area, service history) | Privacy harm and reputational damage if leaked. |
| Profit / margin data | Commercially sensitive, and must never reach technicians or customers. |
| Credentials (password hashes, PIN hashes, recovery codes, sessions) | Account takeover gives full access for the Master. |
| Audit log and message log | The evidence trail for fraud detection. Must be tamper-evident. |
| Secrets (DATABASE_URL, PIN_PEPPER, VAPID private key) | Direct DB access or offline PIN cracking. |

## Actors

- **Technician (insider):** a legitimate maker who may be tempted to under-report totals or do jobs off the books.
- **Admin Technician (insider, owner):** a checker who also creates self-issued invoices. Trusted, but still logged.
- **Master:** full privilege. The risk is account compromise, not the person.
- **External attacker:** the site is on a public URL. Expect credential stuffing, brute force and scanning.
- **Thief / finder of a phone:** has physical possession of a device with a live session.
- **Customer:** receives only the rendered message. Could guess invoice numbers.

## Top 10 threats and mitigations

| # | Threat | Likelihood / impact | Mitigations (phase) |
|---|---|---|---|
| 1 | **Technician under-reports a total or does jobs off the books** (a) | High / High | Customer phone recorded on every job; the warranty-callback view exposes unbilled repeat visits. Per-technician average ticket, edit/reject rate and job-count trends go on the Master dashboard (P5). The customer message states the total, so the customer holds evidence. Payments carry `collected_by` (P2). **Residual risk:** a job never entered at all cannot be detected by software. Only customer contact or reminders expose it. |
| 2 | **Maker and checker collude** (a) | Low / High | Every Copy and edit is attributed (`issued_by`, `copied_by`, audit diff). Master views edit rate per checker pair and submission-to-issue delay (P5). Void needs the Master's approval, not the admin_technician's alone (P4). |
| 3 | **Checker edits a pending amount** (a) | Medium / High | Edits are allowed only while the item is `submitted`. Amount edits need step-up PIN (P3/P4). The audit_log stores old and new values and is append-only via DB REVOKE plus a trigger (P2). The technician sees an "edited by office" flag, so the maker is informed. |
| 4 | **Self-issued invoices skip independent review** (a) | Medium / Medium | `self_issued_flag` on every Issue & Copy. Master analytics show the self-issued share and flags (P5). Self-issued invoices still use the same gapless counter and immutable snapshot. |
| 5 | **Online brute force of password plus PIN** (b) | High (public URL) / High | Argon2id on both factors, and a server-side pepper on the PIN. The PIN is checked only after the password succeeds. Per-account and per-IP rate limiting with progressive lockout. Generic error messages. `login_attempts` history visible to the Master (P3). A 6-digit PIN adds 10⁶ combinations behind a correct password. |
| 6 | **Leaked or default credentials** (c) | Medium / Critical | No credentials in code, seeds, logs or docs. Master credentials come from git-ignored env vars at seed time with `must_change=true`. The other accounts get CSPRNG credentials printed once, with only hashes stored (P2/P3). The Master can reset users and revoke sessions behind step-up. There are 10 hashed single-use recovery codes plus an emergency reset script. |
| 7 | **Stolen phone with a live session** (d) | Medium / High | **Office roles:** server-enforced PIN re-unlock after 10 min idle, with its own lockout, so the thief needs the PIN. **Technicians have no PIN (owner decision, 29 Sep 2026):** their session stays usable until revoked or 30 days pass, so the Master must revoke it promptly when a phone is lost. 30-day absolute session cap. The Master revokes all of that user's sessions. Technician sessions cannot see profit, other technicians' data or the customer message, so the blast radius is small. The admin_technician's session is the one that matters: the step-up PIN protects void and amount edits. |
| 8 | **Double-issue race** (e) | Medium / High | `issueInvoice` runs in a single transaction. `SELECT … FOR UPDATE` on the invoice row, and a state check (only `submitted` can issue). The counter row lock serialises numbering. `invoice_number` is UNIQUE, and a DB trigger forbids illegal state moves. The second checker gets "Already copied by X at T". Concurrency tests: 50 parallel issues, a double Copy, and an idempotent resubmit (P2). |
| 9 | **Invoice-number enumeration** (f) | Medium / Low | Numbers are not secrets and there are **no public invoice endpoints**. Every invoice endpoint needs a session and enforces object-level authorisation. A technician only sees rows where `submitted_by = me`. Lookups go by internal UUID, not by number, and a role-visibility test covers every endpoint (P3/P4). The random 5-digit starting number hides total volume from customers. |
| 10 | **Web attacks on the public app (XSS, CSRF, clickjacking, session theft)** | Medium / High | Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`); HttpOnly, Secure, SameSite=Strict cookies; CSRF double-submit token on mutations; Zod validation on every input; parameterised queries only (Drizzle/pg). React escapes output. The customer message is plain text copied to the clipboard and never rendered as HTML (P1 headers done; P3 cookies/CSRF). |

Further threats tracked but outside the top 10:
- **Secrets exposure:** secrets live only in Render env vars; `.env` is git-ignored.
- **PII in logs:** request logging records ids only, never names or phones.
- **Data loss:** Neon's 6-hour restore window, answered by the Phase 6 encrypted export.
- **Push payload leakage:** push carries a fixed string only.

## Required-by-spec coverage

| Spec item | Where addressed |
|---|---|
| (a) Insider fraud: under-reporting, unrecorded jobs, collusion, checker edits, self-issue | Threats 1–4 |
| (b) Brute force with password plus PIN | Threat 5 |
| (c) Leaked or default credentials | Threat 6 |
| (d) Stolen phone with a live session | Threat 7 |
| (e) Double-issue races | Threat 8 |
| (f) Invoice-number enumeration | Threat 9 |

## Honest residual risks

- Software cannot detect a job that was never entered. Customer-facing controls (reminders, warranty calls) and spot checks are the only answer.
- The Master account is a single point of total control. Recovery codes must be stored offline, on paper and away from the Master's laptop.
- Render and Neon staff and infrastructure are trusted third parties, and there is no application-level encryption of PII at rest. [ASSUMPTION] This is acceptable for a small business at this stage.
