// @vitest-environment node
import { expect, it } from 'vitest';
import { getTestDbConfig, TEST_DB_SKIP } from '../test/agentTestDb.ts';
import { readContext, syntheticAnswer, syntheticMetrics, withTestDb } from '../../scripts/agent-test-db.ts';

const config = getTestDbConfig();
if (!config) console.info(TEST_DB_SKIP);
const live = it.skipIf(!config);

live('B cannot read, update or delete A threads/messages/runs through real JWT REST and the adapter', async () => {
  await withTestDb(async s => {
    const input = s.input();
    const reservation = await s.users.A.db.begin(input, readContext());
    if (reservation.kind !== 'accepted') throw new Error('Fixture reservation failed');
    await s.users.A.db.complete({ ...input, answer: syntheticAnswer, metrics: syntheticMetrics }, readContext());
    expect((await s.users.A.db.loadThread(reservation.threadId, readContext()))?.messages).toHaveLength(2);
    expect(await s.users.B.db.loadThread(reservation.threadId, readContext())).toBeNull();
    for (const table of ['chat_threads', 'chat_messages', 'agent_runs']) {
      const filter = table === 'chat_threads' ? 'id' : 'thread_id';
      const read = await s.rest('B', `${table}?${filter}=eq.${reservation.threadId}&select=*`);
      expect(read.status).toBe(200); expect(read.data).toEqual([]);
      const deletion = await s.rest('B', `${table}?${filter}=eq.${reservation.threadId}`, 'DELETE');
      expect(deletion.status >= 400 || JSON.stringify(deletion.data) === '[]').toBe(true);
    }
    await s.users.B.db.deleteThread(reservation.threadId, readContext());
    const update = await s.rest('B', `chat_threads?id=eq.${reservation.threadId}`, 'PATCH', { title: 'Foreign edit' });
    expect(update.data).toEqual([]);
    expect((await s.users.A.db.loadThread(reservation.threadId, readContext()))?.thread.title).toBe(input.question);
    expect((await s.rest('A', `agent_runs?request_id=eq.${input.requestId}&select=id`)).data).toHaveLength(1);
  });
}, 240000);

live('rejects foreign message/run ownership links and all direct client reservation writes', async () => {
  await withTestDb(async s => {
    const reservation = await s.users.A.db.begin(s.input(), readContext());
    if (reservation.kind !== 'accepted') throw new Error('Fixture reservation failed');
    for (const table of ['chat_messages', 'agent_runs'] as const) {
      const result = await s.rest('B', table, 'POST', { user_id: s.users.B.id, thread_id: reservation.threadId,
        request_id: crypto.randomUUID(), seq: 99, role: 'user', content: 'Synthetic foreign message', lang: 'en' });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(await s.foreignLinkConstraint(table, reservation.threadId)).toEqual({ status: 409, code: '23503' });
    }
    for (const table of ['agent_requests', 'agent_daily_usage', 'agent_runs', 'chat_messages']) {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const result = await s.rest('A', `${table}?user_id=eq.${s.users.A.id}`, method, method === 'DELETE' ? undefined : { user_id: s.users.A.id });
        expect(result.status).toBeGreaterThanOrEqual(400);
      }
    }
    expect(await s.users.B.db.begin(s.input(reservation.threadId), readContext())).toEqual({ kind: 'conflict' });
  });
}, 240000);

live('anonymous REST has no chat/quota/cache reads or RPC execution', async () => {
  await withTestDb(async s => {
    for (const table of ['chat_threads', 'chat_messages', 'agent_runs', 'agent_requests', 'agent_daily_usage', 'stock_news', 'analyst_snapshots']) {
      expect((await s.rest('anon', `${table}?select=*`)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await s.rest('anon', 'rpc/begin_agent_request', 'POST', {
      p_request_id: crypto.randomUUID(), p_thread_id: null, p_question: 'Synthetic', p_lang: 'en',
      p_fingerprint: 'synthetic', p_execution_token: crypto.randomUUID(),
    })).status).toBeGreaterThanOrEqual(400);
  });
}, 240000);

live('allows only the owner to rename and delete history, and keeps quota after deletion', async () => {
  await withTestDb(async s => {
    const reservation = await s.users.A.db.begin(s.input(), readContext());
    if (reservation.kind !== 'accepted') throw new Error('Fixture reservation failed');
    expect((await s.rest('A', `chat_threads?id=eq.${reservation.threadId}`, 'PATCH', { title: 'Renamed synthetic thread' })).status).toBe(200);
    expect((await s.rest('A', `chat_threads?id=eq.${reservation.threadId}`, 'PATCH', { user_id: s.users.B.id })).status).toBeGreaterThanOrEqual(400);
    await s.users.A.db.deleteThread(reservation.threadId, readContext());
    expect(await s.users.A.db.loadThread(reservation.threadId, readContext())).toBeNull();
    expect((await s.rest('A', `agent_daily_usage?user_id=eq.${s.users.A.id}&select=used`)).data).toEqual([{ used: 1 }]);
    expect((await s.rest('B', `agent_daily_usage?user_id=eq.${s.users.A.id}&select=used`)).data).toEqual([]);
  });
}, 240000);
