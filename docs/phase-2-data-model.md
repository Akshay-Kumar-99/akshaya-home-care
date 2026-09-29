# Phase 2: Data model

Written: 29 Sep 2026.

## Decision summary

- **Postgres enforces integrity, not only app code.** Triggers in [drizzle/0001_guards.sql](../drizzle/0001_guards.sql) block hard deletes, keep `audit_log` and `message_log` append-only, allow only legal invoice state moves, freeze issued invoices, and let the counter move only by +1.
- **Gapless numbering.** One transaction locks the invoice row, then advances the single-row `invoice_counter`, whose row lock serialises all issuers. It then stores the rendered message. A rollback returns the number, so no gaps appear.
- **A job is the parent record.** A technician submission creates a `completed` job and an invoice in `submitted` state, which has no number yet.
- **Tooling.** Drizzle defines the schema and generates the migrations. The transactional services use plain parameterised `pg` queries, so the locking behaviour is explicit.

## Tables

| Area | Tables |
|---|---|
| Identity and auth | `roles`, `users`, `auth_credentials` (factor: password, pin, totp, passkey), `sessions`, `recovery_codes`, `login_attempts` |
| Vocabularies | `areas`, `brands` (with `merged_into_id` for the merge tool), `appliance_types` (with reminder interval), `service_presets` |
| Work | `customers` (unique E.164 phone), `jobs` (full status enum, plus `assigned_to` and `scheduled_at` for the roadmap, and `source` app/imported) |
| Money | `invoices`, `payments` (with `settled_to_owner_at` for the future cash ledger), `void_requests` |
| Logs and config | `message_log`, `audit_log`, `settings`, `invoice_counter` |
| Views | `warranty_callbacks_v`, `service_due_v` |

## Invariants

These are enforced by CHECK constraints and triggers, and each one has a test.

- An invoice is inserted only as `submitted`, with no number, and dated today in IST.
- Allowed state moves are `submitted → issued | rejected` and `issued → void`. `void` and `rejected` are final.
- A number exists exactly when the state is `issued` or `void`. A void invoice keeps its number.
- Rejecting or voiding needs a non-empty reason.
- Once issued, these are frozen: number, message, template version, date, amounts and flags.
- `invoice_date` moves only backwards, only while the invoice is `submitted`, only when the Master path sets `ahc.allow_backdate`, and only with a reason.
- The counter start stays in 10000–89999 and never changes. `next_value` moves by exactly +1.

## Commands

```sh
npm run gen:secret     # prints a value for PIN_PEPPER (use a different one per environment)
npm run db:migrate     # apply migrations to DATABASE_URL
npm run db:seed        # reference data, counter (once), 5 accounts (first run only; prints credentials once)
npm test               # unit and integration tests (integration uses TEST_DATABASE_URL, which it WIPES)
npm run db:generate    # after editing src/server/db/schema.ts, generate a new migration
```

## Assumptions

- [ASSUMPTION] Reminders are for AC only (split and window), 6 months after the last completed job.
- [ASSUMPTION] Pending items are highlighted after 4 hours (`queue_alert_hours`).
- [ASSUMPTION] The starter areas, brands and service presets are Chennai-local guesses. All of them are admin-editable.
- [ASSUMPTION] If the same phone is submitted with a new name, the customer's stored name is updated to the new one.
- [ASSUMPTION] Customer phones are Indian mobile numbers only; landlines are rejected.
- [ASSUMPTION] Largest single invoice is ₹10,00,000.
- [ASSUMPTION] The customer message shows the official phone as `+91 98414 59657`.
- Seeded usernames follow the pattern `master-xxxx`, `admin-xxxx` and `tech-xxxx`. The Master's password and PIN come from env vars; the other four are generated and printed once.
- **Deferred to Phase 6:** a least-privilege DB role for the app. Today the app connects as the Neon owner role, and the triggers are the guard.
