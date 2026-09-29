import { parseArgs } from 'node:util';
import { generatePassword, generatePin, parsePepper } from '../src/server/auth/hashing.ts';
import { replaceCredentials } from '../src/server/auth/service.ts';
import { roleUsesPin, type RoleKey } from '../src/shared/constants.ts';
import { createPool, withTransaction } from '../src/server/db/client.ts';

// Emergency credential reset, for when the Master is locked out AND has lost the recovery codes.
// Whoever holds DATABASE_URL + PIN_PEPPER already controls the data, so this adds no new power;
// it is fully audited. Run it on your own PC, pointing .env at the environment to fix:
//
//   npm run emergency-reset -- --list
//   npm run emergency-reset -- --username master-ab12
//
// It prints a one-time password and PIN (the user must change both at next login),
// revokes all of that user's sessions, and re-enables the account if it was disabled.
// A running server honours the revocation on the user's next foreground request (≤ 5 min).

const { values } = parseArgs({
  options: { username: { type: 'string' }, list: { type: 'boolean', default: false } },
});

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env.');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  if (values.list || !values.username) {
    const users = await pool.query<{ username: string; display_name: string; role_key: string; status: string }>(
      'SELECT username, display_name, role_key, status FROM users ORDER BY role_key, display_name',
    );
    console.log('Users:');
    for (const u of users.rows) {
      console.log(`  ${u.username.padEnd(16)} ${u.display_name.padEnd(18)} ${u.role_key.padEnd(17)} ${u.status}`);
    }
    if (!values.username) console.log('\nRe-run with --username <name> to reset one account.');
  } else {
    const pepper = parsePepper(process.env.PIN_PEPPER);
    const password = generatePassword();
    let pin: string | null = null;
    const found = await withTransaction(pool, async (client) => {
      const res = await client.query<{ id: string; display_name: string; role_key: RoleKey }>(
        'SELECT id, display_name, role_key FROM users WHERE lower(username) = lower($1) FOR UPDATE',
        [values.username],
      );
      const user = res.rows[0];
      if (!user) return null;
      pin = roleUsesPin(user.role_key) ? generatePin() : null;
      await replaceCredentials(client, user.id, password, pin, pepper, true);
      await client.query(
        "UPDATE users SET status = 'active', disabled_at = NULL, updated_at = now() WHERE id = $1",
        [user.id],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'emergency_reset'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, reason)
         VALUES (NULL, 'user.emergency_reset', 'user', $1, 'scripts/emergency-reset.ts')`,
        [user.id],
      );
      return user;
    });

    if (!found) {
      console.error(`No user named "${values.username}". Use --list to see usernames.`);
      process.exitCode = 1;
    } else {
      console.log(`Reset ${found.display_name} (${values.username}). SHOWN ONCE, change at next login:`);
      console.log(`  password: ${password}`);
      console.log(`  PIN:      ${pin ?? '(no PIN for technicians)'}`);
    }
  }
} catch (err) {
  console.error('Emergency reset failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
