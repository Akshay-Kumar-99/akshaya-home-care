# Phase 1: Architecture and free-tier terms check

Written: 29 Sep 2026. All limits below were checked against the providers' own pages on that date. Free tiers change often, so re-check them before go-live and once a quarter after that.

## 1. Decision summary

- **Host:** Render Free web service in the **Singapore** region, with **Neon Free** Postgres in **aws-ap-southeast-1 (Singapore)**, the Neon region closest to Chennai. Both sit in one region, so each DB round trip is intra-region.
- **Stack:** Node 22 LTS, TypeScript, Hono (API plus static SPA), and React with Vite (two lazy-loaded shells). Postgres access goes through `pg` and Drizzle. Hashing is Argon2id via `@node-rs/argon2`, and push uses `web-push` (VAPID).
- **Why not the others:** Vercel Hobby bans commercial use. Cloudflare Workers Free's 10 ms CPU limit cannot run Argon2id. Netlify Free pins functions to Ohio, far from the Singapore database.
- **Accepted risks (owner-confirmed):** Render Free cold-starts in about 1 minute after 15 minutes idle, and Render's docs advise against production use of free instances. Neon's free restore window is only 6 hours, so an external encrypted export (Phase 6) is mandatory.
- **Recurring cost: ₹0.** Neither Render Free nor Neon Free needs a card to start. If the owner adds a card to Render, bandwidth overage becomes billable (see §4).

## 2. Hosting comparison

| Provider (free tier) | Commercial use | Compute limits that matter here | Verdict |
|---|---|---|---|
| **Vercel Hobby** | **Prohibited**: "non-commercial personal use only"; commercial use needs Pro [V1] | 1M function invocations and 4 h active CPU per month; no overage purchase on Hobby, so usage stops [V2] | **Rejected** on terms |
| **Cloudflare Workers Free** | Allowed | **10 ms CPU per invocation**, 100,000 requests/day [C1] | **Rejected**: Argon2id at OWASP parameters (≈19 MiB, t=2) needs far more than 10 ms CPU, and the spec mandates Argon2id |
| **Netlify Free** | Allowed ("deploy commercial projects") [N1] | 300 credits/month hard limit; production deploy = 15 credits; functions 10 credits/GB-h; **site pauses when credits run out** [N2]. Functions default to **us-east-2 (Ohio)**; region choice is Pro/Enterprise [N3] | **Rejected**: every DB query would cross Ohio↔Singapore, and about 20 deploys a month would use the whole allowance |
| **Render Free** | Not prohibited, but "do not use them for production applications" [R1] | Spins down after **15 min without inbound traffic**, **~1 min** to spin up; **750 instance-hours/workspace/month**, and all free services suspend when they run out [R1]. 512 MB RAM, 0.1 CPU [R2]. Regions include Singapore [R3] | **Chosen** |
| **Neon Free** | No restriction on the plans page; positioned for "prototypes, side projects, and small teams" [D1] | **100 CU-hours/project/month** (≈400 h at 0.25 CU); **0.5 GB storage** (writes fail above it); scale-to-zero after **5 min, cannot be disabled**; **6-hour restore window**; 5 GB egress; compute **suspended until next month** when CU-h or egress run out [D1]. No India region; **Singapore is closest** [D2] | **Chosen** (owner's decision) |

**[TO VERIFY]** Render's Hobby-workspace bandwidth and pipeline-minute allowances are not published on the pages above. Read them in the Render dashboard (Billing) after creating the workspace and add them to §4.

**[TO VERIFY]** Neon's and Render's full Terms of Service for commercial use by a small business. Neither plans page restricts it, but the owner should read both ToS pages once.

## 3. Architecture

```
Android Chrome / installed PWA (technicians, admin_technician)       Desktop Chrome/Edge (master)
            │  HTTPS, HttpOnly session cookie                                   │
            ▼                                                                    ▼
   ┌──────────────────────── Render Free web service (Singapore) ─────────────────────────┐
   │ Hono on Node 22 (one process)                                                        │
   │  /api/*  → auth → RBAC policy → route → service → pg Pool ──────────────┐            │
   │  /*      → built SPA (dist/web): MobileShell | DesktopShell (lazy)      │            │
   │  in-memory queueVersion (poll short-circuit)  web-push (VAPID) ──► FCM / Apple push   │
   └─────────────────────────────────────────────────────────────────────────┼────────────┘
                                                                             ▼
                                                   Neon Postgres Free (aws-ap-southeast-1)
```

- **One process, one instance.** Render Free runs a single instance, so an in-process `queueVersion` counter is safe. Every submission, edit, issue, reject and restore bumps it. The 30-second Work Inv poll sends its last-seen version and gets `304`-style "no change" without a DB query. This is what keeps Neon inside 100 CU-h (see §5).
- **Two shells, one codebase.** The role decides the default shell after login. `DesktopShell` and its chart library are a separate lazy chunk that technician routes never download.
- **Gapless numbering** runs in one interactive transaction over a real TCP connection: `SELECT … FOR UPDATE` on the invoice, then `UPDATE invoice_counter … RETURNING`. The counter row lock serialises issuers; a rollback releases the number, so there are no gaps. This needs a long-running Node process, which is another reason Workers and Functions were not chosen.
- **Server is the source of truth.** The UI refetches on focus and on `visibilitychange`, so backgrounding the app to open WhatsApp loses nothing.
- **No cron.** Push fires as a side effect of a submission. Reminders are a SQL view. Backups are an on-demand export (Phase 6).

### Cold-start mitigation (Render ~1 min)

1. The service worker (Phase 4) caches the app shell, so the UI paints instantly even while the server sleeps.
2. On app open and on every `visibilitychange` to visible, the client calls `/api/health` (no DB access) to wake the server. It shows "Waking the server…" until it gets a 200. The Phase 1 scaffold already does this.
3. The admin_technician normally opens the panel before tapping Copy, so the server is warm by then. If the Copy request still takes more than about 4 s, the clipboard falls back to a selectable textarea with a "Done" button. The async-clipboard user-activation window is not guaranteed to last a minute.
4. Technician submissions go through the offline outbox, so a sleeping server only delays confirmation and never loses data.
5. While any Work Inv panel is open and visible, the 30 s poll keeps Render awake without touching Neon.

## 4. Failure modes: what happens when each free limit is hit

| Limit | Trigger | Effect on the business | Detection | Mitigation / recovery |
|---|---|---|---|---|
| Render spin-down | 15 min with no inbound traffic | First request waits ~1 min | "Waking" banner | §3 mitigation; accepted risk |
| Render 750 instance-hours | >750 h awake in a month (a 31-day month is 744 h, so only a second free service would exceed it) | **All free services suspended until next month** | Render dashboard | Run only this one free service in the workspace |
| Render bandwidth / pipeline minutes | [TO VERIFY] allowance | Bandwidth: billed if a card is on file, otherwise suspended. Build minutes: new deploys blocked, running service unaffected [R1] | Render billing page | Small bundle; deploy in batches, not every commit |
| Neon 100 CU-h | Compute awake about 400 h at 0.25 CU | **DB suspended until next billing period**, so the app is down for writes and reads | Neon console usage graph; Master dashboard shows usage (Phase 5) | `queueVersion` poll short-circuit; min compute 0.25 CU; 5-min scale-to-zero left on |
| Neon 0.5 GB storage | Data grows past 0.5 GB | **Inserts/updates fail**; reads work | Storage figure in Neon console | Rows are small text (years of jobs fit in 0.5 GB); no binary uploads in scope |
| Neon 5 GB egress | Heavy exports/queries | DB suspended until next period | Neon console | Paginated queries; exports only on demand |
| Neon 6-hour restore window | Bad data noticed after 6 h | Neon cannot restore it | n/a | **Phase 6 encrypted external export**, run weekly by the Master |
| Neon cold start | 5 min idle | First query waits a few hundred ms to about a second | Skeleton loaders | Accepted |
| Web Push not delivered | Android battery optimisation / Doze, notification permission revoked, iOS PWA not installed | Checker not alerted | Master "overdue in queue" alert | Poll plus badge while open; owner phone settings (§6) |
| Provider changes free tier | Any time | Could force a migration | Quarterly re-check of this doc | Plain Node plus Postgres, so the app moves to any Node host or Postgres with no code change |

## 5. Neon compute budget

- 100 CU-h ÷ 0.25 CU = **400 awake-hours/month** [D1].
- The worst case, where the poll hits the DB, keeps the DB awake for the whole working day: about 12 h × 30 = **360 h**. That is 90% of the budget, before any other traffic.
- With the `queueVersion` short-circuit, the DB wakes only for real work: a submission, a Copy, list loads and logins. Each wake lasts ~5 min of scale-to-zero tail. Estimated at **under 100 h/month** for 4 field users. [ASSUMPTION: under 60 jobs/day]
- Phase 5 shows CU-h usage on the Master dashboard, if the Neon API allows reading it without a paid plan. [TO VERIFY]

## 6. Web Push feasibility

**Android Chrome (primary): feasible and free.**
- Chrome delivers Web Push through Google's push service (FCM). VAPID keys are generated once (`npx web-push generate-vapid-keys`) and cost nothing.
- Android Doze and OEM battery optimisation defer network access, which delays delivery. Samsung, Xiaomi and similar devices are the most aggressive [P1].
- **One-time settings on the admin_technician's phone** (exact menu names vary by make; [TO VERIFY] on the actual phone):
  1. Settings → Apps → Chrome → Battery → **Unrestricted** (or "Don't optimise").
  2. If the site is installed as an app, apply the same setting to the installed app entry if one appears.
  3. Samsung only: Settings → Battery → Background usage limits. **Remove Chrome from "Sleeping/Deep sleeping apps"**.
  4. Allow notifications for the site (Chrome → Site settings → Notifications) and keep the notification channel sound on.
- Payload is fixed as `"New invoice waiting"`, with **no customer data** in any push.

**iPhone Safari (secondary, best-effort)**
- Web Push works on iOS/iPadOS **16.4+ only for web apps added to the Home Screen**, with a manifest `display: standalone`. Permission must be requested from a user gesture. It uses the same standard Push API [P2].
- If any user is on iOS, they must install the PWA ("Share → Add to Home Screen") and grant permission inside the installed app. This is documented, not engineered around.

**Backstop:** push is advisory only. The in-app count badge (30 s poll, paused when hidden) and the Master's "overdue in queue" alert work without push.

## 7. Phase 1 scaffold (in this repo)

- A Hono server with `/api/health` (no DB access), a strict CSP and security headers, and SPA static serving with path-traversal protection and immutable hashed assets.
- A Vite React SPA that shows the "waking server" state.
- `render.yaml` (Singapore, free), `.env.example` (names only), and unit tests for health, headers and static serving.

## 8. Assumptions and open questions

- [ASSUMPTION] Under 60 jobs/day across all technicians (drives the Neon CU-h estimate).
- [ASSUMPTION] The owner uses one Render workspace with only this free service.
- [ASSUMPTION] The owner accepts Render's "not for production" advisory and the cold start (confirmed 29 Sep 2026).
- [TO VERIFY] Render bandwidth and pipeline-minute allowances (dashboard).
- [TO VERIFY] Battery-optimisation menu paths on the admin_technician's actual phone model.
- [PENDING owner] The spec's own open items: numbering never resets in April, the admin_technician's void-request flow, and the wa.me link with no prefilled text.

## Sources (accessed 29 Sep 2026)

- [V1] Vercel, Fair Use Guidelines: https://vercel.com/docs/limits/fair-use-guidelines
- [V2] Vercel, Hobby Plan: https://vercel.com/docs/plans/hobby
- [C1] Cloudflare Workers, Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- [N1] Netlify, Introducing Netlify's Free plan: https://www.netlify.com/blog/introducing-netlify-free-plan/
- [N2] Netlify, Pricing: https://www.netlify.com/pricing/
- [N3] Netlify Docs, Optional configuration for functions (region): https://docs.netlify.com/build/functions/optional-configuration/
- [R1] Render Docs, Deploy for Free: https://render.com/docs/free
- [R2] Render Docs, Compute plans: https://render.com/docs/compute-plans
- [R3] Render Docs, Regions: https://render.com/docs/regions
- [D1] Neon Docs, Plans: https://neon.com/docs/introduction/plans and FAQ https://neon.com/faqs/free-plan-limits-and-quotas
- [D2] Neon Docs, Regions: https://neon.com/docs/introduction/regions
- [P1] Pushwoosh Help, delayed notifications and battery optimisation: https://help.pushwoosh.com/hc/en-us/articles/31226802486301
- [P2] WebKit, Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
