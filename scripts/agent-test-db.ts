import { mkdir, rmdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { getTestDbConfig, signInTestUser, testDbFetch, TEST_DB_SKIP } from '../src/test/agentTestDb.ts';
import { createAgentDb } from '../supabase/functions/agent/live/db.ts';
import type { CallerDbClient } from '../supabase/functions/agent/core/ports.ts';

const marker = 'trackora-test:';
export const readContext = () => ({ signal: new AbortController().signal, deadline: Date.now() + 45000 });
export const syntheticAnswer = { text: 'Synthetic verified answer.', links: [], trace: [], lang: 'en' as const, outcome: 'ok' as const, verified: true as const };
export const syntheticMetrics = { model: null, routerModel: null, tokensIn: 10, tokensOut: 5, maxCallTokens: 15, toolCalls: 0,
  toolsUsed: [], wallMs: 12, ttftMs: null, outcome: 'ok', groundingOk: true, calculationVersion: 'synthetic-fixture', errorCode: null };

// The service credential exists only in this isolated fixture module, never in live/db or a runner.
export async function withTestDb<T>(work: (session: TestSession) => Promise<T>): Promise<T> {
  const config = getTestDbConfig();
  if (!config) throw new Error(TEST_DB_SKIP);
  const target = JSON.parse(await readFile(new URL('../docs/ai-assistant/test-target.json', import.meta.url), 'utf8'));
  const serviceKey = process.env.TEST_DB_SERVICE_KEY;
  if (!serviceKey) throw new Error('Incomplete TEST_DB setup configuration');
  if (config.users.A.email === config.users.B.email || !['A', 'B'].every(u => target.fixtureEmails.includes(config.users[u as 'A' | 'B'].email))) {
    throw new Error('Only explicitly listed synthetic accounts may be used');
  }
  const lock = new URL('../.agent-db-test-lock/', import.meta.url);
  const waitUntil = Date.now() + 180000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= waitUntil) throw new Error('Test fixture lock unavailable; inspect stale lock');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const fetchImpl = testDbFetch(config.url);
  const fixture = marker + crypto.randomUUID();
  const symbol = '__TRACKORA_AGENT_TEST_' + crypto.randomUUID();
  const identities: Partial<Record<'A' | 'B', { id: string; jwt: string }>> = {};
  let ready = false;
  // Requests made through the HTTP runner carry the service's own fingerprint; the session tracks their IDs.
  const tracked = new Set<string>();
  async function rest(jwt: string, path: string, method = 'GET', body?: unknown) {
    const response = await fetchImpl(`${config!.url}/rest/v1/${path}`, { method,
      headers: { apikey: jwt === serviceKey ? serviceKey : config!.anonKey, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }
  async function admin(path: string, method = 'GET', body?: unknown) {
    const result = await rest(serviceKey!, path, method, body);
    if (result.status >= 300) throw new Error('Synthetic fixture operation failed');
    return result.data;
  }
  let result: T;
  let failed = false, failure: unknown;
  try {
    identities.A = await signInTestUser('A'); identities.B = await signInTestUser('B');
    if (identities.A.id === identities.B.id) throw new Error('Synthetic users must differ');
    // These two dedicated accounts must start empty; no blanket reset of pre-existing data.
    for (const { id } of Object.values(identities)) {
      const requests = await admin(`agent_requests?user_id=eq.${id}&select=request_id&limit=1`);
      const usage = await admin(`agent_daily_usage?user_id=eq.${id}&select=day&limit=1`);
      if (requests.length || usage.length) throw new Error('Synthetic accounts are not pristine; review fixture cleanup first');
    }
    ready = true;
    const users = Object.fromEntries((['A', 'B'] as const).map(key => {
      const identity = identities[key]!;
      const client = createClient(config.url, config.anonKey, { global: { headers: { Authorization: `Bearer ${identity.jwt}` }, fetch: fetchImpl },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const caller = client as unknown as CallerDbClient;
      return [key, { ...identity, client: caller, db: createAgentDb(caller) }];
    })) as TestSession['users'];
    result = await work({ users, symbol,
      track(requestId: string) { tracked.add(requestId); },
      input: (threadId?: string) => ({ requestId: crypto.randomUUID(), threadId, question: 'Synthetic fixture question',
        lang: 'en', fingerprint: fixture, executionToken: crypto.randomUUID() }),
      rest: (user, path, method, body) => rest(user === 'anon' ? config.anonKey : identities[user]!.jwt, path, method, body),
      async expire(user, requestId) {
        const id = identities[user]!.id;
        const rows = await admin(`agent_requests?user_id=eq.${id}&request_id=eq.${requestId}&fingerprint=eq.${fixture}&select=request_id`);
        if (rows.length !== 1) throw new Error('Unknown fixture reservation');
        await admin(`agent_requests?user_id=eq.${id}&request_id=eq.${requestId}&fingerprint=eq.${fixture}`, 'PATCH', { created_at: new Date(Date.now() - 60000).toISOString() });
      },
      async seedMarket() {
        const items = [{ en: 'Synthetic news', cs: 'Syntetická zpráva', sumEn: 'Fixture', sumCs: 'Ukázka', publisher: 'Synthetic', url: 'https://example.invalid/news', ts: 1 }];
        await admin('stock_news', 'POST', { symbol, items, fetched_at: '2026-01-01T00:00:00Z' });
        await admin('analyst_snapshots', 'POST', { symbol, data: { target: 123 }, status: 'ok', fetched_at: '2026-01-01T00:00:00Z', last_attempt_at: '2026-01-01T00:00:00Z' });
        return items;
      },
      async foreignLinkConstraint(table, threadId) {
        const rows = await admin(`agent_requests?user_id=eq.${identities.A!.id}&thread_id=eq.${threadId}&fingerprint=eq.${fixture}&select=request_id`);
        if (rows.length !== 1) throw new Error('Unknown fixture thread');
        const body = { thread_id: threadId, user_id: identities.B!.id, request_id: crypto.randomUUID(),
          ...(table === 'chat_messages' ? { seq: 999, role: 'user', content: 'Synthetic FK probe', lang: 'en' }
            : { tokens_in: 0, tokens_out: 0, max_call_tokens: 0, tool_calls: 0, tools_used: [], wall_ms: 0,
              outcome: 'ok', grounding_ok: true, calculation_version: 'synthetic' }) };
        const result = await rest(serviceKey!, table, 'POST', body);
        // A privileged fixture probe proves the FK itself, independently of client grants.
        return { status: result.status, code: result.data?.code };
      },
    });
  } catch (error) { failed = true; failure = error; }
  try {
    if (ready) {
      // Questions this session took from the shared daily cap (audit A1), given back per day after cleanup.
      const sharedByDay = new Map<string, number>();
      for (const { id } of Object.values(identities)) {
        const requests = await admin(`agent_requests?user_id=eq.${id}&select=request_id,thread_id,fingerprint,created_at`);
        if (requests.length > 1000 || requests.some((r: { fingerprint: string; request_id: string }) => r.fingerprint !== fixture && !tracked.has(r.request_id))) {
          throw new Error('Refusing cleanup: unrelated reservations present');
        }
        const days = new Set<string>();
        for (const r of requests) {
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.created_at));
          days.add(day);
          sharedByDay.set(day, (sharedByDay.get(day) ?? 0) + 1);
          await admin(`chat_threads?id=eq.${r.thread_id}&user_id=eq.${id}`, 'DELETE');
          await admin(`agent_requests?user_id=eq.${id}&request_id=eq.${r.request_id}&fingerprint=eq.${encodeURIComponent(r.fingerprint)}`, 'DELETE');
        }
        // Accounts were pristine and every reservation was marked by this session.
        const usage = await admin(`agent_daily_usage?user_id=eq.${id}&select=day`);
        for (const row of usage) days.add(row.day);
        for (const day of days) await admin(`agent_daily_usage?user_id=eq.${id}&day=eq.${day}`, 'DELETE');
      }
      for (const [day, taken] of sharedByDay) {
        const [row] = await admin(`agent_shared_usage?day=eq.${day}&resource=eq.questions&select=used`);
        if (row) await admin(`agent_shared_usage?day=eq.${day}&resource=eq.questions`, 'PATCH', { used: Math.max(0, row.used - taken) });
      }
      for (const table of ['stock_news', 'analyst_snapshots']) await admin(`${table}?symbol=eq.${symbol}`, 'DELETE');
    }
  } finally { await rmdir(lock); }
  if (failed) throw failure;
  return result;
}

type TestUser = { id: string; jwt: string; client: CallerDbClient; db: ReturnType<typeof createAgentDb> };
export type TestSession = {
  users: Record<'A' | 'B', TestUser>;
  symbol: string;
  /** Marks a request made through the HTTP runner as this session's, so cleanup may remove it. */
  track(requestId: string): void;
  input(threadId?: string): { requestId: string; threadId?: string; question: string; lang: 'en'; fingerprint: string; executionToken: string };
  rest(user: 'A' | 'B' | 'anon', path: string, method?: string, body?: unknown): Promise<{ status: number; data: unknown }>;
  expire(user: 'A' | 'B', requestId: string): Promise<void>;
  seedMarket(): Promise<unknown[]>;
  foreignLinkConstraint(table: 'chat_messages' | 'agent_runs', threadId: string): Promise<{ status: number; code: string }>;
};

/** Three rollback-only schema cases; execute in the chosen test project's SQL editor. */
export async function buildSchemaFixtureSql(): Promise<string> {
  const migration = await readFile(new URL('../supabase/migrations/20261025100010_ai_market_cache.sql', import.meta.url), 'utf8');
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const chunks = ['begin;'];
  for (const variant of ['empty', 'legacy', 'incompatible']) {
    const schema = `agent_probe_${variant}_${suffix}`;
    const adapted = migration.replace(/\bpublic\./g, `${schema}.`);
    chunks.push(`create schema ${schema};`);
    if (variant === 'legacy') chunks.push(`
create table ${schema}.stock_news(symbol varchar primary key, items json, fetched_at timestamptz);
insert into ${schema}.stock_news values ('SYNTHETIC', '[{"en":"Fixture","cs":"Ukázka","sumEn":"Summary","sumCs":"Souhrn","publisher":"Synthetic","url":"https://example.invalid/news","ts":1}]', '2026-01-01T00:00:00Z');
alter table ${schema}.stock_news enable row level security;
create policy legacy_public on ${schema}.stock_news for all to public using (true) with check (true);
grant all on ${schema}.stock_news to anon, authenticated;
grant select (items), update (items) on ${schema}.stock_news to anon, authenticated;`);
    if (variant === 'incompatible') {
      chunks.push(`create table ${schema}.stock_news(symbol text primary key, items text);
do $probe$ begin
  begin
    execute $migration$${adapted}$migration$;
    raise exception 'Incompatible fixture was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Incompatible stock_news schema:%' then raise; end if;
  end;
end; $probe$;`);
      continue;
    }
    chunks.push(adapted, `
do $probe$ begin
  if not exists (select 1 from pg_catalog.pg_class where oid = '${schema}.stock_news'::regclass and relrowsecurity)
    or not exists (select 1 from pg_catalog.pg_class where oid = '${schema}.analyst_snapshots'::regclass and relrowsecurity)
    or pg_catalog.has_any_column_privilege('anon', '${schema}.stock_news', 'SELECT')
    or pg_catalog.has_any_column_privilege('authenticated', '${schema}.stock_news', 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', '${schema}.analyst_snapshots', 'INSERT,UPDATE,DELETE')
    or not pg_catalog.has_column_privilege('authenticated', '${schema}.stock_news', 'items', 'SELECT')
    or (select count(*) from pg_catalog.pg_policy where polrelid = '${schema}.stock_news'::regclass) <> 1
    or exists (select 1 from pg_catalog.pg_policy where polrelid = '${schema}.stock_news'::regclass and (polcmd <> 'r' or 0 = any(polroles))) then
    raise exception 'Cache policy/grant fixture failed: ${variant}';
  end if;
  ${variant === 'legacy' ? `if (select items from ${schema}.stock_news where symbol = 'SYNTHETIC') is distinct from
    '[{"en":"Fixture","cs":"Ukázka","sumEn":"Summary","sumCs":"Souhrn","publisher":"Synthetic","url":"https://example.invalid/news","ts":1}]'::jsonb then
    raise exception 'Legacy news items changed'; end if;` : ''}
end; $probe$;`);
  }
  chunks.push('rollback;');
  return chunks.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = getTestDbConfig();
  if (!config) console.info(TEST_DB_SKIP);
  else if (process.argv.includes('--schema-fixtures')) console.info(await buildSchemaFixtureSql());
  else if (process.argv.includes('--check')) {
    await withTestDb(async () => { console.info('PASS: explicit test target, synthetic Auth A/B and pristine fixture storage'); });
  } else {
    throw new Error('Use --check only after applying the reviewed migrations to the explicit test target; see TEST-DB.md');
  }
}
