import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceCredentials } from '../../src/server/auth/service.ts';
import { withTransaction } from '../../src/server/db/client.ts';
import { roleUsesPin } from '../../src/shared/constants.ts';
import { createTestPool, resetDatabaseWithAccounts, strongPin, TEST_PEPPER } from '../integration/helpers.ts';
import { generatePassword } from '../../src/server/auth/hashing.ts';

export const CREDENTIALS_FILE = path.join(os.tmpdir(), 'ahc-e2e-credentials.json');

export interface E2eAccount {
  role: string;
  displayName: string;
  username: string;
  password: string;
  pin?: string;
  mustChange: boolean;
}

/**
 * Wipes the Neon TEST branch, migrates, seeds, and gives every account known credentials
 * (first-login change already done) except Technician 3, kept for the first-login UI test.
 * Technician 2 is labelled "Invoice + Work allocation" for the Works assigned flow.
 */
export default async function globalSetup(): Promise<void> {
  const pool = createTestPool();
  try {
    const seeded = await resetDatabaseWithAccounts(pool);
    const accounts: E2eAccount[] = [];
    for (const a of seeded) {
      if (a.displayName === 'Technician 3') {
        accounts.push({ ...a, pin: a.pin, mustChange: true });
        continue;
      }
      const password = generatePassword();
      const pin = roleUsesPin(a.role) ? strongPin() : undefined;
      await withTransaction(pool, (client) => replaceCredentials(client, a.id, password, pin ?? null, TEST_PEPPER, false));
      accounts.push({ role: a.role, displayName: a.displayName, username: a.username, password, pin, mustChange: false });
    }
    await pool.query("UPDATE users SET technician_mode = 'invoice_and_work' WHERE display_name = 'Technician 2'");
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(accounts, null, 2));
  } finally {
    await pool.end();
  }
}
