// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { FIXTURE_TODAY, fixtureMarket, fixtureRepo } from '../../supabase/functions/agent/core/fixture.ts';
import type { AgentDb } from '../../supabase/functions/agent/core/ports.ts';
import type { AgentEvent, ChatRequest } from '../../supabase/functions/agent/core/protocol.ts';
import { makeHandler } from '../../supabase/functions/agent/handler.ts';
import { readAgentConfig } from '../../supabase/functions/agent/config.ts';
import { createAgentRoutes, createChatService, type EvalAudit } from '../../supabase/functions/agent/service.ts';
import { createMemoryAgentStore } from '../test/agentMemoryDb';
import { allText, budgetFor, collect, fakeModel, isRouter, llmDeps, llmResponse, rateLimited, routeReply } from '../test/agentLlmFixture';

const USER = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jwt: 'synthetic-a' };
let seq = 0;
const rid = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const ask = (question: string, over: Partial<ChatRequest> = {}): ChatRequest => ({ requestId: rid(), question, lang: 'cs', ...over });
const types = (events: AgentEvent[]) => events.map(e => e.type);
const answerOf = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer');
const errorOf = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
const doneOf = (events: AgentEvent[]) => events.at(-1) as Extract<AgentEvent, { type: 'done' }>;

/** A model that routes, then writes nothing usable: every answer ends as the verified template. */
const plainModel = (log: string[] = []) => fakeModel(body => {
  log.push(isRouter(body) ? 'router' : 'model');
  return isRouter(body) ? routeReply({ group: 'portfolio', lang: 'cs' }) : llmResponse({ content: 'bez JSON' });
});

function setup(over: { db?: AgentDb; fetchImpl?: typeof fetch; audit?: (id: string, a: EvalAudit) => void } = {}) {
  const store = createMemoryAgentStore();
  const model = plainModel();
  const db = over.db ?? store.forUser(USER.id);
  const service = createChatService({ db, repo: fixtureRepo('A'), market: fixtureMarket(), lib, llm: llmDeps(over.fetchImpl ?? model.fetchImpl),
    today: () => FIXTURE_TODAY, ...(over.audit ? { audit: over.audit } : {}) });
  const run = (input: ChatRequest, budget = budgetFor()) => collect(service(input, USER, budget));
  return { store, db, model, service, run };
}

describe('chat service', () => {
  it('sends meta, then status; reserves before the only model request and stores before answer/done', async () => {
    const log: string[] = [];
    const store = createMemoryAgentStore();
    const inner = store.forUser(USER.id);
    const db: AgentDb = { ...inner,
      async begin(input, ctx) { log.push('begin'); return inner.begin(input, ctx); },
      async complete(input, ctx) {
        log.push('complete:start');
        await new Promise(resolve => setTimeout(resolve, 20));
        await inner.complete(input, ctx);
        log.push('complete:end');
      } };
    const model = plainModel(log);
    const service = createChatService({ db, repo: fixtureRepo('A'), market: fixtureMarket(), lib, llm: llmDeps(model.fetchImpl), today: () => FIXTURE_TODAY });
    const events: AgentEvent[] = [];
    for await (const event of service(ask('Kolik mám v portfoliu?'), USER, budgetFor())) { events.push(event); log.push(`event:${event.type}`); }
    expect(types(events).slice(0, 2)).toEqual(['meta', 'status']);
    expect(events[0]).toMatchObject({ type: 'meta', remainingToday: 19 });
    expect(log.indexOf('begin')).toBeLessThan(log.indexOf('router'));
    expect(log.indexOf('complete:end')).toBeLessThan(log.indexOf('event:answer'));
    expect(log.filter(l => l.startsWith('event:answer'))).toHaveLength(1);
    expect(doneOf(events)).toMatchObject({ persisted: true, outcome: 'fallback' });
    // The fallback tools' trace reaches the client before the answer, with human labels only.
    const traceAt = events.map(e => e.type).lastIndexOf('trace');
    expect(traceAt).toBeGreaterThan(-1);
    expect(traceAt).toBeLessThan(events.findIndex(e => e.type === 'answer'));
    expect(JSON.stringify(events[traceAt])).not.toMatch(/get_|portfolio_model/);
    expect(store.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ outcome: 'fallback' });
  });

  it('an exact retry of a completed request replays the same text without a model, message or quota', async () => {
    const { store, model, run } = setup();
    const input = ask('Kolik mám v portfoliu?');
    const first = await run(input);
    const calls = model.fetchImpl.mock.calls.length;
    const again = await run(input);
    expect(answerOf(again)?.text).toBe(answerOf(first)?.text);
    expect(model.fetchImpl.mock.calls.length).toBe(calls);
    expect(store.messages).toHaveLength(2);
    expect(store.usedToday(USER.id)).toBe(1);
    expect(again[0]).toMatchObject({ type: 'meta', remainingToday: 19 });
    expect(doneOf(again)).toMatchObject({ persisted: true, outcome: 'fallback' });
  });

  it('a second request in a busy thread is a conflict, and the history is not interleaved', async () => {
    const { store, run } = setup();
    const first = await run(ask('Kolik mám v portfoliu?'));
    const threadId = (first[0] as Extract<AgentEvent, { type: 'meta' }>).threadId;
    // A request of the same thread is still running elsewhere (another panel).
    await store.forUser(USER.id).begin({ requestId: rid(), threadId, question: 'Jiný panel', lang: 'cs', fingerprint: 'x', executionToken: 'y'.repeat(40) },
      { signal: new AbortController().signal, deadline: Date.now() + 1000 });
    const second = await run(ask('A dividendy?', { threadId }));
    expect(errorOf(second)).toMatchObject({ code: 'conflict' });
    expect(errorOf(second)?.retryAt).toMatch(/^\d{4}-/);
    expect(answerOf(second)).toBeUndefined();
    expect(doneOf(second)).toMatchObject({ persisted: false, outcome: 'error' });
    expect(store.messages.filter(m => m.threadId === threadId).map(m => m.content)).toEqual(['Kolik mám v portfoliu?', expect.any(String), 'Jiný panel']);
  });

  it('the same request ID with another question is a conflict, never a new run', async () => {
    const { store, model, run } = setup();
    const input = ask('Kolik mám v portfoliu?');
    await run(input);
    const calls = model.fetchImpl.mock.calls.length;
    const events = await run({ ...input, question: 'Úplně jiná otázka' });
    expect(errorOf(events)).toMatchObject({ code: 'conflict' });
    expect(model.fetchImpl.mock.calls.length).toBe(calls);
    expect(store.usedToday(USER.id)).toBe(1);
  });

  it('a failed completion still sends the verified answer with persisted=false and a notice; the quota stays used', async () => {
    const { store, run } = setup();
    store.failCompletion(true);
    const events = await run(ask('Kolik mám v portfoliu?'));
    expect(answerOf(events)?.verified).toBe(true);
    expect(events.some(e => e.type === 'status' && /uložit|save/i.test(e.text))).toBe(true);
    expect(doneOf(events)).toMatchObject({ persisted: false, outcome: 'fallback' });
    expect(store.usedToday(USER.id)).toBe(1);
  });

  it('a daily quota ends with a human quota error and its reset time, before any model', async () => {
    const { store, model, run } = setup();
    // Use up the day through the store itself.
    for (let i = 0; i < 20; i++) await store.forUser(USER.id).begin({ requestId: rid(), question: `q${i}`, lang: 'cs', fingerprint: 'f', executionToken: 'x'.repeat(40) },
      { signal: new AbortController().signal, deadline: Date.now() + 1000 });
    const events = await run(ask('Kolik mám v portfoliu?'));
    expect(errorOf(events)).toMatchObject({ code: 'quota' });
    expect(errorOf(events)?.retryAt).toBeTruthy();
    expect(doneOf(events)).toMatchObject({ outcome: 'quota', persisted: false });
    expect(model.fetchImpl).not.toHaveBeenCalled();
  });

  it('passes only the last four stored messages of the thread to the model, never the new question twice', async () => {
    const { store, run } = setup();
    const first = await run(ask('Otázka jedna?'));
    const threadId = (first[0] as Extract<AgentEvent, { type: 'meta' }>).threadId;
    await run(ask('Otázka dvě?', { threadId }));
    await run(ask('Otázka tři?', { threadId }));
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio' }) : llmResponse({ content: 'bez JSON' }));
    const service = createChatService({ db: store.forUser(USER.id), repo: fixtureRepo('A'), market: fixtureMarket(), lib, llm: llmDeps(model.fetchImpl), today: () => FIXTURE_TODAY });
    await collect(service(ask('Otázka čtyři?', { threadId }), USER, budgetFor()));
    // The router sees the four latest stored messages verbatim; the writer at most those four (fitted to its budget).
    const router = model.bodies.find(isRouter)!;
    const history = router.messages.filter(m => m.role !== 'system').slice(0, -1).map(m => m.content);
    expect(history).toHaveLength(4);
    expect(history[0]).toBe('Otázka dvě?');
    const main = model.bodies.find(b => !isRouter(b))!;
    expect(main.messages.filter(m => m.role !== 'system').length - 1).toBeLessThanOrEqual(4);
    for (const body of [router, main]) expect(body.messages.filter(m => m.content?.includes('Otázka čtyři?'))).toHaveLength(1);
    expect(allText(main)).not.toContain('Otázka jedna?');
  });

  it('rejects invalid preferences before reserving anything', async () => {
    const { store, run } = setup();
    const events = await run({ ...ask('Kolik mám?'), preferences: { displayCurrency: 'XXX' } as never });
    expect(errorOf(events)).toMatchObject({ code: 'invalid' });
    expect(store.requests).toHaveLength(0);
  });

  it('all models rate-limited with no data is stored as a human error and replays as one', async () => {
    const { store, run } = setup({ fetchImpl: fakeModel(() => rateLimited()).fetchImpl });
    const input = ask('Ahoj, jak se máš?');
    const events = await run(input);
    expect(doneOf(events).persisted).toBe(true);
    const replay = await run(input);
    expect(types(replay)).toEqual(types(events).filter(t => t !== 'status' && t !== 'trace'));
    expect(store.usedToday(USER.id)).toBe(1);
  });

  it('reports an evaluation audit with the facts and calculations of the request', async () => {
    const audits = new Map<string, EvalAudit>();
    const { run } = setup({ audit: (id, a) => audits.set(id, a) });
    const input = ask('Kolik mám v portfoliu?');
    await run(input);
    const audit = audits.get(input.requestId)!;
    expect(audit.facts.length).toBeGreaterThan(0);
    expect(audit.snapshotId).toBe('fixture-A');
    expect(audit.toolsUsed.length + audit.metrics.toolCalls).toBeGreaterThan(0);
    const attempts = audit.metrics.attempts!;
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.at(-1)).toMatchObject({ phase: 'repair', outcome: 'invalid', rejectionReasons: ['not_object'] });
    expect(attempts.reduce((sum, a) => sum + a.chargedInput, 0)).toBe(audit.metrics.tokensIn);
    expect(attempts.reduce((sum, a) => sum + a.chargedOutput, 0)).toBe(audit.metrics.tokensOut);
    const dispatch = createAgentRoutes({ db: setup().db, directTools: null, evalAudit: id => audits.get(id) ?? null });
    const response = await dispatch(new Request(`http://127.0.0.1/agent/eval/runs/${input.requestId}`), USER, budgetFor());
    expect((await response!.json()).metrics.attempts).toEqual(attempts);
  });
});

describe('thread and tool routes', () => {
  async function routes(directTools = false) {
    const store = createMemoryAgentStore();
    const db = store.forUser(USER.id);
    const service = createChatService({ db, repo: fixtureRepo('A'), market: fixtureMarket(), lib, llm: llmDeps(plainModel().fetchImpl), today: () => FIXTURE_TODAY });
    const first = await collect(service(ask('Kolik mám v portfoliu?'), USER, budgetFor()));
    const threadId = (first[0] as Extract<AgentEvent, { type: 'meta' }>).threadId;
    const dispatch = createAgentRoutes({ db, directTools: directTools
      ? { context: budget => ({ repo: fixtureRepo('A'), market: fixtureMarket(), lib, budget, today: FIXTURE_TODAY, lang: 'cs',
        preferences: { displayCurrency: 'USD', localCurrency: 'CZK', tax: { fxMethod: 'cnb-daily', limitIncludesExempt: true } } }) } : null });
    return { store, threadId, dispatch: (req: Request) => dispatch(req, USER, budgetFor()) };
  }

  it('lists, loads and deletes own threads; a foreign or unknown ID is 404', async () => {
    const { threadId, dispatch, store } = await routes();
    const list = await dispatch(route('GET', '/agent/threads'));
    expect(list?.status).toBe(200);
    expect((await list!.json()).threads).toEqual([expect.objectContaining({ id: threadId })]);
    const history = await (await dispatch(route('GET', `/functions/v1/agent/threads/${threadId}`)))!.json();
    expect(history.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    store.threads.push({ id: '99999999-9999-4999-8999-999999999999', userId: 'someone-else', title: 'cizí', updatedAt: '2026-01-01' });
    expect((await dispatch(route('GET', '/agent/threads/99999999-9999-4999-8999-999999999999')))?.status).toBe(404);
    expect((await dispatch(route('DELETE', '/agent/threads/99999999-9999-4999-8999-999999999999')))?.status).toBe(404);
    expect((await dispatch(route('GET', '/agent/threads/not-a-uuid')))?.status).toBe(404);
    expect((await dispatch(route('DELETE', `/agent/threads/${threadId}`)))?.status).toBe(204);
    expect((await dispatch(route('GET', `/agent/threads/${threadId}`)))?.status).toBe(404);
    expect(store.threads.map(t => t.userId)).toEqual(['someone-else']);
  });

  it('exposes tool schemas; direct tool calls are 404 unless explicitly enabled', async () => {
    const off = await routes(false);
    const schemas = await (await off.dispatch(route('GET', '/agent/tools')))!.json();
    expect(schemas.tools.map((t: { name: string }) => t.name)).toContain('get_quote');
    const call = { requestId: rid(), args: { ticker: 'SYNA' } };
    expect(await off.dispatch(route('POST', '/agent/tools/get_quote', call))).toBeNull();
    const on = await routes(true);
    const result = await (await on.dispatch(route('POST', '/agent/tools/get_quote', call)))!.json();
    expect(result.ok).toBe(true);
    expect((await on.dispatch(route('POST', '/agent/tools/get_quote', { args: {} })))?.status).toBe(400);
    expect(await on.dispatch(route('POST', '/agent/tools/get_broker_key', call))).toBeNull();
    expect(await on.dispatch(route('GET', '/agent/nothing'))).toBeNull();
  });
});

describe('feature flags', () => {
  it('the server flag defaults to off and needs an explicit true', () => {
    expect(readAgentConfig(() => undefined)).toMatchObject({ enabled: false, directTools: false });
    expect(readAgentConfig(k => ({ AGENT_ENABLED: 'TRUE' } as Record<string, string>)[k]).enabled).toBe(false);
    expect(readAgentConfig(k => ({ AGENT_ENABLED: 'true', AGENT_DIRECT_TOOLS_ENABLED: 'true' } as Record<string, string>)[k])).toMatchObject({ enabled: true, directTools: true });
  });

  it('a disabled agent answers 503 before authentication, reservation or models', async () => {
    const authenticate = vi.fn(async () => USER);
    const chat = vi.fn();
    const dispatch = vi.fn();
    const handler = makeHandler({ enabled: false, authenticate, chat, dispatch, now: Date.now, allowedOrigins: [] });
    for (const req of [route('POST', '/agent/chat', ask('Kolik?')), route('GET', '/agent/threads')]) {
      const response = await handler(req);
      expect(response.status).toBe(503);
      expect((await response.json()).text).toBeTruthy();
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('the enabled handler dispatches other routes only after authentication, null meaning 404', async () => {
    const authenticate = vi.fn(async (req: Request) => req.headers.get('Authorization') ? USER : null);
    const dispatch = vi.fn(async (req: Request) => new URL(req.url).pathname.endsWith('/threads') ? new Response('{"threads":[]}', { status: 200 }) : null);
    const handler = makeHandler({ authenticate, chat: vi.fn(), dispatch, now: Date.now, allowedOrigins: ['http://localhost:8080'] });
    expect((await handler(new Request('http://localhost/agent/threads'))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
    const ok = await handler(new Request('http://localhost/functions/v1/agent/threads', { headers: { Authorization: 'Bearer x', Origin: 'http://localhost:8080' } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8080');
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect((await handler(new Request('http://localhost/agent/unknown', { headers: { Authorization: 'Bearer x' } }))).status).toBe(404);
    const preflight = await handler(new Request('http://localhost/agent/threads/x', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080' } }));
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});

function route(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
}
