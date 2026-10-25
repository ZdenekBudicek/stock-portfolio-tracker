import { makeHandler } from './handler.ts';
import { verifyUser } from './live/auth.ts';
import { createRequestBudget, withTimeout } from './core/budget.ts';
import * as lib from './_lib/trackora-lib.js';
import { computeWithinLimits } from './core/calculations.ts';
import manifest from './_lib/manifest.json' with { type: 'json' };
import { readAllPages } from './live/paging.ts';
import { createAgentDb } from './live/db.ts';
import { createPortfolioRepo } from './live/repo.ts';
import { createMarketSource } from './live/market.ts';
import { createToolContext } from './core/context.ts';
import { FIXTURE_TODAY, fixtureMarket, fixtureRepo } from './core/fixture.ts';
import { executeTool, exportToolSchemas } from './core/registry.ts';
import { runChat } from './core/agent.ts';
import { complete, createTokenBudget } from './core/llm.ts';
import { buildModelPolicy } from './core/modelPolicy.ts';
import type { AgentDb, CallerDbClient, CallerQuery, DbResult } from './core/ports.ts';
import { createAgentRoutes, createChatService } from './service.ts';
import { readAgentConfig } from './config.ts';

function assert(value: unknown): asserts value { if (!value) throw new Error('Assertion failed'); }
Deno.test('caller repository is portable, request-local and immutable', async () => {
  let reads = 0;
  const query: CallerQuery = {
    select() { return query; }, order() { return query; }, range() { return query; }, eq() { return query; }, abortSignal() { return query; },
    then(resolve, reject) { reads++; return Promise.resolve<DbResult>({ data: [], error: null, count: 0 }).then(resolve, reject); },
  };
  const client: CallerDbClient = { from() { return { select: () => query, delete: () => query }; },
    rpc(name) { return { abortSignal: () => Promise.resolve({ error: null, data: name === 'get_broker_connection_status'
      ? [] : { kind: 'accepted', thread_id: 'synthetic', remaining_today: 19 } }) }; } };
  const ctx = { signal: new AbortController().signal, deadline: Date.now() + 45000 };
  const repo = createPortfolioRepo(client);
  const a = await repo.load(ctx), count = reads;
  assert(await repo.load(ctx) === a && reads === count);
  assert(Object.isFrozen(a.data.positions) && a.meta.complete && a.meta.snapshotId.length === 64);
  const reservation = await createAgentDb(client).begin({ requestId: 'synthetic', question: 'Synthetic', lang: 'en', fingerprint: 'synthetic', executionToken: 'synthetic' }, ctx);
  assert(reservation.kind === 'accepted' && reservation.remainingToday === 19);
});
Deno.test('paged reads retain 2501 rows and reject second-page errors', async () => {
  const ctx = { signal: new AbortController().signal, deadline: Date.now() + 45000 };
  const rows = Array.from({ length: 2501 }, (_, id) => ({ id }));
  assert((await readAllPages(async (from, to) => ({ data: rows.slice(from, to + 1), error: null }), ctx)).length === 2501);
  let failed = false;
  try {
    await readAllPages(async (from, to) => ({ data: rows.slice(from, to + 1), error: from === 1000 ? 'synthetic failure' : null }), ctx);
  } catch { failed = true; }
  assert(failed);
});
Deno.test('market source reads pinned providers with Deno fetch semantics and never Yahoo', async () => {
  const query: CallerQuery = {
    select() { return query; }, order() { return query; }, range() { return query; }, eq() { return query; }, abortSignal() { return query; },
    then(resolve, reject) { return Promise.resolve<DbResult>({ data: [], error: null, count: 0 }).then(resolve, reject); },
  };
  const client: CallerDbClient = { from() { return { select: () => query, delete: () => query }; },
    rpc() { return { abortSignal: () => Promise.resolve({ error: null, data: null }) }; } };
  const hosts: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    hosts.push(new URL(String(url)).hostname);
    return Promise.resolve(new Response(JSON.stringify({ c: 151, pc: 150, dp: null, t: 1792670400 })));
  }) as typeof fetch;
  const source = createMarketSource(client, { fetchImpl, now: Date.now, keys: { FINNHUB_API_KEY: 'synthetic' } });
  const quote = await source.quote('RKLB', { signal: new AbortController().signal, deadline: Date.now() + 45000 });
  assert(quote.source === 'Finnhub' && quote.data?.price === 151 && quote.asOf === '2026-10-22T12:00:00.000Z');
  assert(hosts.length === 1 && hosts[0] === 'finnhub.io');
});
Deno.test('distributed calculation bundle returns 200 USD and guards full history', () => {
  const transactions: lib.DbTransaction[] = [
    { id: 'buy', ticker: 'SYN', side: 'BUY', shares: 10, price_usd: 100, fee_usd: 0, executed_at: '2024-01-02T12:00:00Z', note: null, broker: 'manual' },
    { id: 'sell', ticker: 'SYN', side: 'SELL', shares: 4, price_usd: 150, fee_usd: 0, executed_at: '2024-02-02T12:00:00Z', note: null, broker: 'manual' },
  ];
  assert(lib.realizedUsd(lib.runFifo(transactions)) === 200);
  const policy = { ...manifest.cpuPolicy, mode: 'limited' as const };
  const result = computeWithinLimits({ transactions: policy.maxTransactions + 1, snapshots: 0 },
    () => { throw new Error('Oversized synchronous work started'); }, policy);
  assert(result.status === 'unavailable');
});
Deno.test('Deno HTTP/SSE synthetic path and Auth rejection', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const handler = makeHandler({ now: Date.now, allowedOrigins: [],
    authenticate: (req, signal) => verifyUser(req, { url: 'http://localhost:54321', anonKey: 'synthetic', fetchImpl: async (_url, init) => new Response(JSON.stringify({ id }), { status: new Headers(init?.headers).get('Authorization') === 'Bearer synthetic' ? 200 : 401 }) }, signal),
    chat: async function* () {
      yield { type: 'meta', requestId: id, threadId: id, remainingToday: null };
      yield { type: 'status', text: 'Pracuji…' };
      yield { type: 'answer', text: 'Hodnota ukázky je 123 USD.', links: [], verified: true };
      yield { type: 'done', requestId: id, persisted: false, outcome: 'ok' };
    },
  });
  for (const path of ['/agent/chat', '/functions/v1/agent/chat']) {
    const response = await handler(new Request(`http://localhost${path}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: JSON.stringify({ requestId: id, question: 'Ukázka' }) }));
    const text = await response.text();
    assert(text.includes('Hodnota ukázky je 123 USD.'));
    assert(text.split('"type":"done"').length === 2);
  }
  assert((await handler(new Request('http://localhost/agent/chat', { method: 'POST' }))).status === 401);
});
Deno.test('timeout aborts pending work and cleans resources', async () => {
  let child: AbortSignal | undefined;
  try {
    await withTimeout(signal => { child = signal; return new Promise(() => {}); }, 5, createRequestBudget(Date.now, new AbortController().signal));
    throw new Error('Expected timeout');
  } catch (error) { assert(error instanceof DOMException && error.name === 'TimeoutError'); }
  assert(child?.aborted);
});

Deno.test('Deno loopback HTTP stream returns the synthetic answer', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const auth = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, req =>
    new Response(JSON.stringify({ id }), { status: req.headers.get('Authorization') === 'Bearer synthetic' ? 200 : 401 }));
  const handler = makeHandler({ now: () => performance.now(), allowedOrigins: [],
    authenticate: (req, signal) => verifyUser(req, { url: `http://127.0.0.1:${auth.addr.port}`, anonKey: 'synthetic', fetchImpl: fetch }, signal),
    chat: async function* () {
      yield { type: 'meta', requestId: id, threadId: id, remainingToday: null };
      yield { type: 'status', text: 'Pracuji…' };
      yield { type: 'answer', text: 'Hodnota ukázky je 123 USD.', links: [], verified: true };
      yield { type: 'done', requestId: id, persisted: false, outcome: 'ok' };
    },
  });
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler);
  try {
    for (const token of ['synthetic', 'forged', 'expired']) {
      const response = await fetch(`http://127.0.0.1:${server.addr.port}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ requestId: id, question: 'Ukázka' }) });
      const text = await response.text();
      assert(response.status === (token === 'synthetic' ? 200 : 401));
      if (token === 'synthetic') {
        assert(text.includes('Hodnota ukázky je 123 USD.'));
        assert(text.split('"type":"done"').length === 2);
      }
    }
  } finally { await server.shutdown(); await auth.shutdown(); }
});

Deno.test('the tool registry runs on Deno over the synthetic fixture', async () => {
  assert(exportToolSchemas().length === 25);
  const budget = createRequestBudget(() => Date.now(), new AbortController().signal);
  const ctx = createToolContext({ repo: fixtureRepo('A'), market: fixtureMarket(), lib, budget, today: FIXTURE_TODAY, lang: 'cs',
    preferences: { displayCurrency: 'USD', localCurrency: 'CZK', tax: { fxMethod: 'cnb-daily', limitIncludesExempt: true } } });
  const summary = await executeTool('get_portfolio_summary', {}, ctx);
  assert(summary.ok && summary.facts.some(f => f.id === 'portfolio:total_value' && Math.abs(Number(f.value) - 3050.74) < 0.005)); // the tiny BTC holding counts (audit B10)
  const tax = await executeTool('get_tax_report', { year: 2026 }, ctx);
  assert(tax.ok && JSON.stringify(tax.data).length > 0);
  assert((await executeTool('get_broker_key', {}, ctx)).ok === false);
});

Deno.test('the agent orchestration runs on Deno with a fake model and ends with one verified answer', async () => {
  const budget = createRequestBudget(() => Date.now(), new AbortController().signal);
  const ctx = createToolContext({ repo: fixtureRepo('A'), market: fixtureMarket(), lib, budget, today: FIXTURE_TODAY, lang: 'cs',
    preferences: { displayCurrency: 'USD', localCurrency: 'CZK', tax: { fxMethod: 'cnb-daily', limitIncludesExempt: true } } });
  const hosts: string[] = [];
  // A synthetic model endpoint: every call is rate-limited, so the verified template must answer.
  const fetchImpl = ((input: RequestInfo | URL) => {
    hosts.push(new URL(String(input)).hostname);
    return Promise.resolve(new Response('{}', { status: 429 }));
  }) as typeof fetch;
  const events = [];
  for await (const event of runChat({ request: { requestId: '00000000-0000-4000-8000-000000000009', question: 'Vyplatí se teď koupit SYNA?' }, history: [] },
    { ctx, llm: { complete, policy: buildModelPolicy(undefined), keys: { GROQ_API_KEY: 'synthetic' }, tokens: createTokenBudget(), fetchImpl } })) events.push(event);
  const answers = events.filter(e => e.type === 'answer');
  assert(answers.length === 1 && answers[0].type === 'answer' && answers[0].text.includes('spíš atraktivní'));
  assert(events.at(-1)?.type === 'done');
  assert(hosts.length > 0 && hosts.every(h => h === 'api.groq.com'));
});

Deno.test('the chat service stores before answering and serves own history routes on Deno', async () => {
  const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jwt: 'synthetic' };
  const log: string[] = [];
  const stored: { requestId: string; text: string }[] = [];
  // A minimal synthetic AgentDb: one accepted request, then the completion it receives.
  const db: AgentDb = {
    begin: async () => { log.push('begin'); return { kind: 'accepted', threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', remainingToday: 19 }; },
    complete: async input => { log.push('complete'); stored.push({ requestId: input.requestId, text: input.answer.text }); },
    listThreads: async () => [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Synthetic', updatedAt: '2026-10-23T00:00:00Z' }],
    loadThread: async () => null,
    deleteThread: async () => false,
  };
  const fetchImpl = (() => Promise.resolve(new Response('{}', { status: 429 }))) as typeof fetch;
  const service = createChatService({ db, repo: fixtureRepo('A'), market: fixtureMarket(), lib, today: () => FIXTURE_TODAY,
    llm: { complete, policy: buildModelPolicy(undefined), keys: { GROQ_API_KEY: 'synthetic' }, tokens: createTokenBudget(), fetchImpl } });
  const budget = createRequestBudget(() => Date.now(), new AbortController().signal);
  const events = [];
  for await (const event of service({ requestId: '00000000-0000-4000-8000-000000000010', question: 'Kolik mám v portfoliu?' }, user, budget)) {
    log.push(`event:${event.type}`);
    events.push(event);
  }
  assert(events[0].type === 'meta' && log.indexOf('complete') < log.indexOf('event:answer'));
  const done = events.at(-1);
  assert(done?.type === 'done' && done.persisted === true && stored.length === 1);
  const routes = createAgentRoutes({ db, directTools: null });
  const list = await routes(new Request('http://localhost/functions/v1/agent/threads'), user, budget);
  assert(list?.status === 200 && (await list.json()).threads.length === 1);
  const missing = await routes(new Request('http://localhost/agent/threads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { method: 'DELETE' }), user, budget);
  assert(missing?.status === 404);
  assert(await routes(new Request('http://localhost/agent/tools/get_quote', { method: 'POST', body: '{}' }), user, budget) === null);
  assert(readAgentConfig(() => undefined).enabled === false);
});
