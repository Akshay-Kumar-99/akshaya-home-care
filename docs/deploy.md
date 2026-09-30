# Deploy guide (Render Free + Neon Free, Singapore)

This is the first deploy; later deploys are automatic. Every `git push` to `main` redeploys.

## 1. Push the code to GitHub
```powershell
cd C:\Users\acer\Videos\Projects\akshaya-home-care
git add .
git status        # .env, .env.production and *-DELETE-ME.txt must NOT be listed
git commit -m "Ready for first deploy"
git push
```

## 2. Prepare the live database (on your PC)
1. Neon console → your project → **Branches** → `production` → **Connect**.
2. Keep **Connection pooling** on and copy the string (the host contains `-pooler`).
3. Paste it after `DATABASE_URL=` in **`.env.production`**.
4. Run:
   ```powershell
   npm run prod:setup
   ```
   This does the following:
   - creates `PIN_PEPPER` in `.env.production`;
   - builds all the tables;
   - picks the random invoice-number start;
   - creates the 5 accounts and writes their first-time logins to **`PROD-LOGINS-DELETE-ME.txt`**.

   It refuses to run if `.env.production` points at the dev or test database. Running it again is safe.

## 3. Create the Render service
1. Render dashboard → **New +** → **Blueprint**.
2. Connect GitHub and pick the `akshaya-home-care` repository. Render reads `render.yaml` (free plan, Singapore, Node 22).
3. When it asks for the two secret values, copy them from `.env.production`:
   - `DATABASE_URL`: the same production string;
   - `PIN_PEPPER`: the value `prod:setup` generated. **It must match exactly**, or no PIN will ever verify.
4. **Apply**. The first build takes about 3–6 minutes. When it shows **Live**, open the URL (e.g. `https://akshaya-home-care.onrender.com`).

## 4. First sign-in
1. Sign in as the Master using `PROD-LOGINS-DELETE-ME.txt`. Set your own password and PIN.
2. **Write the 10 recovery codes on paper.**
3. Give each person only their own line, in person. They set their own password at first sign-in.
4. Delete `PROD-LOGINS-DELETE-ME.txt`.
5. On each phone, open the URL in Chrome → menu → **Install app**.

## Later: switch on push alerts (optional)
1. Run `npx web-push generate-vapid-keys`.
2. In Render → **Environment**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:` plus your email). Save; Render redeploys.
3. On the Admin Technician's phone: Work Inv → **Turn on alerts**, then apply the battery settings in [phase-1-architecture.md §6](phase-1-architecture.md).

## Good to know
- **Database updates deploy themselves:** on start-up the server applies any new migration before it serves requests. If a migration fails, the new version doesn't start and Render keeps the previous one live. Check the Render log for "Database migration failed".
- **Users are managed in the app:** the Master's Team panel adds, edits and removes users and sets passwords and PINs (see [work-allocation-and-team.md](work-allocation-and-team.md)). `PROD-LOGINS-DELETE-ME.txt` is only for the very first sign-in.
- **Free plan sleep:** after 15 minutes with no use the server sleeps. The next opening shows "Waking the server…" for up to about a minute.
- **Never** point `.env` (dev) at production, and never run `npm test` or `npm run test:e2e` with `TEST_DATABASE_URL` set to production, because they wipe their database.
- **Emergency reset** of a live account (reads `.env.production`): `npm run emergency-reset:prod -- --list`, then `npm run emergency-reset:prod -- --username <name>` (see [phase-3-auth.md](phase-3-auth.md)).
