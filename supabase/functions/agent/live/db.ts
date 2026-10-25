import type { Reservation, StoredAnswer, Thread, ReadContext } from '../core/dataTypes.ts';
import type { Link } from '../core/protocol.ts';
import type { AgentDb, CallerDbClient } from '../core/ports.ts';
import { readWithinDeadline, scanRows } from './paging.ts';

function isAnswer(value: unknown): value is StoredAnswer {
  if (!value || typeof value !== 'object') return false;
  const a = value as StoredAnswer;
  return a.verified === true && typeof a.text === 'string' && Array.isArray(a.links) && Array.isArray(a.trace)
    && ['cs', 'sk', 'en'].includes(a.lang) && ['ok', 'fallback', 'timeout', 'error'].includes(a.outcome);
}
function reservation(value: unknown): Reservation {
  if (!value || typeof value !== 'object') throw new Error('Invalid reservation');
  const r = value as Record<string, unknown>;
  if (r.kind === 'accepted' || r.kind === 'replay') {
    if (typeof r.thread_id !== 'string' || !Number.isInteger(r.remaining_today) || Number(r.remaining_today) < 0
      || Number(r.remaining_today) > 20) throw new Error('Invalid reservation');
    const common = { threadId: r.thread_id, remainingToday: Number(r.remaining_today) };
    if (r.kind === 'accepted') return { kind: 'accepted', ...common };
    if (!isAnswer(r.answer)) throw new Error('Invalid reservation');
    return { kind: 'replay', ...common, answer: r.answer };
  }
  if (r.kind === 'busy' || r.kind === 'quota' || r.kind === 'conflict') {
    return { kind: r.kind, ...(typeof r.retry_at === 'string' ? { retryAt: r.retry_at } : {}), ...(r.kind === 'quota' && r.scope === 'shared' ? { scope: 'shared' as const } : {}) };
  }
  throw new Error('Invalid reservation');
}
/** Stored links as written by the verified answer; anything else in the column is dropped. */
const storedLinks = (value: unknown): Link[] => Array.isArray(value) ? value.flatMap(l => l && typeof l === 'object'
  && typeof (l as Link).url === 'string' && /^https:\/\//.test((l as Link).url) && typeof (l as Link).title === 'string'
  ? [{ url: (l as Link).url, title: (l as Link).title }] : []).slice(0, 50) : [];
const thread = (row: Record<string, unknown>): Thread => ({ id: String(row.id), title: String(row.title), updatedAt: String(row.updated_at) });

export function createAgentDb(client: CallerDbClient): AgentDb {
  async function rpc(name: 'begin_agent_request' | 'complete_agent_request' | 'delete_agent_thread', args: Record<string, unknown>, ctx: ReadContext): Promise<unknown> {
    const result = await readWithinDeadline(signal => client.rpc(name, args).abortSignal(signal), ctx);
    if (result.error) throw new Error('Database operation failed');
    return result.data;
  }
  return {
    async begin(input, ctx) {
      return reservation(await rpc('begin_agent_request', {
        p_request_id: input.requestId, p_thread_id: input.threadId ?? null, p_question: input.question,
        p_lang: input.lang, p_fingerprint: input.fingerprint, p_execution_token: input.executionToken,
      }, ctx));
    },
    async complete(input, ctx) {
      const m = input.metrics;
      await rpc('complete_agent_request', { p_request_id: input.requestId, p_execution_token: input.executionToken,
        p_answer: input.answer, p_metrics: { model: m.model, router_model: m.routerModel, tokens_in: m.tokensIn,
          tokens_out: m.tokensOut, max_call_tokens: m.maxCallTokens, tool_calls: m.toolCalls, tools_used: m.toolsUsed,
          wall_ms: m.wallMs, ttft_ms: m.ttftMs, outcome: m.outcome, grounding_ok: m.groundingOk,
          calculation_version: m.calculationVersion, error_code: m.errorCode } }, ctx);
    },
    async listThreads(ctx) {
      const result = await scanRows(() => client.from('chat_threads').select('id,title,updated_at', { count: 'exact' }), ['updated_at', 'id'], ctx);
      if (result.changed) throw new Error('History changed during read');
      return result.rows.map(thread).reverse();
    },
    async loadThread(id, ctx) {
      const rows = await scanRows(() => client.from('chat_threads').select('id,title,updated_at', { count: 'exact' }).eq('id', id), ['id'], ctx);
      if (rows.changed) throw new Error('History changed during read');
      if (!rows.rows.length) return null;
      const messages = await scanRows(() => client.from('chat_messages')
        .select('id,request_id,seq,role,content,lang,created_at,links', { count: 'exact' }).eq('thread_id', id), ['seq'], ctx);
      if (messages.changed) throw new Error('History changed during read');
      return { thread: thread(rows.rows[0]), messages: messages.rows.map(r => {
        const links = r.role === 'assistant' ? storedLinks(r.links) : [];
        return { id: String(r.id), requestId: String(r.request_id), seq: Number(r.seq), role: r.role as 'user' | 'assistant',
          content: String(r.content), lang: r.lang as 'cs' | 'sk' | 'en', createdAt: String(r.created_at), ...(links.length ? { links } : {}) };
      }) };
    },
    async deleteThread(id, ctx) {
      // Under the caller's lock (delete_agent_thread); a foreign or missing thread is the same false → 404.
      return await rpc('delete_agent_thread', { p_thread_id: id }, ctx) === true;
    },
  };
}
