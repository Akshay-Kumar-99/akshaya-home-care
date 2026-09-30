# Phase 4: Invoice module and Technician Work Inv

Written: 29 Sep 2026.

## Decision summary

- **Maker-checker, end to end.** The technician's "Save to Server" goes into the Technician Work Inv queue. The checker's first **Copy message** issues the next gapless number, freezes the message and copies it. Office roles' **Copy invoice** submits and issues their own job in **one transaction**, flagged self-issued.
- **Offline-safe submissions.** Each job is written to IndexedDB on the phone first, with a client-generated idempotency key. It shows "Not yet on server" and is re-sent on reconnect, on returning to the app, and every 30 s. The server stores each key exactly once.
- **Zero-DB badge poll.** The 30-second Work Inv poll is answered from server memory (`QueueState`) and is paused when the app is hidden. A test proves repeat polls make no database call, so Neon can scale to zero while the panel is open.
- **Owner changes (29 Sep 2026).** Office roles' button is **"Copy invoice"** (creates the invoice and copies it). The "Open chat" pop-up after copying is removed; checkers paste into WhatsApp themselves. All WhatsApp chat links and buttons were later removed entirely (owner, 29 Sep 2026). The Area list covers 217 Chennai localities with type-to-filter. The app uses the owner's **"Black and Gold Elegance"** palette (black #000000, navy #14213D, gold #FCA311, light grey #E5E5E5, white). Gold is the accent; blue marks submitted/waiting items; coral marks warnings; green marks issued. The font is Plus Jakarta Sans, served from our server, and there's a Light/Dark/Auto toggle. All Invoices can be filtered by **Today, Yesterday or a date range** (invoice date).
- **Owner change (30 Sep 2026): the Master's desk is for analysis and management.**
  - The side bar has five sections: Dashboard, Work Inv, All Invoices, Work orders, Settings (Alt+1…5).
  - **New Invoice is removed for the Master.** The Admin Technician's phone keeps it.
  - Void requests are a tab of All Invoices.
  - Settings is a grid of square tiles, one per section (Team, Invoice Template; later additions become new tiles). Each tile opens its own page (/settings?section=…).
  - Old addresses (/void-requests, /team, /new-invoice) redirect to the new place.
- **Owner changes (30 Sep 2026, invoice message v2 and warranty service).**
  - **Invoice message v2** ([shared/invoice-template.ts](../src/shared/invoice-template.ts)).
    - The long dash rules wrapped on phones; the message now uses WhatsApp *bold* labels and blank lines instead.
    - It adds the service done and whether it is paid (Paid or Pending; the cash/UPI mode stays internal).
    - The warranty line now reads "90 days on our service, till … Spare parts are not covered."
    - If the Master has set one, the message ends with a **Terms & Conditions** link.
    - Issued invoices keep their stored v1 text.
  - **Settings → Invoice Template** (Master desktop, Alt+5): the Terms & Conditions link (e.g. a Google Drive PDF shared "Anyone with the link") and the business phone, with a live message preview.
    - Changes need step-up and are audited.
    - They apply to new invoices only.
  - **Warranty service**: when a typed phone has an issued invoice whose warranty is still running, the form shows a **Warranty service** tick box.
    - Ticking it fills in that job and links the new invoice to the covering one (`invoices.warranty_of_invoice_id`).
    - The amount becomes an optional **visit charge**: left empty, it is free (₹0, no payment row).
    - The message says "Warranty service for INV-…" and "covered under INV-… till …".
    - A warranty service gives **no new warranty** of its own: `warranty_expires_at` is null on it.
    - The server checks the link: issued, same phone, not itself a warranty service, warranty still running.
    - ₹0 is allowed only on a warranty service (database check).
    - It works in New Invoice, Copy invoice and when completing a work order.
    - The dashboard's "Warranty callbacks" now counts these explicitly.
  - **Form improvements**:
    - The last 3 visits show under a known phone.
    - An unfinished form is kept on the phone for 24 h (restored after a call, app switch or reload; cleared on save and sign-out).
    - Service chips toggle on and off.
- **Owner changes (30 Sep 2026).** Every copy is **two taps, in order**: **Copy phone** copies the customer's 10-digit number (e.g. 9876543210) to paste into WhatsApp search, then the button becomes **Copy invoice** (or Copy again), which copies the message. A phone's clipboard holds one item, so one tap cannot give both. The INV number is issued on the second tap. The step is kept in `sessionStorage`, so leaving for WhatsApp and coming back lands on Copy invoice ([components/CopyPhoneFirst.tsx](../src/web/components/CopyPhoneFirst.tsx)). The form's "Customer pays" bar no longer floats: it sits at the end of the form, after Payment. The technician's "New Job" tab is now **New Invoice**. The house mark is replaced by the **company logo** (source: [assets/brand/akshaya-logo.jpg](../assets/brand/akshaya-logo.jpg)). `npm run icons` builds a white-lettering version for the dark theme, a black-lettering one for the light theme, and the home-screen icons and favicon.
- **Clipboard survives the server round trip.** The write starts synchronously in the tap: a `ClipboardItem` with a Promise works on Android Chrome and iOS Safari, then `writeText`, and finally a select-and-copy dialog.
- **Small technician download.** A hand-rolled router and data loading replace React Router and TanStack Query. Checker screens and the desktop shell are lazy chunks. **Technician route: 81.7 KB gzip against a 110 KB budget** (`npm run check:bundle`).

## Screens

| Role | Shell | Tabs / sections |
|---|---|---|
| Technician | Mobile | New Invoice · My Submissions |
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
