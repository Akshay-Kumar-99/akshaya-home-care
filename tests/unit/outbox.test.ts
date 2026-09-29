import { describe, expect, it } from 'vitest';
import { MemoryOutboxStore, Outbox, type SendOutcome, type SubmissionPayload } from '../../src/web/lib/outbox.ts';

function payload(key: string): SubmissionPayload {
  return {
    idempotencyKey: key,
    phone: '+919841459657',
    customerName: 'Ravi',
    areaId: null,
    applianceTypeKey: 'ac_split',
    brandId: null,
    serviceDescription: 'Gas refilling',
    totalRupees: 2300,
    spareCostRupees: 800,
    confirmNegativeMargin: false,
    payment: { status: 'paid', mode: 'upi' },
  };
}

function item(key: string, userId = 'tech-1') {
  return {
    key,
    userId,
    payload: payload(key),
    summary: { customerName: 'Ravi', applianceLabel: 'AC (split)', totalRupees: 2300, spareCostRupees: 800 },
  };
}

/** A fake server whose next responses we script. */
function server(script: SendOutcome[]) {
  const sent: string[] = [];
  const send = async (p: SubmissionPayload): Promise<SendOutcome> => {
    const outcome = script.shift() ?? 'sent';
    sent.push(`${p.idempotencyKey}:${outcome}`);
    return outcome;
  };
  return { send, sent };
}

describe('offline outbox', () => {
  it('removes a job once the server confirms it', async () => {
    const { send } = server(['sent']);
    const outbox = new Outbox(new MemoryOutboxStore(), send);
    expect(await outbox.add(item('a'))).toBe('sent');
    expect(await outbox.items('tech-1')).toEqual([]);
  });

  it('keeps a job while offline and sends it later with the SAME idempotency key', async () => {
    const { send, sent } = server(['retry', 'retry', 'sent']);
    const outbox = new Outbox(new MemoryOutboxStore(), send);
    expect(await outbox.add(item('a'))).toBe('retry');
    const [queued] = await outbox.items('tech-1');
    expect(queued).toMatchObject({ key: 'a', status: 'pending', attempts: 1 });

    await outbox.flush('tech-1');
    await outbox.flush('tech-1');
    expect(await outbox.items('tech-1')).toEqual([]);
    expect(sent).toEqual(['a:retry', 'a:retry', 'a:sent']);
  });

  it('treats a thrown network error like a retry, never losing the job', async () => {
    const outbox = new Outbox(new MemoryOutboxStore(), async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await outbox.add(item('a'))).toBe('retry');
    expect(await outbox.items('tech-1')).toHaveLength(1);
  });

  it('marks a job the server refused as needing fixing, and stops re-sending it', async () => {
    const { send, sent } = server(['rejected']);
    const outbox = new Outbox(new MemoryOutboxStore(), send);
    expect(await outbox.add(item('a'))).toBe('rejected');
    await outbox.flush('tech-1');
    expect(sent).toEqual(['a:rejected']);
    expect((await outbox.items('tech-1'))[0]).toMatchObject({ status: 'failed' });
    await outbox.discard('a');
    expect(await outbox.items('tech-1')).toEqual([]);
  });

  it('sends oldest first and stops at the first network failure', async () => {
    const store = new MemoryOutboxStore();
    const { send, sent } = server(['retry', 'retry', 'sent', 'sent']);
    const outbox = new Outbox(store, send);
    await outbox.add(item('first'));
    await new Promise((r) => setTimeout(r, 2));
    await outbox.add(item('second'));
    expect(sent).toEqual(['first:retry', 'first:retry']);
    await outbox.flush('tech-1');
    expect(sent.slice(2)).toEqual(['first:sent', 'second:sent']);
  });

  it('never sends another user\'s queued jobs from a shared phone', async () => {
    const store = new MemoryOutboxStore();
    const first = new Outbox(store, async () => 'retry');
    await first.add(item('theirs', 'tech-2'));
    const { send, sent } = server([]);
    const outbox = new Outbox(store, send);
    await outbox.flush('tech-1');
    expect(sent).toEqual([]);
    expect(await outbox.items('tech-2')).toHaveLength(1);
    expect(await outbox.items('tech-1')).toEqual([]);
  });

  it('runs one flush at a time (no double sends from overlapping triggers)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const outbox = new Outbox(new MemoryOutboxStore(), async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 'retry';
    });
    await outbox.add(item('a'));
    await Promise.all([outbox.flush('tech-1'), outbox.flush('tech-1'), outbox.flush('tech-1')]);
    expect(maxInFlight).toBe(1);
  });
});
