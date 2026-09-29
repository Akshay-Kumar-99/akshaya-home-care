import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleKey } from '../../src/shared/constants.ts';
import { runSeed } from '../../src/server/db/seed.ts';
import { issueInvoice } from '../../src/server/services/issue.ts';
import { createSubmission } from '../../src/server/services/submissions.ts';
import type { Actor } from '../../src/server/services/types.ts';
import {
  counterState,
  createTestPool,
  hasTestDatabase,
  makeSubmission,
  resetDatabase,
  TEST_PEPPER,
} from './helpers.ts';

// Spec Phase 2 tests (a)–(e). All assertions are relative to the seeded counter start,
// which is random and never hard-coded.
describe.skipIf(!hasTestDatabase)('gapless numbering, idempotency and seed (Neon test branch)', () => {
  let pool: pg.Pool;
  let actors: Record<RoleKey, Actor[]>;
  let technician: Actor;
  let admin: Actor;
  let master: Actor;

  beforeAll(async () => {
    pool = createTestPool();
    actors = await resetDatabase(pool);
    technician = actors.technician[0]!;
    admin = actors.admin_technician[0]!;
    master = actors.master[0]!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('(e) seeded the counter start inside 10000–89999, with next = start before any issue', async () => {
    const { start, next } = await counterState(pool);
    expect(start).toBeGreaterThanOrEqual(10000);
    expect(start).toBeLessThanOrEqual(89999);
    expect(next).toBe(start);
  });

  it('(a) 50 simultaneous issues yield exactly start..start+49, no duplicates, no gaps', async () => {
    const before = await counterState(pool);
    const submissions = [];
    for (let i = 0; i < 50; i++) {
      submissions.push(await createSubmission(pool, technician, makeSubmission()));
    }

    const results = await Promise.all(
      submissions.map((s, i) => issueInvoice(pool, i % 2 === 0 ? admin : master, s.invoiceId)),
    );

    const numbers = results.map((r) => {
      expect(r.kind).toBe('issued');
      return r.kind === 'issued' ? r.invoiceNumber : -1;
    });
    const sorted = [...numbers].sort((a, b) => a - b);
    const expected = Array.from({ length: 50 }, (_, i) => before.next + i);
    expect(sorted).toEqual(expected);
    expect(new Set(numbers).size).toBe(50);

    const after = await counterState(pool);
    expect(after.next).toBe(before.next + 50);
    expect(after.start).toBe(before.start);

    const stored = await pool.query<{ n: number }>(
      'SELECT invoice_number AS n FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY invoice_number',
      [submissions.map((s) => s.invoiceId)],
    );
    expect(stored.rows.map((r) => r.n)).toEqual(expected);
  });

  it('(b) two checkers copying the same submission at once issue exactly one number', async () => {
    const before = await counterState(pool);
    const { invoiceId } = await createSubmission(pool, technician, makeSubmission());

    const [first, second] = await Promise.all([
      issueInvoice(pool, admin, invoiceId),
      issueInvoice(pool, master, invoiceId),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['already_issued', 'issued']);

    const issued = [first, second].find((r) => r.kind === 'issued');
    const already = [first, second].find((r) => r.kind === 'already_issued');
    if (issued?.kind !== 'issued' || already?.kind !== 'already_issued') throw new Error('unreachable');
    expect(already.invoiceNumber).toBe(issued.invoiceNumber);
    expect(already.message).toBe(issued.message);
    expect(already.issuedByName).toMatch(/Master|Admin Technician/);
    expect(issued.invoiceNumber).toBe(before.next);
    expect((await counterState(pool)).next).toBe(before.next + 1);

    const log = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM message_log WHERE invoice_id = $1 AND action = 'issue'",
      [invoiceId],
    );
    expect(log.rows[0]!.n).toBe(1);
  });

  it('(c) retrying a submission with the same idempotency key creates exactly one record', async () => {
    const input = makeSubmission();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createSubmission(pool, technician, input)),
    );
    const retry = await createSubmission(pool, technician, input);

    const ids = new Set([...results, retry].map((r) => r.invoiceId));
    expect(ids.size).toBe(1);
    expect([...results, retry].filter((r) => r.created)).toHaveLength(1);

    const counts = await pool.query<{ invoices: number; jobs: number; payments: number }>(
      `SELECT
         (SELECT count(*)::int FROM invoices WHERE idempotency_key = $1) AS invoices,
         (SELECT count(*)::int FROM jobs j JOIN customers c ON c.id = j.customer_id
            WHERE c.phone_e164 = $2) AS jobs,
         (SELECT count(*)::int FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE i.idempotency_key = $1) AS payments`,
      [input.idempotencyKey, input.phone],
    );
    expect(counts.rows[0]).toEqual({ invoices: 1, jobs: 1, payments: 1 });
  });

  it('(d) re-running the seed never resets the counter or recreates accounts', async () => {
    const before = await counterState(pool);
    const usersBefore = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');

    for (let i = 0; i < 2; i++) {
      const result = await runSeed(pool, { pinPepper: TEST_PEPPER });
      expect(result.counterCreated).toBe(false);
      expect(result.accountsCreated).toEqual([]);
    }

    expect(await counterState(pool)).toEqual(before);
    const usersAfter = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    expect(usersAfter.rows[0]!.n).toBe(usersBefore.rows[0]!.n);
  });

  it('issues self-issued invoices with the flag set, and never re-numbers an issued invoice', async () => {
    const { invoiceId } = await createSubmission(pool, admin, makeSubmission());
    const first = await issueInvoice(pool, admin, invoiceId);
    expect(first.kind).toBe('issued');
    if (first.kind !== 'issued') return;
    expect(first.selfIssued).toBe(true);

    const again = await issueInvoice(pool, admin, invoiceId);
    expect(again.kind).toBe('already_issued');
    if (again.kind === 'already_issued') expect(again.invoiceNumber).toBe(first.invoiceNumber);
  });
});
