import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePassword, generatePin, parsePepper } from '../src/server/auth/hashing.ts';
import { createPool } from '../src/server/db/client.ts';
import { runMigrations } from '../src/server/db/migrate.ts';
import { runSeed } from '../src/server/db/seed.ts';
import { isWeakPin } from '../src/shared/credentials.ts';

// One-time (and safely re-runnable) setup of the LIVE database. Usage: npm run prod:setup
//
// Reads .env.production (git-ignored) for DATABASE_URL = the Neon "production" branch.
//  1. creates PIN_PEPPER in .env.production if missing (copy the same value into Render);
//  2. applies all migrations;
//  3. seeds reference data, the random invoice-number start, and the 5 accounts;
//  4. writes every first-time login to PROD-LOGINS-DELETE-ME.txt (git-ignored). Nothing
//     secret is printed to the terminal.
// Re-running never resets the counter or recreates accounts.

const ENV_FILE = '.env.production';
const LOGINS_FILE = 'PROD-LOGINS-DELETE-ME.txt';

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

function strongPin(): string {
  for (;;) {
    const pin = generatePin();
    if (!isWeakPin(pin)) return pin;
  }
}

if (!existsSync(ENV_FILE)) {
  writeFileSync(ENV_FILE, 'DATABASE_URL=\nPIN_PEPPER=\n');
}
const env = readEnv(ENV_FILE);
const url = env.DATABASE_URL;
if (!url) {
  console.error(`Paste the Neon "production" branch connection string after DATABASE_URL= in ${ENV_FILE}, then run again.`);
  process.exit(1);
}

// Refuse to "set up production" on the dev or test database by mistake.
const local = readEnv('.env');
const prodHost = hostOf(url);
if (prodHost && (prodHost === hostOf(local.DATABASE_URL) || prodHost === hostOf(local.TEST_DATABASE_URL))) {
  console.error(`${ENV_FILE} points at your dev/test database. Use the Neon "production" branch string.`);
  process.exit(1);
}

let pepper = env.PIN_PEPPER;
if (!pepper) {
  pepper = randomBytes(32).toString('base64');
  const text = readFileSync(ENV_FILE, 'utf8');
  writeFileSync(
    ENV_FILE,
    /^PIN_PEPPER=.*$/m.test(text) ? text.replace(/^PIN_PEPPER=.*$/m, `PIN_PEPPER=${pepper}`) : `${text.trimEnd()}\nPIN_PEPPER=${pepper}\n`,
  );
  console.log(`PIN_PEPPER generated into ${ENV_FILE}. Copy the same value into Render.`);
}

const masterPassword = generatePassword();
const masterPin = strongPin();
const pool = createPool(url, 1);
try {
  await runMigrations(pool);
  console.log(`Migrations applied on ${prodHost}.`);
  const result = await runSeed(pool, {
    pinPepper: parsePepper(pepper),
    masterInitialPassword: masterPassword,
    masterInitialPin: masterPin,
  });
  console.log(result.counterCreated ? 'Invoice counter initialised (random start, not shown).' : 'Invoice counter already present (unchanged).');

  if (result.accountsCreated.length === 0) {
    console.log('Accounts already exist; none created, and no logins file written.');
  } else {
    const lines = [
      'AKSHAYA HOME CARE: LIVE (production) FIRST-TIME LOGINS',
      `Created: ${new Date().toISOString()}`,
      '',
      'Each person must change their password (and PIN, for office staff) at first sign-in.',
      'Give each person ONLY their own line, in person. Then DELETE THIS FILE.',
      '',
    ];
    for (const a of result.accountsCreated) {
      const password = a.password ?? masterPassword;
      const pin = a.role === 'master' ? masterPin : (a.pin ?? '(no PIN for technicians)');
      lines.push(`${a.displayName.padEnd(18)} username: ${a.username}   password: ${password}   PIN: ${pin}`);
    }
    writeFileSync(LOGINS_FILE, `${lines.join('\n')}\n`);
    console.log(`${result.accountsCreated.length} accounts created. Logins written to ${LOGINS_FILE} (not shown here).`);
  }
} catch (err) {
  console.error('Production setup failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
