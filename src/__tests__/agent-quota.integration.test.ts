// @vitest-environment node
import { expect, it } from 'vitest';
import { getTestDbConfig, TEST_DB_SKIP } from '../test/agentTestDb.ts';
import { createAgentDb } from '../../supabase/functions/agent/live/db.ts';
import { readContext, syntheticAnswer, syntheticMetrics, withTestDb } from '../../scripts/agent-test-db.ts';

const config = getTestDbConfig();
if (!config) console.info(TEST_DB_SKIP);
const live = it.skipIf(!config);

live('21 concurrent requests run one question for A (the rest busy, no quota spent); 20 in a row, then quota; B independent', async () => {
  await withTestDb(async s => {
    // Audit A1: one active question per user across threads, so a burst cannot multiply the shared load.
    const inputs = Array.from({ length: 21 }, () => s.input());
    const a = await Promise.all(inputs.map(input => s.users.A.db.begin(input, readContext())));
    expect(a.filter(r => r.kind === 'accepted')).toHaveLength(1);
    expect(a.filter(r => r.kind === 'busy')).toHaveLength(20);
    expect((await s.rest('A', `agent_daily_usage?user_id=eq.${s.users.A.id}&select=used`)).data).toEqual([{ used: 1 }]);
    // B is not blocked by A's running question.
    const b = s.input();
    expect((await s.users.B.db.begin(b, readContext())).kind).toBe('accepted');
    let running = inputs[a.findIndex(r => r.kind === 'accepted')];
    for (let n = 2; n <= 20; n++) {
      await s.expire('A', running.requestId);
      running = s.input();
      expect((await s.users.A.db.begin(running, readContext())).kind).toBe('accepted');
    }
    await s.expire('A', running.requestId);
    expect((await s.users.A.db.begin(s.input(), readContext())).kind).toBe('quota');
    expect((await s.rest('A', `agent_daily_usage?user_id=eq.${s.users.A.id}&select=used`)).data).toEqual([{ used: 20 }]);
  });
}, 240000);

live('duplicate request IDs accept once, changed payload conflicts, completion replays once', async () => {
  await withTestDb(async s => {
    const input = s.input();
    const results = await Promise.all([s.users.A.db.begin(input, readContext()), s.users.A.db.begin({ ...input, executionToken: crypto.randomUUID() }, readContext())]);
    expect(results.filter(r => r.kind === 'accepted')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'busy')).toHaveLength(1);
    for (const change of [{ question: 'Changed question' }, { lang: 'cs' as const }, { fingerprint: 'changed' }, { threadId: crypto.randomUUID() }]) {
      expect((await s.users.A.db.begin({ ...input, ...change }, readContext())).kind).toBe('conflict');
    }
    // The winning token is intentionally deterministic for this completion check (the first question ends first: one at a time).
    await s.expire('A', input.requestId);
    const next = s.input(); await s.users.A.db.begin(next, readContext());
    await s.users.A.db.complete({ ...next, answer: syntheticAnswer, metrics: syntheticMetrics }, readContext());
    await s.users.A.db.complete({ ...next, answer: syntheticAnswer, metrics: syntheticMetrics }, readContext());
    expect(await s.users.A.db.begin({ ...next, executionToken: crypto.randomUUID() }, readContext()))
      .toMatchObject({ kind: 'replay', answer: syntheticAnswer, remainingToday: 18 });
    const messages = await s.rest('A', `chat_messages?request_id=eq.${next.requestId}&select=role,seq&order=seq`);
    expect(messages.data).toEqual([{ role: 'user', seq: 1 }, { role: 'assistant', seq: 2 }]);
    expect((await s.rest('A', `agent_runs?request_id=eq.${next.requestId}&select=id`)).data).toHaveLength(1);
  });
}, 240000);

live('one active request per thread is busy without consuming quota; expired executors cannot overwrite', async () => {
  await withTestDb(async s => {
    const first = s.input(), reservation = await s.users.A.db.begin(first, readContext());
    if (reservation.kind !== 'accepted') throw new Error('Fixture reservation failed');
    const second = s.input(reservation.threadId);
    expect((await s.users.A.db.begin(second, readContext())).kind).toBe('busy');
    await expect(s.users.A.db.complete({ ...first, executionToken: crypto.randomUUID(), answer: syntheticAnswer, metrics: syntheticMetrics }, readContext())).rejects.toThrow();
    await s.expire('A', first.requestId);
    expect(await s.users.A.db.begin(second, readContext())).toMatchObject({ kind: 'accepted', remainingToday: 18 });
    await expect(s.users.A.db.complete({ ...first, answer: syntheticAnswer, metrics: syntheticMetrics }, readContext())).rejects.toThrow();
    await s.users.A.db.complete({ ...second, answer: syntheticAnswer, metrics: syntheticMetrics }, readContext());
    expect(await s.users.A.db.begin(first, readContext())).toMatchObject({ kind: 'replay', answer: { outcome: 'timeout', verified: true } });
    expect((await s.users.A.db.loadThread(reservation.threadId, readContext()))?.messages.map(m => m.seq)).toEqual([1, 2, 3]);
  });
}, 240000);

live('failed metric persistence rolls back the answer and never refunds quota, even after deletion/client reset', async () => {
  await withTestDb(async s => {
    const input = s.input(), reservation = await s.users.A.db.begin(input, readContext());
    if (reservation.kind !== 'accepted') throw new Error('Fixture reservation failed');
    await expect(s.users.A.db.complete({ ...input, answer: syntheticAnswer, metrics: { ...syntheticMetrics, tokensIn: 13000 } }, readContext())).rejects.toThrow();
    expect((await s.users.A.db.loadThread(reservation.threadId, readContext()))?.messages).toHaveLength(1);
    expect((await s.rest('A', `agent_runs?request_id=eq.${input.requestId}&select=id`)).data).toEqual([]);
    await s.users.A.db.deleteThread(reservation.threadId, readContext());
    expect((await s.users.A.db.begin(input, readContext())).kind).toBe('conflict');
    const reset = createAgentDb(s.users.A.client);
    expect(await reset.begin(s.input(), readContext())).toMatchObject({ kind: 'accepted', remainingToday: 18 });
    expect((await s.rest('A', `agent_daily_usage?user_id=eq.${s.users.A.id}&select=used`)).data).toEqual([{ used: 2 }]);
  });
}, 240000);
