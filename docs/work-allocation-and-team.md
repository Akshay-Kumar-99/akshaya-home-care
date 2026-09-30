# Team panel and work allocation

Written: 30 Sep 2026, after the owner's request of the same day.

## What the owner asked for

1. **Two-step sign-in.** Page 1 asks for username and password. The Master and Admin Technician then get a second page asking for their PIN. See [phase-3-auth.md](phase-3-auth.md).
2. **A Team panel for the Master**, who is "the master of the whole". It can add, remove or change any user's name, username, password or PIN, including the Admin Technician's.
3. **Two kinds of technician**, as a label the Master sets on each one:
   - **Invoice only.** The same technician app as before: New Job and My Jobs.
   - **Invoice + Work allocation.** Also gets a **Works assigned** tab, where they see jobs the office assigned, start them, and complete them by creating the invoice.
4. The Master creates both kinds. The Add user form will not create a technician until one of the two types is chosen.

The owner also answered two questions:
- **Who assigns work:** the Master and the Admin Technician.
- **Can a technician hand a job back:** no. Only the office can re-assign or cancel a job.

## How it works

### Team panel (Master, desktop rail → Team, Alt+7)

| Action | Notes |
|---|---|
| Add user | Choose Admin Technician (password and PIN) or Technician (password, plus the type). Generate buttons make a strong password or a non-obvious PIN. By default the person must choose their own at first sign-in. The details are shown once, with a Copy details button. |
| Edit | Change the name and username, or switch a technician between Invoice only and Invoice + Work allocation. A technician who still has open work orders can't be switched to Invoice only until that work is re-assigned or cancelled. |
| Password / PIN | Set a new password and/or PIN (a PIN only for the Admin Technician). The person is signed out of all their devices. |
| Sign out everywhere | Ends every session that user has. |
| Remove / Restore | "Remove" disables the account; it is never deleted, because their past jobs and invoices must keep pointing to them. A technician with open work orders can't be removed until that work is re-assigned or cancelled. The last active Master can't be removed. |
| Change my password & PIN | The Master's own account. It needs the current password. |
| Recent sign-ins | The last 30 attempts, failures included. |

Every change asks for the Master's PIN again if the last PIN entry was more than 5 minutes ago (step-up). Each change is written to `audit_log` with old and new values; passwords and PINs are never logged.

### Work orders (Master: rail → Work orders, Alt+6; Admin Technician: bottom tab)

- **New work order:** customer phone (a known phone fills in the name and area), name, area, visit address, appliance, brand (optional), complaint, visit date and time, and the technician. Only active **Invoice + Work** technicians are offered, each with their count of open jobs.
- Tabs: **Open** (assigned or in progress), **Completed** (with the invoice's status and number once issued) and **Cancelled**.
- **Re-assign / reschedule** changes the technician, time, complaint or address. Re-assigning puts the job back to "Assigned" for the new technician.
- **Cancel job** needs a reason, which the technician sees.

### Works assigned (Invoice + Work technicians, first bottom tab)

- The tab badge shows the open jobs. Jobs are listed with the soonest visit first, followed by those completed in the last 7 days and those cancelled in the last 2 days.
- **Call** dials the customer. **Start job** marks it In progress. **Complete & create invoice** opens the job form with the customer and appliance already filled in; the technician adds the brand, the work done, the amounts and the payment.
- The invoice then waits in **Technician Work Inv** like any other job: no number until the office copies it.
- If the office **rejects** that invoice, the job returns to the technician as In progress, showing "Sent back by the office: reason". They complete it again with corrected details. A rejected walk-in job (not a work order) is still cancelled, as before.
- **Offline:** the last list is kept on the phone. Completing a job while offline stores it in the same outbox as New Job ("Not yet on server") and sends it when the connection returns. If the office re-assigned or cancelled the job in the meantime, the technician sees "This job was re-assigned or cancelled by the office."

## Data and security

- `users.technician_mode` holds `invoice_only` or `invoice_and_work`. A database check requires it for technicians and forbids it for everyone else. Existing technicians were set to **Invoice only** by migration `0006_work_allocation.sql`.
- Work orders are rows in `jobs` with `assigned_to` set. The new columns are `complaint`, `visit_address`, `assigned_by`, `assigned_at`, `started_at`, and the cancel fields. Checks make an assigned or in-progress job always have a technician, and a completed job always have a service description.
- The permission `work.assign` belongs to the Master and the Admin Technician. `work.do` goes only to technicians labelled Invoice + Work ([rbac/policy.ts](../src/server/rbac/policy.ts) `canActor`).
- Postgres row-level security ([drizzle/0007_work_rls.sql](../drizzle/0007_work_rls.sql)):
  - A technician can read jobs they created **or** jobs assigned to them.
  - They can update only the progress and completion columns of jobs assigned to them.
  - They can raise an invoice only on a job they created or that is assigned to them.
  - Another technician's job is invisible, even to a query that forgets its WHERE clause.
- **Zero-DB badge poll:** `GET /api/work/mine/version` is answered from an in-process counter ([services/work-state.ts](../src/server/services/work-state.ts)). Every assign, re-assign, cancel, start, complete and reject bumps it. An idle phone never wakes the database.
- **Deploy:** the server applies pending migrations at start-up, so pushing to GitHub updates the live database. If a migration fails, the new version doesn't start and Render keeps the old one running.

## API

| Method and path | Who | Notes |
|---|---|---|
| `GET /api/work?view=open\|completed\|cancelled` | `work.assign` | |
| `GET /api/work/technicians` | `work.assign` | Active Invoice + Work technicians with open-job counts. |
| `POST /api/work` | `work.assign` | `{phone, customerName, areaId, visitAddress, applianceTypeKey, brandId, complaint, scheduledAt, assignedTo}` |
| `PATCH /api/work/:id` | `work.assign` | Any of `{assignedTo, scheduledAt, complaint, visitAddress}`. |
| `POST /api/work/:id/cancel` | `work.assign` | `{reason}` |
| `GET /api/work/mine` | `work.do` | Runs under row-level security. |
| `GET /api/work/mine/version` | `work.do` | Badge poll, no database. |
| `POST /api/work/:id/start` | `work.do` | |
| `POST /api/work/:id/complete` | `work.do` | `{idempotencyKey, brandId, serviceDescription, totalRupees, spareCostRupees, confirmNegativeMargin, payment}`. Idempotent on the key. |
| `POST /api/admin/users` | Master + step-up | `{displayName, username, role, technicianMode, password, pin, mustChange}` |
| `PATCH /api/admin/users/:id` | Master + step-up | Any of `{displayName, username, technicianMode}`. |
| `POST /api/admin/users/:id/credentials` | Master + step-up | `{password?, pin?, mustChange}` |

## Tests

- [tests/integration/team-work.test.ts](../tests/integration/team-work.test.ts) covers:
  - creating each kind of user, and the validation rules;
  - setting a password or PIN, renaming, relabelling, removing and restoring;
  - Master-only access and audit rows with no secrets;
  - assignment only to Invoice + Work technicians, and row-level security;
  - start and complete, idempotent retry, reject returning the job, re-assign and cancel;
  - the zero-DB badge poll, and the PIN-page lockout.
- [tests/integration/auth.test.ts](../tests/integration/auth.test.ts) covers the two-step sign-in.
- The e2e tests ([tests/e2e/mobile.spec.ts](../tests/e2e/mobile.spec.ts), [tests/e2e/desktop.spec.ts](../tests/e2e/desktop.spec.ts)) run the whole flow in the browser:
  - Admin Technician assigns, the technician starts and completes, and the office copies the invoice;
  - on desktop, the Master adds an Invoice + Work technician in the Team panel.

## Assumptions

- [ASSUMPTION] A technician's completed jobs stay on their Works assigned list for 7 days, and cancelled ones for 2 days.
- [ASSUMPTION] The Master cannot create another Master from the panel. The Master account is created only by the seed or emergency script.
- [ASSUMPTION] Technicians get no push notification for new assignments; the badge updates within 30 seconds while the app is open.
