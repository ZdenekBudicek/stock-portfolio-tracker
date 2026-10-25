import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readAgentEvents } from '../src/test/agentSmokeTransport.ts';
import { getTestDbConfig, TEST_DB_SKIP } from '../src/test/agentTestDb.ts';
import { withTestDb } from './agent-test-db.ts';

/**
 * Gateway smoke of the deployed function in the LOCAL Supabase stack — the release gate's only gateway evidence
 * (`scripts/agent-test-edge.ts` serves the handler from its own Deno server and never passes the gateway).
 *
 *   supabase start
 *   supabase functions serve agent            # terminal 1, local edge runtime behind the gateway (:54321)
 *   TEST_DB_URL=http://127.0.0.1:54321 TEST_DB_ANON_KEY=… TEST_USER_A_EMAIL=… TEST_USER_A_PASSWORD=… TEST_USER_B_EMAIL=… TEST_USER_B_PASSWORD=… \
 *     node --experimental-transform-types scripts/agent-gateway-smoke.ts   # writes docs/ai-assistant/gateway-evidence.json
 *
 * Synthetic users A/B of the local test stack only; tokens and passwords are never written. It costs one quota
 * question of user A. It runs inside `withTestDb` (needs TEST_DB_SERVICE_KEY): the accounts must start pristine and
 * the session removes the tracked request and its usage day afterwards (thread deletion alone does not).
 * Run from a clean commit: the evidence names its SHA and calculation version.
 */
export const GATEWAY_EVIDENCE_PATH = 'docs/ai-assistant/gateway-evidence.json';
export const DEFAULT_GATEWAY = 'http://127.0.0.1:54321/functions/v1/agent';
type State = 'PASS' | 'FAIL';
export type GatewayChecks = Record<'no_token_401' | 'forged_token_401' | 'user_a_chat_done' | 'user_a_thread_listed' | 'user_b_foreign_thread_404' | 'user_a_cleanup', State>;

const FORGED = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAifQ.forged';

/** Observations hold status codes and event types only; cleanup uses the same owner's JWT. */
export async function runGatewaySmoke(opts: { base: string; jwtA: string; jwtB: string; fetchImpl?: typeof fetch; anonKey?: string;
  track?: (requestId: string) => void }) {
  const f = opts.fetchImpl ?? fetch;
  const headers = (jwt?: string): Record<string, string> => ({ 'Content-Type': 'application/json', ...(opts.anonKey ? { apikey: opts.anonKey } : {}),
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) });
  const body = () => JSON.stringify({ requestId: crypto.randomUUID(), question: 'Kolik mám v portfoliu?' });
  const status = async (response: Response) => { await response.text().catch(() => ''); return response.status; };
  const observations: Record<string, unknown> = {};
  const checks: GatewayChecks = { no_token_401: 'FAIL', forged_token_401: 'FAIL', user_a_chat_done: 'FAIL',
    user_a_thread_listed: 'FAIL', user_b_foreign_thread_404: 'FAIL', user_a_cleanup: 'FAIL' };

  observations.no_token_status = await status(await f(`${opts.base}/chat`, { method: 'POST', headers: headers(), body: body() }));
  checks.no_token_401 = observations.no_token_status === 401 ? 'PASS' : 'FAIL';
  observations.forged_token_status = await status(await f(`${opts.base}/chat`, { method: 'POST', headers: headers(FORGED), body: body() }));
  checks.forged_token_401 = observations.forged_token_status === 401 ? 'PASS' : 'FAIL';

  let threadId: string | null = null;
  const chatBody = body();
  const requestId = (JSON.parse(chatBody) as { requestId: string }).requestId;
  // Tracked before sending: a failed run must still let the fixture session remove the reservation and usage.
  opts.track?.(requestId);
  try {
    const events = await readAgentEvents(await f(`${opts.base}/chat`, { method: 'POST', headers: headers(opts.jwtA), body: chatBody }), event => {
      if (event.type === 'meta' && event.requestId === requestId && /^[0-9a-f-]{36}$/i.test(event.threadId)) threadId = event.threadId;
    });
    const done = events.find(e => e.type === 'done');
    observations.chat_events = events.map(e => e.type);
    observations.chat_outcome = done?.type === 'done' ? done.outcome : null;
    checks.user_a_chat_done = threadId && events.some(e => e.type === 'answer') && done?.type === 'done' && done.requestId === requestId && done.persisted ? 'PASS' : 'FAIL';
    const list = await f(`${opts.base}/threads`, { headers: headers(opts.jwtA) });
    const threads = list.ok ? ((await list.json()) as { threads?: { id: string }[] }).threads ?? [] : (await list.text(), []);
    observations.thread_list_status = list.status;
    checks.user_a_thread_listed = threadId !== null && threads.some(t => t.id === threadId) ? 'PASS' : 'FAIL';
    observations.foreign_thread_status = threadId ? await status(await f(`${opts.base}/threads/${threadId}`, { headers: headers(opts.jwtB) })) : null;
    checks.user_b_foreign_thread_404 = observations.foreign_thread_status === 404 ? 'PASS' : 'FAIL';
  } catch {
    observations.smoke_error = 'request_failed';
  } finally {
    if (threadId) {
      try {
        observations.cleanup_status = await status(await f(`${opts.base}/threads/${threadId}`, { method: 'DELETE', headers: headers(opts.jwtA) }));
        checks.user_a_cleanup = observations.cleanup_status === 204 ? 'PASS' : 'FAIL';
      } catch { observations.cleanup_error = 'request_failed'; }
    }
  }
  return { checks, observations };
}

/** The smoke as the fixture session's users A/B; the session removes the tracked request and its usage day afterwards. */
export function smokeInSession(session: { users: Record<'A' | 'B', { jwt: string }>; track(requestId: string): void },
  opts: { base: string; fetchImpl?: typeof fetch; anonKey?: string }) {
  return runGatewaySmoke({ ...opts, jwtA: session.users.A.jwt, jwtB: session.users.B.jwt, track: id => session.track(id) });
}

export function gatewayEvidence(input: { base: string; sha: string; calculationVersion: string; startedAt: string;
  result: Awaited<ReturnType<typeof runGatewaySmoke>> }) {
  return { schema_version: 1, kind: 'supabase-functions-serve-smoke', runner: 'scripts/agent-gateway-smoke.ts', sha: input.sha,
    calculation_version: input.calculationVersion, base_url: input.base, started_at: input.startedAt,
    checks: input.result.checks, observations: input.result.observations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = getTestDbConfig();
  if (!config) { console.info(TEST_DB_SKIP); process.exit(2); }
  const base = process.argv.find(a => a.startsWith('--base='))?.slice(7) ?? DEFAULT_GATEWAY;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/functions\/v1\/agent$/.test(base)) throw new Error('Only the local functions gateway is allowed');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
  const manifest = JSON.parse(readFileSync('supabase/functions/agent/_lib/manifest.json', 'utf8')) as { calculationVersion: string };
  const startedAt = new Date().toISOString();
  // Pristine accounts in, pristine accounts out: thread deletion alone leaves the reservation and daily usage.
  const result = await withTestDb(session => smokeInSession(session, { base, anonKey: config.anonKey }));
  const evidence = gatewayEvidence({ base, sha: dirty ? `${sha}+dirty` : sha, calculationVersion: manifest.calculationVersion, startedAt, result });
  writeFileSync(GATEWAY_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.info(JSON.stringify(evidence.checks));
  process.exitCode = Object.values(result.checks).every(s => s === 'PASS') && !dirty ? 0 : 1;
}
