// @vitest-environment node
import { expect, it } from 'vitest';
import { makeEdgeTestHandler } from '../test/agentEdgeHandler';
import { createMemoryAgentStore } from '../test/agentMemoryDb';
import { readWithinDeadline } from '../../supabase/functions/agent/live/paging.ts';
import { runGatewaySmoke } from '../../scripts/agent-gateway-smoke.ts';

it('Deno runner uses persistent chat, caller history, epoch deadlines and own-thread cleanup', async () => {
  const store = createMemoryAgentStore();
  let reads = 0;
  const handler = makeEdgeTestHandler({ now: Date.now,
    authenticate: async req => {
      const jwt = req.headers.get('Authorization')?.slice(7);
      return jwt === 'a' || jwt === 'b' ? { id: jwt, jwt } : null;
    },
    dbFor: user => {
      const db = store.forUser(user.id);
      return { ...db, listThreads: ctx => readWithinDeadline(() => { reads++; return db.listThreads(ctx); }, ctx) };
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => handler(new Request(String(input), init));
  for (const [jwtA, jwtB] of [['a', 'b'], ['b', 'a']]) {
    const result = await runGatewaySmoke({ base: 'http://127.0.0.1/agent', jwtA, jwtB, fetchImpl });
    expect(Object.values(result.checks)).toEqual(Array(6).fill('PASS'));
    const response = await fetchImpl('http://127.0.0.1/agent/threads', { headers: { Authorization: `Bearer ${jwtA}` } });
    expect(await response.json()).toEqual({ threads: [] });
    // Deleting history must not refund the smoke question's daily quota.
    expect(store.usedToday(jwtA)).toBe(1);
  }
  expect(reads).toBeGreaterThanOrEqual(4);
});
