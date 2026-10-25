import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import * as lib from '../supabase/functions/agent/_lib/trackora-lib.js';
import { FIXTURE_TODAY, fixtureMarket, fixtureRepo, type FixtureUser } from '../supabase/functions/agent/core/fixture.ts';
import { complete, createTokenBudget } from '../supabase/functions/agent/core/llm.ts';
import { buildModelPolicy } from '../supabase/functions/agent/core/modelPolicy.ts';
import { makeHandler } from '../supabase/functions/agent/handler.ts';
import { verifyUser } from '../supabase/functions/agent/live/auth.ts';
import { createAgentRoutes, createChatService, DEFAULT_PREFERENCES, type EvalAudit } from '../supabase/functions/agent/service.ts';
import { createMemoryAgentStore } from '../src/test/agentMemoryDb.ts';
import { createFakeLlmFetch } from '../src/test/agentFakeLlm.ts';
import { getTestDbConfig, testDbFetch } from '../src/test/agentTestDb.ts';
import { createAgentDb } from '../supabase/functions/agent/live/db.ts';
import { createPortfolioRepo } from '../supabase/functions/agent/live/repo.ts';
import type { CallerDbClient } from '../supabase/functions/agent/core/ports.ts';

// Synthetic fixture users of the loopback runner; their tokens work only here, never in the Edge entrypoint.
const FIXTURE_USERS = {
  'fixture-user-a': { id: '11111111-1111-4111-8111-111111111111', fixture: 'A' },
  'fixture-user-b': { id: '22222222-2222-4222-8222-222222222222', fixture: 'B' },
  'fixture-user-c': { id: '33333333-3333-4333-8333-333333333333', fixture: 'C' },
  'fixture-user-d': { id: '44444444-4444-4444-8444-444444444444', fixture: 'D' },
  'fixture-user-e': { id: '55555555-5555-4555-8555-555555555555', fixture: 'E' },
} as const;

/**
 * `agent` runs the real chat service over the synthetic fixtures of users A–E, with in-memory
 * history and quota (orchestration evidence only, not RLS). Models are called only with keys passed
 * in explicitly (the CLI reads GROQ_API_KEY from the process environment); without a key every model
 * is skipped and the verified template answers. Direct tool calls and the eval audit exist only here.
 * `agent.fetchImpl` replaces the model endpoint (the `--fake-llm` eval mode). Without `fixtureAuth`
 * (TEST_DB only) history, quota and portfolio go through the real caller-JWT adapters of the test
 * project — the same RLS path as the Edge entrypoint — while market data stay synthetic. Market keys (FINNHUB_API_KEY,
 * TWELVE_DATA_KEY, TAVILY_API_KEY) are therefore never read here: the synthetic articles stand in for Tavily, and the
 * loopback runner makes no market request at all.
 */
export async function startAgentServer(options: { fixtureAuth?: boolean; port?: number; enabled?: boolean;
  agent?: { keys: Readonly<Record<string, string>>; fetchImpl?: typeof fetch } } = {}) {
  const config = options.fixtureAuth ? null : getTestDbConfig();
  if (!options.fixtureAuth && !config) throw new Error('TEST_DB_URL is required unless --fixture-auth is explicit');
  const store = createMemoryAgentStore();
  const audits = new Map<string, EvalAudit>();
  // The identity prefix names the fixture (numbered identities keep the first 24 characters).
  const fixtureOf = (userId: string): FixtureUser =>
    Object.values(FIXTURE_USERS).find(u => userId.startsWith(u.id.slice(0, 9)))?.fixture ?? 'A';
  const llm = (keys: Readonly<Record<string, string>>) => ({ complete, policy: buildModelPolicy(undefined), keys, tokens: createTokenBudget(),
    fetchImpl: options.agent?.fetchImpl ?? fetch });
  // Real test-project storage per request and user JWT; never shared between users or requests.
  const caller = (jwt: string): CallerDbClient => createClient(config!.url, config!.anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: testDbFetch(config!.url) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as CallerDbClient;
  const storeOf = (user: { id: string; jwt: string }) => config ? createAgentDb(caller(user.jwt)) : store.forUser(user.id);
  const repoOf = (user: { id: string; jwt: string }) => config ? createPortfolioRepo(caller(user.jwt)) : fixtureRepo(fixtureOf(user.id));
  const handler = makeHandler({
    enabled: options.enabled ?? true,
    now: () => Date.now(),
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8080', 'http://127.0.0.1:8080'],
    dispatch: options.agent ? (req, user, budget) => createAgentRoutes({ db: storeOf(user),
      directTools: { context: b => ({ repo: repoOf(user), market: fixtureMarket(), lib, budget: b, today: FIXTURE_TODAY, lang: 'cs',
        preferences: DEFAULT_PREFERENCES }) },
      evalAudit: requestId => audits.get(`${user.id}:${requestId}`) ?? null })(req, user, budget) : undefined,
    authenticate: async (req, signal) => {
      if (options.fixtureAuth) {
        // `fixture-user-a-7`: a separate synthetic identity over the same fixture (own quota and history), so
        // an eval run of 30 cases is not cut by the 20-question daily limit of one identity.
        const match = /^Bearer (fixture-user-([a-e]))(?:-(\d{1,4}))?$/.exec(req.headers.get('Authorization') ?? '');
        if (!match) return null;
        const id = FIXTURE_USERS[match[1] as keyof typeof FIXTURE_USERS].id;
        return { id: match[3] ? `${id.slice(0, 24)}${match[3].padStart(12, '0')}` : id, jwt: match[0].slice(7) };
      }
      const client = createClient(config!.url, config!.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal, redirect: 'error' }) },
      });
      return verifyUser(req, { url: config!.url, anonKey: config!.anonKey, fetchImpl: async (_input, init) => {
        const { data, error } = await client.auth.getUser(new Headers(init?.headers).get('Authorization')!.slice(7));
        return new Response(JSON.stringify(data.user ? { id: data.user.id } : null), { status: error ? error.status === 401 || error.status === 403 ? 401 : 503 : 200 });
      } }, signal);
    },
    chat: async function* (input, user, budget) {
      if (options.agent) {
        yield* createChatService({ db: storeOf(user), repo: repoOf(user), market: fixtureMarket(), lib, llm: llm(options.agent.keys),
          today: () => FIXTURE_TODAY, audit: (requestId, audit) => audits.set(`${user.id}:${requestId}`, audit) })(input, user, budget);
        return;
      }
      yield { type: 'meta', requestId: input.requestId, threadId: input.threadId ?? crypto.randomUUID(), remainingToday: null };
      yield { type: 'status', text: 'Připravuji ukázku…' };
      yield { type: 'answer', text: 'Hodnota ukázky je 123 USD.', links: [], verified: true };
      yield { type: 'done', requestId: input.requestId, persisted: false, outcome: 'ok' };
    },
  });
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // The response close detects client disconnects. Cancelling an oversized request's
    // body also emits IncomingMessage.aborted, but must still allow the 413 response.
    outgoing.once('close', abort);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const init: RequestInit & { duplex: string } = { method: incoming.method, headers, signal: controller.signal, duplex: 'half' };
      if (!['GET', 'HEAD'].includes(incoming.method ?? 'GET')) init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const response = await handler(new Request(`http://127.0.0.1${incoming.url}`, init));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.flushHeaders();
      reader = response.body?.getReader();
      while (reader && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!outgoing.write(value)) await once(outgoing, 'drain', { signal: controller.signal });
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'text/plain' });
      outgoing.end();
    } finally {
      await reader?.cancel().catch(() => {});
      outgoing.removeListener('close', abort);
    }
  });
  server.listen(options.port ?? 8787, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `--fake-llm` (eval fake mode) never reads a key; otherwise GROQ_API_KEY comes only from the process environment.
  const fake = process.argv.includes('--fake-llm');
  const agent: { keys: Record<string, string>; fetchImpl?: typeof fetch } | undefined = process.argv.includes('--fixture-agent') || fake
    ? fake ? { keys: { GROQ_API_KEY: 'fake' }, fetchImpl: createFakeLlmFetch() } : { keys: process.env.GROQ_API_KEY ? { GROQ_API_KEY: process.env.GROQ_API_KEY } : {} as Record<string, string> }
    : undefined;
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 8787);
  const server = await startAgentServer({ fixtureAuth: process.argv.includes('--fixture-auth'), agent, enabled: !process.argv.includes('--disabled'), port });
  console.info(`Synthetic agent listening on ${server.url}${fake ? ' (fake model)' : agent && !agent.keys.GROQ_API_KEY ? ' (no model key: verified templates)' : ''}`);
}
