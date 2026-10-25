// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { startAgentServer } from '../../scripts/agent-local.ts';
import { renderSmokeAnswer, readAgentEvents } from '../test/agentSmokeTransport.ts';
import { getTestDbConfig, signInTestUser, TEST_DB_SKIP } from '../test/agentTestDb.ts';
import { withTestDb } from '../../scripts/agent-test-db.ts';
import type { AgentEvent } from '../../supabase/functions/agent/core/protocol.ts';

const input = { requestId: '11111111-1111-4111-8111-111111111111', question: 'Ukázka' };
const servers: Awaited<ReturnType<typeof startAgentServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });
it('renders the exact synthetic answer from a real loopback HTTP stream', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0 });
  servers.push(server);
  const dom = new JSDOM();
  const element = dom.window.document.createElement('div');
  await renderSmokeAnswer(`${server.url}/agent/chat`, 'fixture-user-a', input, element);
  expect(element.textContent).toBe('Hodnota ukázky je 123 USD.');
  dom.window.close();
  expect((await fetch(`${server.url}/agent/chat`, { method: 'POST', body: JSON.stringify(input) })).status).toBe(401);
});
it('reassembles SSE split at every byte including Czech UTF-8', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"answer","text":"Hodnota ukázky je 123 USD.","links":[],"verified":true}\n\ndata: {"type":"done","requestId":"id","persisted":false,"outcome":"ok"}\n\n');
  const events = await readAgentEvents(new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } })));
  expect(events[0]).toMatchObject({ text: 'Hodnota ukázky je 123 USD.' });
});
it('returns request validation errors over actual HTTP', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0 });
  servers.push(server);
  for (const [body, status] of [['{', 400], [' '.repeat(32768), 413], [JSON.stringify({ ...input, question: 'x'.repeat(2001) }), 400]] as const) {
    const response = await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: 'Bearer fixture-user-a' }, body });
    expect(response.status).toBe(status);
    await response.text();
  }
});
it('limits a streamed body without trusting Content-Length', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0 });
  servers.push(server);
  const body = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(' '.repeat(16384)));
    c.enqueue(new TextEncoder().encode(' '.repeat(16384)));
    c.close();
  } });
  const response = await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: 'Bearer fixture-user-a' }, body, duplex: 'half' } as RequestInit);
  expect(response.status).toBe(413);
  await response.text();
});
it('runs the real agent over the synthetic fixture through HTTP, answering from verified facts without a model key', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0, agent: { keys: {} } });
  servers.push(server);
  const response = await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: 'Bearer fixture-user-a' },
    body: JSON.stringify({ ...input, question: 'Kolik mám v portfoliu?' }) });
  const events = await readAgentEvents(response);
  const answer = events.find(e => e.type === 'answer') as { text: string } | undefined;
  expect(answer?.text.replace(/\u00a0|\u202f/g, ' ')).toMatch(/Tvoje portfolio má hodnotu 3 050,74 USD/);
  // Běh 10: the fixture runner now stores the verified answer before `done`.
  expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'fallback', persisted: true });
});
it('keeps own history over HTTP: create, list, load, idempotent retry, delete; the other fixture user sees none of it', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0, agent: { keys: {} } });
  servers.push(server);
  const call = (path: string, user: 'a' | 'b', init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init,
    headers: { Authorization: `Bearer fixture-user-${user}`, ...(init.headers ?? {}) } });
  const chat = { requestId: '33333333-3333-4333-8333-333333333333', question: 'Kolik mám v portfoliu?', lang: 'cs' };
  const first = await readAgentEvents(await call('/functions/v1/agent/chat', 'a', { method: 'POST', body: JSON.stringify(chat) }));
  const meta = first[0] as Extract<AgentEvent, { type: 'meta' }>;
  expect(meta).toMatchObject({ type: 'meta', remainingToday: 19 });
  const retry = await readAgentEvents(await call('/agent/chat', 'a', { method: 'POST', body: JSON.stringify(chat) }));
  expect(retry.find(e => e.type === 'answer')).toEqual(first.find(e => e.type === 'answer'));
  expect(retry.at(-1)).toMatchObject({ type: 'done', persisted: true });
  const threads = await (await call('/agent/threads', 'a')).json();
  expect(threads.threads).toEqual([expect.objectContaining({ id: meta.threadId, title: 'Kolik mám v portfoliu?' })]);
  const history = await (await call(`/agent/threads/${meta.threadId}`, 'a')).json();
  expect(history.messages.map((m: { role: string; seq: number }) => `${m.seq}:${m.role}`)).toEqual(['1:user', '2:assistant']);
  expect((await call('/agent/threads', 'b').then(r => r.json())).threads).toEqual([]);
  expect((await call(`/agent/threads/${meta.threadId}`, 'b')).status).toBe(404);
  expect((await call(`/agent/threads/${meta.threadId}`, 'b', { method: 'DELETE' })).status).toBe(404);
  const foreign = await readAgentEvents(await call('/agent/chat', 'b', { method: 'POST', body: JSON.stringify({ ...chat, requestId: '44444444-4444-4444-8444-444444444444', threadId: meta.threadId }) }));
  expect(foreign.find(e => e.type === 'error')).toMatchObject({ code: 'conflict' });
  expect((await call(`/agent/threads/${meta.threadId}`, 'a', { method: 'DELETE' })).status).toBe(204);
  expect((await call(`/agent/threads/${meta.threadId}`, 'a')).status).toBe(404);
  expect((await fetch(`${server.url}/agent/threads`)).status).toBe(401);
});
it('serves tool schemas, loopback-only direct tools and the local eval audit', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0, agent: { keys: {} } });
  servers.push(server);
  const auth = { Authorization: 'Bearer fixture-user-a' };
  const tools = await (await fetch(`${server.url}/agent/tools`, { headers: auth })).json();
  expect(tools.tools.length).toBeGreaterThan(10);
  const quote = await (await fetch(`${server.url}/agent/tools/get_quote`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId: '55555555-5555-4555-8555-555555555555', args: { ticker: 'SYNA' } }) })).json();
  expect(quote).toMatchObject({ ok: true });
  const requestId = '66666666-6666-4666-8666-666666666666';
  await readAgentEvents(await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ requestId, question: 'Kolik mám v portfoliu?' }) }));
  const audit = await (await fetch(`${server.url}/agent/eval/runs/${requestId}`, { headers: auth })).json();
  expect(audit).toMatchObject({ snapshotId: 'fixture-A' });
  expect(audit.facts.length).toBeGreaterThan(0);
  expect((await fetch(`${server.url}/agent/eval/runs/${requestId}`, { headers: { Authorization: 'Bearer fixture-user-b' } })).status).toBe(404);
});
it('a disabled runner answers 503 on every route', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0, agent: { keys: {} }, enabled: false });
  servers.push(server);
  for (const path of ['/agent/chat', '/agent/threads']) {
    const response = await fetch(`${server.url}${path}`, { method: path.endsWith('chat') ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-user-a' },
      ...(path.endsWith('chat') ? { body: JSON.stringify(input) } : {}) });
    expect(response.status).toBe(503);
    await response.text();
  }
});
it('fails explicitly on EOF without done', async () => {
  await expect(readAgentEvents(new Response('data: {"type":"status","text":"Pracuji"}\n\n'))).rejects.toThrow('done');
});
const config = getTestDbConfig();
if (!config) console.info(TEST_DB_SKIP);
it.skipIf(!config)('verifies real Auth A/B through HTTP (not RLS evidence yet)', async () => {
  const server = await startAgentServer({ port: 0 });
  servers.push(server);
  for (const user of ['A', 'B'] as const) {
    const { jwt } = await signInTestUser(user);
    const response = await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify(input) });
    expect((await readAgentEvents(response)).find(e => e.type === 'answer')).toMatchObject({ text: 'Hodnota ukázky je 123 USD.' });
  }
});

it('gives every numbered fixture identity its own history and quota (eval runner)', async () => {
  const server = await startAgentServer({ fixtureAuth: true, port: 0, agent: { keys: {} } });
  servers.push(server);
  const ask = async (token: string) => readAgentEvents(await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: crypto.randomUUID(), question: 'Kolik mám v portfoliu?' }) }));
  const first = await ask('fixture-user-a-1'), second = await ask('fixture-user-a-2');
  expect(first.find(e => e.type === 'meta')).toMatchObject({ remainingToday: 19 });
  expect(second.find(e => e.type === 'meta')).toMatchObject({ remainingToday: 19 });
  const threads = async (token: string) => (await (await fetch(`${server.url}/agent/threads`, { headers: { Authorization: `Bearer ${token}` } })).json()).threads;
  expect(await threads('fixture-user-a-1')).toHaveLength(1);
  expect(await threads('fixture-user-a-3')).toHaveLength(0);
  // Fixture users are A–E (Běh 20: C/D/E are eval data-quality users); anything else stays unauthenticated.
  expect((await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: 'Bearer fixture-user-f-1' }, body: JSON.stringify(input) })).status).toBe(401);
  expect((await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: 'Bearer fixture-user' }, body: JSON.stringify(input) })).status).toBe(401);
});

// Běh 11: the runner with real test-project storage and portfolio reads under the caller's JWT (RLS path of the
// Edge entrypoint), synthetic market data, no model key. Requests are tracked so the session cleanup removes them.
it.skipIf(!config)('real A/B JWTs over HTTP: 401, own thread CRUD, foreign 404, exact retry, delete', async () => {
  await withTestDb(async s => {
    const server = await startAgentServer({ port: 0, agent: { keys: {} } });
    servers.push(server);
    const chat = async (user: 'A' | 'B', body: Record<string, unknown>) => {
      s.track(body.requestId as string);
      return readAgentEvents(await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${s.users[user].jwt}` }, body: JSON.stringify(body) }));
    };
    const get = (user: 'A' | 'B', path: string, method = 'GET') => fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${s.users[user].jwt}` } });
    expect((await fetch(`${server.url}/agent/threads`)).status).toBe(401);
    expect((await fetch(`${server.url}/agent/threads`, { headers: { Authorization: 'Bearer not-a-jwt' } })).status).toBe(401);
    const body = { requestId: crypto.randomUUID(), question: 'Synthetic fixture question about my portfolio' };
    const first = await chat('A', body);
    const threadId = (first.find(e => e.type === 'meta') as { threadId: string }).threadId;
    expect(first.at(-1)).toMatchObject({ type: 'done', persisted: true });
    expect((await (await get('A', '/agent/threads')).json()).threads.map((t: { id: string }) => t.id)).toContain(threadId);
    expect((await (await get('B', '/agent/threads')).json()).threads.map((t: { id: string }) => t.id)).not.toContain(threadId);
    expect((await get('B', `/agent/threads/${threadId}`)).status).toBe(404);
    expect((await get('B', `/agent/threads/${threadId}`, 'DELETE')).status).toBe(404);
    const replay = await chat('A', body);
    expect((replay.find(e => e.type === 'answer') as { text: string }).text).toBe((first.find(e => e.type === 'answer') as { text: string }).text);
    expect((replay.find(e => e.type === 'meta') as { remainingToday: number }).remainingToday)
      .toBe((first.find(e => e.type === 'meta') as { remainingToday: number }).remainingToday);
    expect((await get('A', `/agent/threads/${threadId}`)).status).toBe(200);
    expect((await get('A', `/agent/threads/${threadId}`, 'DELETE')).status).toBe(204);
    expect((await get('A', `/agent/threads/${threadId}`)).status).toBe(404);
  });
}, 240000);

it.skipIf(!config)('real JWT: two panels in one thread, cancel and retry after EOF end without a hang', async () => {
  await withTestDb(async s => {
    const server = await startAgentServer({ port: 0, agent: { keys: {} } });
    servers.push(server);
    const post = (body: Record<string, unknown>, signal?: AbortSignal) => {
      s.track(body.requestId as string);
      return fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${s.users.A.jwt}` }, body: JSON.stringify(body), signal });
    };
    const opened = await readAgentEvents(await post({ requestId: crypto.randomUUID(), question: 'Synthetic fixture question' }));
    const threadId = (opened.find(e => e.type === 'meta') as { threadId: string }).threadId;
    const [one, two] = await Promise.all([1, 2].map(async () => readAgentEvents(await post({ requestId: crypto.randomUUID(), threadId, question: 'Synthetic parallel question' }))));
    const outcomes = [one, two].map(events => events.find(e => e.type === 'answer') ? 'answer' : (events.find(e => e.type === 'error') as { code: string } | undefined)?.code);
    expect(outcomes.sort()).toEqual(['answer', 'conflict']);
    // The client drops the stream after the first event (EOF for it); the exact retry must end, never hang.
    const controller = new AbortController();
    const body = { requestId: crypto.randomUUID(), threadId, question: 'Synthetic cancelled question' };
    const response = await post(body, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    const retry = await readAgentEvents(await post(body));
    expect(retry.at(-1)).toMatchObject({ type: 'done' });
    expect(retry.some(e => e.type === 'answer' || e.type === 'error')).toBe(true);
  });
}, 240000);

it.skipIf(!config)('real JWT: concurrent HTTP questions run one at a time; A gets 20 answers in a row and then a quota error', async () => {
  await withTestDb(async s => {
    const server = await startAgentServer({ port: 0, agent: { keys: {} } });
    servers.push(server);
    const ask = async () => {
      const requestId = crypto.randomUUID();
      s.track(requestId);
      return readAgentEvents(await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${s.users.A.jwt}` },
        body: JSON.stringify({ requestId, question: 'Synthetic quota question' }) }));
    };
    const code = (events: Awaited<ReturnType<typeof ask>>) => (events.find(e => e.type === 'error') as { code?: string } | undefined)?.code;
    // Audit A1: a burst gives one answer; the others are told the previous answer is still being prepared.
    const burst = await Promise.all(Array.from({ length: 5 }, ask));
    const answered = burst.filter(events => events.some(e => e.type === 'answer')).length;
    expect(answered).toBeGreaterThanOrEqual(1);
    expect(burst.filter(events => code(events) === 'conflict')).toHaveLength(5 - answered);
    for (let n = answered; n < 20; n++) expect((await ask()).some(e => e.type === 'answer')).toBe(true);
    expect(code(await ask())).toBe('quota');
  });
}, 240000);
