import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleKey } from '../../src/shared/constants.ts';
import { withTransaction } from '../../src/server/db/client.ts';
import { issueInvoice } from '../../src/server/services/issue.ts';
import { createSubmission } from '../../src/server/services/submissions.ts';
import type { Actor } from '../../src/server/services/types.ts';
import { createTestPool, hasTestDatabase, makeSubmission, resetDatabase } from './helpers.ts';

// Database-level integrity guards (drizzle/0001_guards.sql). These must hold even if
// application code is wrong.
describe.skipIf(!hasTestDatabase)('database guards (Neon test branch)', () => {
  let pool: pg.Pool;
  let actors: Record<RoleKey, Actor[]>;
  let technician: Actor;
  let master: Actor;

  beforeAll(async () => {
    pool = createTestPool();
    actors = await resetDatabase(pool);
    technician = actors.technician[0]!;
    master = actors.master[0]!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newSubmitted(): Promise<string> {
    return (await createSubmission(pool, technician, makeSubmission())).invoiceId;
  }

  async function newIssued(): Promise<string> {
    const id = await newSubmitted();
    const result = await issueInvoice(pool, master, id);
    expect(result.kind).toBe('issued');
    return id;
  }

  describe('no hard deletes, append-only logs', () => {
    it('rejects DELETE on invoices', async () => {
      const id = await newSubmitted();
      await expect(pool.query('DELETE FROM invoices WHERE id = $1', [id])).rejects.toThrow(/hard deletes/);
    });

    it('rejects TRUNCATE on audit_log and invoices', async () => {
      await expect(pool.query('TRUNCATE audit_log')).rejects.toThrow(/hard deletes/);
      await expect(pool.query('TRUNCATE invoices CASCADE')).rejects.toThrow(/hard deletes/);
    });

    it('rejects UPDATE and DELETE on audit_log', async () => {
      await expect(pool.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
      await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/hard deletes/);
    });
  });

  describe('invoice counter', () => {
    it('only advances by exactly 1 and its start is immutable', async () => {
      await expect(pool.query('UPDATE invoice_counter SET next_value = next_value + 2')).rejects.toThrow(
        /exactly 1/,
      );
      await expect(pool.query('UPDATE invoice_counter SET next_value = next_value - 1')).rejects.toThrow(
        /exactly 1/,
      );
      await expect(pool.query('UPDATE invoice_counter SET start_value = start_value + 1')).rejects.toThrow(
        /immutable/,
      );
    });

    it('allows only one counter row, with a start inside 10000–89999', async () => {
      await expect(
        pool.query('INSERT INTO invoice_counter (id, start_value, next_value) VALUES (2, 50000, 50000)'),
      ).rejects.toThrow(/single_row/);
    });
  });

  describe('invoice state machine and immutability', () => {
    it('refuses to insert an invoice that is already issued or numbered', async () => {
      const job = await pool.query<{ job_id: string; submitted_by: string }>(
        'SELECT job_id, submitted_by FROM invoices LIMIT 1',
      );
      const { job_id, submitted_by } = job.rows[0]!;
      await expect(
        pool.query(
          `INSERT INTO invoices (job_id, idempotency_key, total_paise, submitted_by, state)
           VALUES ($1, gen_random_uuid(), 100, $2, 'issued')`,
          [job_id, submitted_by],
        ),
      ).rejects.toThrow(/state submitted/);
    });

    it('rejects illegal transitions', async () => {
      const issued = await newIssued();
      await expect(
        pool.query("UPDATE invoices SET state = 'submitted', invoice_number = NULL WHERE id = $1", [issued]),
      ).rejects.toThrow(/illegal invoice state transition/);

      const submitted = await newSubmitted();
      await expect(
        pool.query(
          `UPDATE invoices SET state = 'void', void_reason = 'x', voided_by = submitted_by, voided_at = now()
           WHERE id = $1`,
          [submitted],
        ),
      ).rejects.toThrow(/illegal invoice state transition/);
    });

    it('freezes the total, message and number once issued', async () => {
      const id = await newIssued();
      await expect(pool.query('UPDATE invoices SET total_paise = 1 WHERE id = $1', [id])).rejects.toThrow(
        /immutable/,
      );
      await expect(
        pool.query("UPDATE invoices SET rendered_message = 'changed' WHERE id = $1", [id]),
      ).rejects.toThrow(/immutable/);
    });

    it('allows copy bookkeeping and void on an issued invoice, then treats void as final', async () => {
      const id = await newIssued();
      await pool.query(
        'UPDATE invoices SET copy_count = copy_count + 1, last_copied_at = now() WHERE id = $1',
        [id],
      );
      await expect(
        pool.query(
          "UPDATE invoices SET state = 'void', voided_by = $2, voided_at = now() WHERE id = $1",
          [id, master.id],
        ),
      ).rejects.toThrow(/void_fields/);
      await pool.query(
        `UPDATE invoices SET state = 'void', void_reason = 'Wrong amount', voided_by = $2, voided_at = now()
         WHERE id = $1`,
        [id, master.id],
      );
      const row = await pool.query<{ invoice_number: number | null }>(
        'SELECT invoice_number FROM invoices WHERE id = $1',
        [id],
      );
      expect(row.rows[0]!.invoice_number).not.toBeNull();
      await expect(
        pool.query('UPDATE invoices SET copy_count = copy_count + 1 WHERE id = $1', [id]),
      ).rejects.toThrow(/cannot be modified/);
    });

    it('requires a reason to reject, and treats rejected as final', async () => {
      const id = await newSubmitted();
      await expect(
        pool.query(
          "UPDATE invoices SET state = 'rejected', rejected_by = $2, rejected_at = now() WHERE id = $1",
          [id, master.id],
        ),
      ).rejects.toThrow(/rejected_fields/);
      await pool.query(
        `UPDATE invoices SET state = 'rejected', rejected_reason = 'Duplicate entry', rejected_by = $2,
                rejected_at = now() WHERE id = $1`,
        [id, master.id],
      );
      expect((await issueInvoice(pool, master, id)).kind).toBe('not_issuable');
    });
  });

  describe('invoice date', () => {
    it('defaults to the IST date and cannot be changed without the Master backdate path', async () => {
      const id = await newSubmitted();
      const today = await pool.query<{ d: string; invoice_date: string }>(
        "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d, invoice_date FROM invoices WHERE id = $1",
        [id],
      );
      expect(today.rows[0]!.invoice_date).toBe(today.rows[0]!.d);

      await expect(
        pool.query("UPDATE invoices SET invoice_date = invoice_date - 3 WHERE id = $1", [id]),
      ).rejects.toThrow(/backdated by the Master/);
    });

    it('allows a backdate with the flag and a reason, never forwards, and never after issue', async () => {
      const id = await newSubmitted();
      await withTransaction(pool, async (client) => {
        await client.query("SELECT set_config('ahc.allow_backdate', 'on', true)");
        await client.query(
          "UPDATE invoices SET invoice_date = invoice_date - 2, backdate_reason = 'Entered late' WHERE id = $1",
          [id],
        );
      });

      await expect(
        withTransaction(pool, async (client) => {
          await client.query("SELECT set_config('ahc.allow_backdate', 'on', true)");
          await client.query(
            "UPDATE invoices SET invoice_date = invoice_date + 1, backdate_reason = 'x' WHERE id = $1",
            [id],
          );
        }),
      ).rejects.toThrow(/backdated by the Master/);

      const issued = await issueInvoice(pool, master, id);
      expect(issued.kind).toBe('issued');
      await expect(
        withTransaction(pool, async (client) => {
          await client.query("SELECT set_config('ahc.allow_backdate', 'on', true)");
          await client.query(
            "UPDATE invoices SET invoice_date = invoice_date - 1, backdate_reason = 'y' WHERE id = $1",
            [id],
          );
        }),
      ).rejects.toThrow(/immutable/);
    });
  });

  describe('derived views', () => {
    it('flags a warranty callback for the same customer and appliance within 90 days', async () => {
      const phone = '9876500001';
      const first = await createSubmission(pool, technician, makeSubmission({ phone }));
      const second = await createSubmission(pool, technician, makeSubmission({ phone }));
      const other = await createSubmission(
        pool,
        technician,
        makeSubmission({ phone, applianceTypeKey: 'refrigerator' }),
      );
      await pool.query("UPDATE jobs SET completed_at = now() - interval '40 days' WHERE id = $1", [first.jobId]);

      const res = await pool.query<{ job_id: string; prior_job_id: string }>(
        'SELECT job_id, prior_job_id FROM warranty_callbacks_v WHERE job_id = ANY($1::uuid[])',
        [[first.jobId, second.jobId, other.jobId]],
      );
      expect(res.rows).toEqual([{ job_id: second.jobId, prior_job_id: first.jobId }]);
    });

    it('lists AC service due 6 months after the latest completed job', async () => {
      const phone = '9876500002';
      const job = await createSubmission(pool, technician, makeSubmission({ phone }));
      await pool.query(
        "UPDATE jobs SET completed_at = '2026-01-15 10:00:00+05:30' WHERE id = $1",
        [job.jobId],
      );
      const res = await pool.query<{ due_date: string }>(
        `SELECT v.due_date FROM service_due_v v JOIN customers c ON c.id = v.customer_id
         WHERE c.phone_e164 = $1`,
        ['+91' + phone],
      );
      expect(res.rows).toEqual([{ due_date: '2026-07-15' }]);
    });
  });
});
