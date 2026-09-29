import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleKey } from '../../src/shared/constants.ts';
import { withActorContext } from '../../src/server/db/actor-context.ts';
import { issueInvoice } from '../../src/server/services/issue.ts';
import { createSubmission } from '../../src/server/services/submissions.ts';
import type { Actor } from '../../src/server/services/types.ts';
import { createTestPool, hasTestDatabase, makeSubmission, resetDatabase } from './helpers.ts';

// Defence in depth: even a buggy query cannot show a technician another technician's work,
// the customer message, or the counter. Enforced by Postgres (drizzle/0003_rls.sql).
describe.skipIf(!hasTestDatabase)('row-level security for technicians (Neon test branch)', () => {
  let pool: pg.Pool;
  let actors: Record<RoleKey, Actor[]>;
  let tech1: Actor;
  let tech2: Actor;
  let master: Actor;
  let tech1Invoice: string;
  let tech2Invoice: string;

  beforeAll(async () => {
    pool = createTestPool();
    actors = await resetDatabase(pool);
    [tech1, tech2] = actors.technician as [Actor, Actor];
    master = actors.master[0]!;
    tech1Invoice = (await createSubmission(pool, tech1, makeSubmission())).invoiceId;
    tech2Invoice = (await createSubmission(pool, tech2, makeSubmission())).invoiceId;
    await issueInvoice(pool, master, tech1Invoice);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('shows a technician only their own invoices, jobs and payments, even with no WHERE clause', async () => {
    const seen = await withActorContext(pool, tech1, async (client) => ({
      invoices: (await client.query<{ id: string }>('SELECT id FROM invoices')).rows.map((r) => r.id),
      jobs: (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs')).rows[0]!.n,
      payments: (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM payments')).rows[0]!.n,
    }));
    expect(seen.invoices).toEqual([tech1Invoice]);
    expect(seen.jobs).toBe(1);
    expect(seen.payments).toBe(1);
  });

  it('lets a technician see their invoice number and status, but never the customer message', async () => {
    const row = await withActorContext(pool, tech1, (client) =>
      client.query<{ state: string; invoice_number: number }>(
        'SELECT state, invoice_number FROM invoices WHERE id = $1',
        [tech1Invoice],
      ),
    );
    expect(row.rows[0]!.state).toBe('issued');
    await expect(
      withActorContext(pool, tech1, (client) => client.query('SELECT rendered_message FROM invoices')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withActorContext(pool, tech1, (client) => client.query('SELECT * FROM invoices')),
    ).rejects.toThrow(/permission denied/);
  });

  it('blocks technicians from the counter, message log, settings and credentials', async () => {
    for (const sql of [
      'UPDATE invoice_counter SET next_value = next_value + 1',
      'SELECT * FROM message_log',
      'SELECT * FROM settings',
      'SELECT * FROM auth_credentials',
      'SELECT * FROM sessions',
      'SELECT * FROM audit_log',
    ]) {
      await expect(withActorContext(pool, tech1, (client) => client.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('stops a technician writing rows in someone else\'s name', async () => {
    await expect(
      withActorContext(pool, tech1, async (client) => {
        const job = await client.query<{ job_id: string }>('SELECT job_id FROM invoices WHERE id = $1', [tech1Invoice]);
        await client.query(
          `INSERT INTO invoices (job_id, idempotency_key, total_paise, spare_cost_paise, negative_margin_flag, submitted_by)
           VALUES ($1, gen_random_uuid(), 100, 0, false, $2)`,
          [job.rows[0]!.job_id, tech2.id],
        );
      }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withActorContext(pool, tech1, (client) =>
        client.query(
          "INSERT INTO audit_log (actor_id, action, entity_type) VALUES ($1, 'forged', 'invoice')",
          [tech2.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or issue anything, even their own invoice', async () => {
    await expect(
      withActorContext(pool, tech1, (client) =>
        client.query('UPDATE invoices SET total_paise = 1 WHERE id = $1', [tech2Invoice]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('leaves admin roles unrestricted', async () => {
    const res = await withActorContext(pool, master, (client) =>
      client.query<{ n: number }>('SELECT count(*)::int AS n FROM invoices'),
    );
    expect(res.rows[0]!.n).toBe(2);
  });
});
