# Akshaya Home Care: invoice backend

A PWA backend for Akshaya Home Care. It runs on Render Free (Singapore) with Neon Postgres Free (Singapore).
Design and risks: [docs/phase-1-architecture.md](docs/phase-1-architecture.md) · [docs/threat-model.md](docs/threat-model.md)

**Status: Phase 3 done (login, sessions, PIN lock, roles, row-level security).** Docs: [phase 1](docs/phase-1-architecture.md) · [threat model](docs/threat-model.md) · [phase 2](docs/phase-2-data-model.md) · [phase 3](docs/phase-3-auth.md).

## Requirements

- Node.js **22.18 or newer, but not 23** (22 LTS). The server runs `.ts` files directly using Node's built-in type stripping.

## Commands

```sh
npm install          # install dependencies
npm run dev          # API on :3000 + Vite on :5173 (open http://localhost:5173)
npm run typecheck    # tsc --noEmit
npm test             # Vitest unit/integration tests
npm run build        # build the SPA to dist/web
npm start            # production server (set NODE_ENV=production to serve dist/web)
npm run gen:secret   # random value for PIN_PEPPER
npm run db:migrate   # apply migrations to DATABASE_URL
npm run db:seed      # seed reference data, counter and accounts (prints credentials once)
npm run emergency-reset -- --list   # last-resort credential reset (see docs/phase-3-auth.md)
```

`npm test` also runs the integration suite when `TEST_DATABASE_URL` is set. **That suite wipes its database.** Point it only at the Neon `test` branch.

Copy `.env.example` to `.env` for local settings. Never commit `.env`.
