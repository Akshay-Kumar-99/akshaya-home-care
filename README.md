# Akshaya Home Care: invoice backend

A PWA backend for Akshaya Home Care. It runs on Render Free (Singapore) with Neon Postgres Free (Singapore).

**Status: Phase 4 done; Phase 5 in progress (Master analytics dashboard done).**

Docs:
- [Phase 1: architecture](docs/phase-1-architecture.md)
- [Threat model](docs/threat-model.md)
- [Phase 2: data model](docs/phase-2-data-model.md)
- [Phase 3: auth](docs/phase-3-auth.md)
- [Phase 4: invoices](docs/phase-4-invoices.md)
- [Phase 5: Master dashboard](docs/phase-5-dashboard.md)
- [Device test checklist](docs/device-test-checklist.md)

## Requirements

- Node.js **22.18 or newer, but not 23** (22 LTS). The server runs `.ts` files directly using Node's built-in type stripping.

## Commands

```sh
npm install          # install dependencies
npm run dev          # API on :3000 + Vite on :5173 (open http://localhost:5173)
npm run typecheck    # app + service worker type checks
npm test             # Vitest unit + integration tests
npm run build        # build the SPA and service worker to dist/web
npm run check:bundle # technician-route JS budget (after build)
npm run test:e2e     # Playwright: real Chromium, Android (Pixel 7) + desktop (after build)
npm start            # production server (set NODE_ENV=production to serve dist/web)
npm run gen:secret   # random value for PIN_PEPPER
npm run db:migrate   # apply migrations to DATABASE_URL
npm run db:seed      # seed reference data, counter and accounts (prints credentials once)
npm run icons        # regenerate PWA icons
npm run emergency-reset -- --list   # last-resort credential reset (see docs/phase-3-auth.md)
```

`npm test` and `npm run test:e2e` use `TEST_DATABASE_URL`, and **both wipe that database**. Point it only at the Neon `test` branch. The first `test:e2e` run needs `npx playwright install chromium`.

Copy `.env.example` to `.env` for local settings. Never commit `.env`.
