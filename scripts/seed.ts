import { parsePepper } from '../src/server/auth/hashing.ts';
import { createPool } from '../src/server/db/client.ts';
import { runSeed } from '../src/server/db/seed.ts';

// Usage: npm run db:seed
// Needs DATABASE_URL and PIN_PEPPER. On the first run it also needs MASTER_INITIAL_PASSWORD
// and MASTER_INITIAL_PIN, and it prints the other four accounts' credentials ONCE.
// Re-running is safe: it never resets the invoice counter or recreates accounts.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env.');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const result = await runSeed(pool, {
    pinPepper: parsePepper(process.env.PIN_PEPPER),
    masterInitialPassword: process.env.MASTER_INITIAL_PASSWORD,
    masterInitialPin: process.env.MASTER_INITIAL_PIN,
  });

  console.log(`Seed complete on ${new URL(url).hostname}.`);
  console.log(result.counterCreated ? 'Invoice counter initialised.' : 'Invoice counter already present (unchanged).');

  if (result.accountsCreated.length === 0) {
    console.log('Accounts already exist; none created.');
  } else {
    console.log('');
    console.log('================= ACCOUNT CREDENTIALS: SHOWN ONCE =================');
    console.log('Hand each person their own line. Everyone must change password and PIN');
    console.log('at first login. Do not save this output in a file, chat or screenshot.');
    console.log('--------------------------------------------------------------------');
    for (const a of result.accountsCreated) {
      if (a.password === undefined) {
        console.log(`${a.displayName.padEnd(18)} username: ${a.username}   (password/PIN from your env vars)`);
      } else {
        const pin = a.pin === undefined ? '(no PIN for technicians)' : a.pin;
        console.log(`${a.displayName.padEnd(18)} username: ${a.username}   password: ${a.password}   PIN: ${pin}`);
      }
    }
    console.log('====================================================================');
    console.log('Now remove MASTER_INITIAL_PASSWORD and MASTER_INITIAL_PIN from .env.');
  }
} catch (err) {
  console.error('Seed failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
