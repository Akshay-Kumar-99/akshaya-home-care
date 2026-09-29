# Phase 4: Invoice module and Technician Work Inv

Written: 29 Sep 2026.

## Decision summary

- **Maker-checker, end to end.** The technician's "Save to Server" goes into the Technician Work Inv queue. The checker's first **Copy message** issues the next gapless number, freezes the message and copies it. Office roles' **Copy invoice** submits and issues their own job in **one transaction**, flagged self-issued.
- **Offline-safe submissions.** Each job is written to IndexedDB on the phone first, with a client-generated idempotency key. It shows "Not yet on server" and is re-sent on reconnect, on returning to the app, and every 30 s. The server stores each key exactly once.
- **Zero-DB badge poll.** The 30-second Work Inv poll is answered from server memory (`QueueState`) and is paused when the app is hidden. A test proves repeat polls make no database call, so Neon can scale to zero while the panel is open.
- **Owner changes (29 Sep 2026).** Office roles' button is **"Copy invoice"** (creates the invoice and copies it). The "Open chat" pop-up after copying is removed; checkers paste into WhatsApp themselves. All WhatsApp chat links and buttons were later removed entirely (owner, 29 Sep 2026). The Area list covers 217 Chennai localities with type-to-filter. The app uses the owner's **"Black and Gold Elegance"** palette (black #000000, navy #14213D, gold #FCA311, light grey #E5E5E5, white). Gold is the accent; blue marks submitted/waiting items; coral marks warnings; green marks issued. The font is Plus Jakarta Sans, served from our server, and there's a Light/Dark/Auto toggle. All Invoices can be filtered by **Today, Yesterday or a date range** (invoice date).
- **Clipboard survives the server round trip.** The write starts synchronously in the tap: a `ClipboardItem` with a Promise works on Android Chrome and iOS Safari, then `writeText`, and finally a select-and-copy dialog.
- **Small technician download.** A hand-rolled router and data loading replace React Router and TanStack Query. Checker screens and the desktop shell are lazy chunks. **Technician route: 81.7 KB gzip against a 110 KB budget** (`npm run check:bundle`).

## Screens

| Role | Shell | Tabs / sections |
|---|---|---|
| Technician | Mobile | New Job · My Submissions |
| Admin Technician | Mobile | Work Inv (badge) · New Invoice (Copy invoice) · All Invoices |
| Master | Desktop (sidebar; collapses to a top bar on phones) | Technician Work Inv · New Invoice · All Invoices · Void requests |

The Business Snapshot (Admin Technician) and the dashboard, users and settings screens (Master) come in Phase 5.

## API (Phase 4)

| Method and path | Permission | Notes |
|---|---|---|
| `GET /api/lookups` | signed in | Appliance types, areas, brands, service presets (cached on the device for offline use) |
| `GET /api/lookups/customer?phone=` | `invoice.submit` | Known phone → name, area |
| `POST /api/jobs` | `invoice.submit` | Submission; safe to repeat with the same `idempotencyKey`; 422 includes field issues |
| `GET /api/jobs/mine` | `invoice.view_own` | Own submissions; technician DTO (no message, profit or link); row-level security applies |
| `GET /api/workinv/version` | `workinv.use` | Badge poll (background, zero DB) |
| `GET /api/workinv/pending`, `/recent` | `workinv.use` | Cards with live preview and flags |
| `POST /api/workinv/:id/copy` `{expect}` | `workinv.use` | `submitted` = issue; `issued` = copy again; 409 `already_copied` |
| `POST /api/workinv/:id/requeue` | `workinv.use` | Put back in queue (keeps number and message) |
| `POST /api/workinv/:id/reject` `{reason}` | `invoice.reject` | Technician sees the reason |
| `PATCH /api/workinv/:id` | `invoice.edit_pending` | Audit old → new; amount changes need step-up |
| `POST /api/invoices/issue-own` | `invoice.issue_own` | Submit and issue in one transaction |
| `GET /api/invoices`, `GET /api/invoices/:id` | `invoice.view_all` | Keyset pagination; search by name, phone or INV number |
| `POST /api/invoices/:id/void` | `invoice.void` + step-up | Master only; the number is kept |
| `POST /api/invoices/:id/void-request` | `void.request` | Admin Technician |
| `GET /api/void-requests`, `POST …/:id/approve` (step-up), `POST …/:id/reject` | `void.approve` | Master |
| `GET /api/push/config`, `POST /api/push/subscribe`, `/unsubscribe` | `workinv.use` | VAPID Web Push; payload "New invoice waiting" |

## Web Push setup (optional; the badge and poll work without it)

1. `npx web-push generate-vapid-keys`
2. Put the two keys in `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, and set `VAPID_SUBJECT=mailto:you@example.com` (in `.env` locally, or in the Render dashboard).
3. On the Admin Technician's phone: Work Inv → "Turn on alerts". Then apply the battery settings in [phase-1-architecture.md §6](phase-1-architecture.md).

## Tests

- **Unit (72):** money, phone, dates, the single template, credentials, lockout, the policy matrix, and the offline outbox (7 scenarios, including no double-send and shared phones).
- **Integration (63, Neon test branch):** numbering (a)–(e); database guards; row-level security; auth. The Phase 4 workflow file covers submit → queue → copy (with concurrency) → copy again, requeue, reject, edit (audit and step-up) → Copy invoice → void request and approval, plus the zero-DB poll. A **technician sweep** is refused 16 checker, invoice and admin endpoints and never receives a message or profit.
- **End to end (Playwright, real Chromium):** a Pixel 7 technician and admin-technician flow including the real clipboard, offline and reconnect, first login, and 360 px layout. Desktop 1366×768: Copy invoice, the invoice table with profit, and void.
- **Manual:** [device-test-checklist.md](device-test-checklist.md).

## Assumptions

- [ASSUMPTION] Recording a payment at submission time is paid (full amount, cash or UPI) or not paid; partial payments come later.
- [ASSUMPTION] Recording an issued invoice's "Put back in queue" keeps its number and frozen message; Copy from the queue then re-sends the same text.
- [ASSUMPTION] Changing the customer phone on a pending item re-links the job to that phone's customer record (created if new).
- [ASSUMPTION] Voiding an invoice, or rejecting a pending item, marks its job cancelled, so it drops out of the warranty and reminder views.
- [ASSUMPTION] Technician route JS budget: 110 KB gzip.
- [ASSUMPTION] "Sound on" is per device and only while the app is open. Push is the closed-app alert.
