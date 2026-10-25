// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GATEWAY_CHECKS } from '../../scripts/agent-release-check.mjs';
import { gatewayEvidence, runGatewaySmoke, smokeInSession } from '../../scripts/agent-gateway-smoke.ts';

const BASE = 'http://127.0.0.1:54321/functions/v1/agent';
const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

/** A fake local gateway: JWT "a"/"b" are users, everything else is rejected; B cannot see A's thread. */
function gateway(over: { foreignStatus?: number; persisted?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = String(input), auth = new Headers(init?.headers).get('Authorization');
    const user = auth === 'Bearer jwt-a' ? 'a' : auth === 'Bearer jwt-b' ? 'b' : null;
    if (!user) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (init?.method === 'DELETE' && url.endsWith(`/threads/${THREAD}`) && user === 'a') return new Response(null, { status: 204 });
    if (url.endsWith('/chat')) return sse([{ type: 'meta', requestId: JSON.parse(String(init?.body)).requestId, threadId: THREAD, remainingToday: 19 },
      { type: 'answer', text: 'Hodnota portfolia: 3 050 USD', links: [], verified: true },
      { type: 'done', requestId: JSON.parse(String(init?.body)).requestId, outcome: 'ok', persisted: over.persisted ?? true }]);
    if (url.endsWith('/threads')) return Response.json({ threads: user === 'a' ? [{ id: THREAD }] : [] });
    if (url.endsWith(`/threads/${THREAD}`)) return new Response('{}', { status: user === 'a' ? 200 : over.foreignStatus ?? 404 });
    return new Response('', { status: 404 });
  };
}

describe('gateway smoke', () => {
  it.each(['success', 'foreign-error', 'list-error', 'truncated'] as const)('deletes only its own thread with A JWT after %s', async mode => {
    const calls: { url: string; method: string; auth: string | null }[] = [];
    const base = gateway();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input), method = init?.method ?? 'GET', auth = new Headers(init?.headers).get('Authorization');
      calls.push({ url, method, auth });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (mode === 'list-error' && url.endsWith('/threads')) throw new Error('synthetic failure');
      if (mode === 'foreign-error' && auth === 'Bearer jwt-b') throw new Error('synthetic failure');
      if (mode === 'truncated' && url.endsWith('/chat') && auth === 'Bearer jwt-a') {
        const requestId = JSON.parse(String(init?.body)).requestId;
        return sse([{ type: 'meta', requestId, threadId: THREAD, remainingToday: 19 }]);
      }
      return base(input, init);
    };
    await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl }).catch(() => {});
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([{ url: `${BASE}/threads/${THREAD}`, method: 'DELETE', auth: 'Bearer jwt-a' }]);
  });

  it('cannot report PASS when cleanup fails', async () => {
    const fetchImpl: typeof fetch = (input, init) => init?.method === 'DELETE'
      ? Promise.resolve(new Response(null, { status: 503 })) : gateway()(input, init);
    const result = await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl });
    expect(result.checks).toHaveProperty('user_a_cleanup', 'FAIL');
  });

  it('passes all release-gate checks against a well-behaved gateway and records no secrets', async () => {
    const result = await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl: gateway() });
    expect(Object.keys(result.checks).sort()).toEqual([...(GATEWAY_CHECKS as string[])].sort());
    expect(Object.values(result.checks).every(s => s === 'PASS')).toBe(true);
    const evidence = gatewayEvidence({ base: BASE, sha: 'a'.repeat(40), calculationVersion: 'v', startedAt: '2026-10-24T00:00:00Z', result });
    expect(evidence).toMatchObject({ kind: 'supabase-functions-serve-smoke', runner: 'scripts/agent-gateway-smoke.ts', base_url: BASE });
    expect(JSON.stringify(evidence)).not.toMatch(/jwt-a|jwt-b|3 050/);
  });

  it('fails a foreign thread that is visible and an answer that was not persisted', async () => {
    const leak = await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl: gateway({ foreignStatus: 200 }) });
    expect(leak.checks.user_b_foreign_thread_404).toBe('FAIL');
    const unsaved = await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl: gateway({ persisted: false }) });
    expect(unsaved.checks.user_a_chat_done).toBe('FAIL');
  });

  // Thread deletion leaves the request reservation and daily usage behind ("Synthetic accounts are not pristine"):
  // the smoke runs inside the fixture session, which removes exactly the tracked request and its usage day.
  it('tracks its chat request before sending it so the fixture session can remove the reservation', async () => {
    const sent: string[] = [], tracked: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/chat') && new Headers(init?.headers).get('Authorization') === 'Bearer jwt-a') {
        const id = JSON.parse(String(init?.body)).requestId;
        expect(tracked).toContain(id);
        sent.push(id);
      }
      return gateway()(input, init);
    };
    await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl, track: id => tracked.push(id) });
    expect(tracked).toEqual(sent);
    expect(sent).toHaveLength(1);
  });

  it('runs the smoke as the fixture session users and tracks through that session', async () => {
    const tracked: string[] = [];
    const session = { users: { A: { jwt: 'jwt-a' }, B: { jwt: 'jwt-b' } }, track: (id: string) => { tracked.push(id); } };
    const result = await smokeInSession(session, { base: BASE, fetchImpl: gateway() });
    expect(Object.values(result.checks).every(s => s === 'PASS')).toBe(true);
    expect(tracked).toHaveLength(1);
  });

  it('fails when the gateway lets an unauthenticated or forged request through', async () => {
    const open: typeof fetch = async (input, init) => new Headers(init?.headers).get('Authorization') ? gateway()(input, init) : new Response('', { status: 200 });
    expect((await runGatewaySmoke({ base: BASE, jwtA: 'jwt-a', jwtB: 'jwt-b', fetchImpl: open })).checks.no_token_401).toBe('FAIL');
  });
});
