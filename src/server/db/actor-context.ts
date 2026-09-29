import type pg from 'pg';
import type { Actor } from '../services/types.ts';
import { withTransaction } from './client.ts';

/**
 * Runs `fn` in a transaction scoped to the actor.
 *
 * Technician requests switch to the restricted `ahc_technician_ctx` role for the transaction
 * (SET LOCAL ROLE). Postgres row-level security then limits them to their own jobs, invoices
 * and payments, and column privileges hide `invoices.rendered_message`, even if a query in
 * application code forgets its WHERE clause. Admin roles run as the owner role.
 * See drizzle/0003_rls.sql.
 */
export async function withActorContext<T>(
  pool: pg.Pool,
  actor: Actor,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('ahc.user_id', $1, true), set_config('ahc.role', $2, true)", [
      actor.id,
      actor.roleKey,
    ]);
    if (actor.roleKey === 'technician') {
      await client.query('SET LOCAL ROLE ahc_technician_ctx');
    }
    return fn(client);
  });
}
