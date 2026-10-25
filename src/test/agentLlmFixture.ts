import { vi } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { createRequestBudget, type RequestBudget } from '../../supabase/functions/agent/core/budget.ts';
import { createToolContext } from '../../supabase/functions/agent/core/context.ts';
import { FIXTURE_TODAY, fixtureMarket, fixtureRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { complete, createTokenBudget, type LlmDeps } from '../../supabase/functions/agent/core/llm.ts';
import { buildModelPolicy } from '../../supabase/functions/agent/core/modelPolicy.ts';
import type { ChatMessage, ChatRequest, Lang } from '../../supabase/functions/agent/core/protocol.ts';
import type { MarketSource, PortfolioRepo } from '../../supabase/functions/agent/core/ports.ts';
import type { ToolCtx } from '../../supabase/functions/agent/core/types.ts';
import { toolPreferences } from './agentToolsFixture';

// Fake Groq/OpenRouter HTTP for agent tests: no live model is ever called.
export type SentBody = { model: string; messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { function: { name: string } }[]; max_completion_tokens: number; reasoning_effort?: string; provider?: unknown; models?: unknown };
export type ToolCallSpec = { name: string; arguments: unknown };

export function llmResponse(reply: { content?: string | null; toolCalls?: ToolCallSpec[]; usage?: { input: number; output: number } } = {}, status = 200, headers: Record<string, string> = {}) {
  const usage = reply.usage ?? { input: 400, output: 150 };
  return new Response(JSON.stringify({
    choices: [{ finish_reason: reply.toolCalls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: reply.content ?? null,
      ...(reply.toolCalls ? { tool_calls: reply.toolCalls.map((c, i) => ({ id: `call_${i}`, type: 'function',
        function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) } })) } : {}) } }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
  }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
export const rateLimited = (headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429, headers });

/** A scripted model endpoint: the handler sees the parsed request body and returns a Response. */
export function fakeModel(handler: (body: SentBody, call: number, init: RequestInit) => Response | Promise<Response>) {
  const bodies: SentBody[] = [], urls: string[] = [], signals: AbortSignal[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as SentBody;
    bodies.push(body); urls.push(String(input));
    if (init?.signal) signals.push(init.signal);
    return handler(body, bodies.length - 1, init ?? {});
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { fetchImpl, bodies, urls, signals };
}

/** A fetch that never answers until its signal aborts. */
export function hangingFetch() {
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { fetchImpl, signals };
}

// The router runs on gpt-oss-20b; since Běh 28 the news analyst may fall back to it too (its prompt names it).
export const isRouter = (body: SentBody) => body.model === 'openai/gpt-oss-20b' && !/^(?:News analyst|Research assistant)./.test(body.messages[0]?.content ?? '');
export const lastUser = (body: SentBody) => [...body.messages].reverse().find(m => m.role === 'user')?.content ?? '';
export const allText = (body: SentBody) => body.messages.map(m => m.content ?? '').join('\n');
/** Fact IDs the agent showed the model, read back from its evidence lines `[id] …`. */
export const shownFactIds = (body: SentBody) => [...allText(body).matchAll(/\[([a-z_]+:[^\]\s]+)\]/g)].map(m => m[1]);

export function routeReply(route: Partial<{ group: string; lang: Lang; tickers: string[]; analysis: boolean; clarify: boolean }>) {
  return llmResponse({ content: JSON.stringify({ group: 'valuace', lang: 'cs', tickers: [], analysis: false, clarify: false, ...route }), usage: { input: 300, output: 60 } });
}

export function budgetFor(ms = 45_000, signal = new AbortController().signal, now: () => number = Date.now): RequestBudget {
  const budget = createRequestBudget(now, signal);
  return ms === 45_000 ? budget : { ...budget, deadline: budget.startedAt + ms, remainingMs: () => Math.max(0, budget.startedAt + ms - now()) };
}

export function chatCtx(over: { user?: 'A' | 'B'; budget?: RequestBudget; market?: MarketSource; repo?: PortfolioRepo; lang?: Lang } = {}): ToolCtx {
  return createToolContext({ repo: over.repo ?? fixtureRepo(over.user ?? 'A'), market: over.market ?? fixtureMarket(), lib,
    budget: over.budget ?? budgetFor(), today: FIXTURE_TODAY, lang: over.lang ?? 'cs', preferences: toolPreferences });
}

export function llmDeps(fetchImpl: typeof fetch, over: Partial<LlmDeps> = {}): LlmDeps {
  return { complete, policy: buildModelPolicy(undefined), keys: { GROQ_API_KEY: 'synthetic' }, tokens: createTokenBudget(), fetchImpl, ...over };
}

let seq = 0;
export function chatRequest(question: string, lang?: Lang): ChatRequest {
  seq++;
  return { requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, question, ...(lang ? { lang } : {}) };
}
export function history(turns: [string, string][]): ChatMessage[] {
  return turns.flatMap(([q, a], i) => [
    { id: `u${i}`, requestId: `r${i}`, seq: i * 2, role: 'user' as const, content: q, lang: 'cs' as const, createdAt: '2026-10-23T10:00:00Z' },
    { id: `a${i}`, requestId: `r${i}`, seq: i * 2 + 1, role: 'assistant' as const, content: a, lang: 'cs' as const, createdAt: '2026-10-23T10:00:01Z' },
  ]);
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

// Anything a reader should never see: fact IDs, tool/field names, JSON, HTML.
export const TECHNICAL = /(\b[a-z]+:[A-Za-z0-9_.-]+:|\bget_[a-z_]+|\bcalculate\b|\bas_of\b|\bfactId\b|[{}[\]<>]|\b[a-z]+_[a-z_]+\b|price_cache|portfolio_model)/;
