// @vitest-environment node
import { expect, it } from 'vitest';
import { createAgentDb } from '../../supabase/functions/agent/live/db.ts';
import { fakeCaller } from '../test/agentDbFake.ts';
import type { RunMetrics, StoredAnswer } from '../../supabase/functions/agent/core/dataTypes.ts';

const ctx = () => ({ signal: new AbortController().signal, deadline: Date.now() + 45000 });
const input = { requestId: '11111111-1111-4111-8111-111111111111', question: 'Synthetic', lang: 'cs' as const,
  fingerprint: 'synthetic-fingerprint', executionToken: 'server-only-token' };
const answer: StoredAnswer = { text: 'Synthetic answer', links: [], trace: [], lang: 'cs', outcome: 'ok', verified: true };
const metrics: RunMetrics = { model: null, routerModel: null, tokensIn: 12, tokensOut: 3, maxCallTokens: 15,
  toolCalls: 1, toolsUsed: ['get_portfolio'], wallMs: 42, ttftMs: null, outcome: 'ok', groundingOk: true,
  calculationVersion: 'synthetic', errorCode: null };

it('maps only reservation RPC inputs and never accepts an owner from callers', async () => {
  const fake = fakeCaller(); fake.rpcResult.data = { kind: 'accepted', thread_id: 'thread', remaining_today: 19 };
  expect(await createAgentDb(fake.client).begin({ ...input, user_id: 'forged' } as typeof input, ctx()))
    .toEqual({ kind: 'accepted', threadId: 'thread', remainingToday: 19 });
  expect(fake.rpcCalls).toEqual([{ name: 'begin_agent_request', args: {
    p_request_id: input.requestId, p_thread_id: null, p_question: input.question, p_lang: 'cs',
    p_fingerprint: input.fingerprint, p_execution_token: input.executionToken,
  } }]);
});
it('maps replay and denial variants without exposing execution tokens', async () => {
  const fake = fakeCaller(), db = createAgentDb(fake.client);
  fake.rpcResult.data = { kind: 'replay', thread_id: 'thread', answer, remaining_today: 18, execution_token_hash: 'secret' };
  expect(await db.begin(input, ctx())).toEqual({ kind: 'replay', threadId: 'thread', answer, remainingToday: 18 });
  for (const kind of ['quota', 'busy', 'conflict']) {
    fake.rpcResult.data = { kind, retry_at: '2026-10-24T00:00:00Z' };
    expect(await db.begin(input, ctx())).toEqual({ kind, retryAt: '2026-10-24T00:00:00Z' });
  }
});
it('completes through the bounded RPC with snake_case metrics, not direct writes', async () => {
  const fake = fakeCaller();
  await createAgentDb(fake.client).complete({ requestId: input.requestId, executionToken: input.executionToken, answer, metrics }, ctx());
  expect(fake.rpcCalls[0]).toEqual({ name: 'complete_agent_request', args: { p_request_id: input.requestId,
    p_execution_token: input.executionToken, p_answer: answer, p_metrics: {
      model: null, router_model: null, tokens_in: 12, tokens_out: 3, max_call_tokens: 15, tool_calls: 1,
      tools_used: ['get_portfolio'], wall_ms: 42, ttft_ms: null, outcome: 'ok', grounding_ok: true,
      calculation_version: 'synthetic', error_code: null,
    } } });
  expect(fake.reads).toHaveLength(0);
});
it('rejects errors and malformed reservation results without echoing DB content', async () => {
  const fake = fakeCaller(), db = createAgentDb(fake.client);
  fake.rpcResult.error = { message: 'private' };
  await expect(db.begin(input, ctx())).rejects.toThrow('Database operation failed');
  await expect(db.complete({ ...input, answer, metrics }, ctx())).rejects.toThrow('Database operation failed');
  fake.rpcResult.error = null;
  for (const data of [null, {}, { kind: 'accepted', thread_id: 'x', remaining_today: -1 }, { kind: 'replay', thread_id: 'x', remaining_today: 1, answer: { verified: false } }]) {
    fake.rpcResult.data = data;
    await expect(db.begin(input, ctx())).rejects.toThrow('Invalid reservation');
  }
});
it('loads paged ordered history, returns null for an invisible thread and deletes only its ID', async () => {
  const fake = fakeCaller({ chat_threads: [{ id: 'thread', title: 'Synthetic', updated_at: 'now' }],
    chat_messages: Array.from({ length: 1001 }, (_, seq) => ({ id: `m${seq}`, thread_id: 'thread', request_id: `r${seq}`,
      seq, role: 'user', content: `synthetic ${seq}`, lang: 'cs', created_at: 'now' })) });
  const db = createAgentDb(fake.client);
  expect(await db.listThreads(ctx())).toEqual([{ id: 'thread', title: 'Synthetic', updatedAt: 'now' }]);
  const result = await db.loadThread('thread', ctx());
  expect(result?.messages).toHaveLength(1001);
  expect(fake.reads.filter(r => r.table === 'chat_messages').every(r => r.order.join(',') === 'seq')).toBe(true);
  expect(result?.messages.find(m => m.seq === 1000)).toEqual({ id: 'm1000', requestId: 'r1000', seq: 1000, role: 'user', content: 'synthetic 1000', lang: 'cs', createdAt: 'now' });
  expect(await db.loadThread('foreign', ctx())).toBeNull();
  // Deletion runs in delete_agent_thread (the caller's lock, no direct DELETE); its boolean is the answer.
  fake.rpcResult.data = false;
  expect(await db.deleteThread('foreign', ctx())).toBe(false);
  fake.rpcResult.data = true;
  expect(await db.deleteThread('thread', ctx())).toBe(true);
  expect(fake.rpcCalls.filter(c => c.name === 'delete_agent_thread').map(c => c.args)).toEqual([{ p_thread_id: 'foreign' }, { p_thread_id: 'thread' }]);
});
it('audit A8: returns an answer\'s stored https links with the history and drops anything else', async () => {
  const fake = fakeCaller({ chat_threads: [{ id: 'thread', title: 'Synthetic', updated_at: 'now' }],
    chat_messages: [
      { id: 'q', thread_id: 'thread', request_id: 'r', seq: 1, role: 'user', content: 'otázka', lang: 'cs', created_at: 'now', links: [] },
      { id: 'a', thread_id: 'thread', request_id: 'r', seq: 2, role: 'assistant', content: 'odpověď', lang: 'cs', created_at: 'now',
        links: [{ url: 'https://example.com/a', title: 'A' }, { url: 'javascript:alert(1)', title: 'x' }, { url: 'https://example.com/b' }, 'junk'] }] });
  const result = await createAgentDb(fake.client).loadThread('thread', ctx());
  expect(result?.messages[0]).not.toHaveProperty('links');
  expect(result?.messages[1].links).toEqual([{ url: 'https://example.com/a', title: 'A' }]);
});
