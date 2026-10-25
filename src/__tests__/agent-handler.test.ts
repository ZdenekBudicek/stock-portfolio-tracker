// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHandler } from '../../supabase/functions/agent/handler.ts';
import type { HandlerDeps } from '../../supabase/functions/agent/handler.ts';
import { verifyUser } from '../../supabase/functions/agent/live/auth.ts';
import { createRequestBudget, withTimeout } from '../../supabase/functions/agent/core/budget.ts';
import type { AgentEvent, ChatRequest } from '../../supabase/functions/agent/core/protocol.ts';
import { readAgentEvents } from '../test/agentSmokeTransport.ts';

const requestId = '11111111-1111-4111-8111-111111111111';
const input = { requestId, question: 'Jaká je hodnota ukázky?', lang: 'cs' };
const origin = 'http://localhost:5173';
function request(body = JSON.stringify(input), path = '/agent/chat', signal?: AbortSignal) {
  return new Request(`http://localhost${path}`, { method: 'POST', headers: { Authorization: 'Bearer valid', Origin: origin }, body, signal });
}
function setup() {
  const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify(
    init.headers.Authorization === 'Bearer valid' ? { id: requestId } : { error: 'invalid' },
  ), { status: init.headers.Authorization === 'Bearer valid' ? 200 : 401 }));
  const chat = vi.fn(async function* (value: ChatRequest): AsyncIterable<AgentEvent> {
    yield { type: 'meta', requestId: value.requestId, threadId: requestId, remainingToday: null };
    yield { type: 'status', text: 'Pracuji…' };
    yield { type: 'answer', text: 'Hodnota ukázky je 123 USD.', links: [], verified: true };
    yield { type: 'done', requestId, persisted: false, outcome: 'ok' };
    yield { type: 'done', requestId, persisted: false, outcome: 'ok' };
  });
  const deps: HandlerDeps = { authenticate: (req: Request, signal: AbortSignal) => verifyUser(req, { url: 'http://localhost:54321', anonKey: 'synthetic', fetchImpl }, signal), chat, now: () => Date.now(), allowedOrigins: [origin] };
  return { handler: makeHandler(deps), deps, chat, fetchImpl };
}
afterEach(() => vi.useRealTimers());

describe('agent handler', () => {
  it.each(['/agent/chat', '/functions/v1/agent/chat'])('streams a verified synthetic answer at %s', async path => {
    const response = await setup().handler(request(undefined, path));
    const raw = await response.text();
    expect(raw.match(/"type":"done"/g)).toHaveLength(1);
    const events = await readAgentEvents(new Response(raw));
    expect(events.map(e => e.type)).toEqual(['meta', 'status', 'answer', 'done']);
    expect(events[2]).toMatchObject({ text: 'Hodnota ukázky je 123 USD.', verified: true });
  });
  it.each([null, 'forged', 'expired'])('rejects JWT %s before chat', async token => {
    const { handler, chat, fetchImpl } = setup();
    const req = request();
    if (token) req.headers.set('Authorization', `Bearer ${token}`);
    else req.headers.delete('Authorization');
    expect((await handler(req)).status).toBe(401);
    expect(chat).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(token ? 1 : 0);
    if (token) expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  it('allows only listed CORS origins', async () => {
    const { handler, chat } = setup();
    const preflight = (value: string) => new Request('http://localhost/agent/chat', { method: 'OPTIONS', headers: { Origin: value, 'Access-Control-Request-Method': 'POST' } });
    const allowed = await handler(preflight(origin));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect((await handler(preflight('https://evil.invalid'))).status).toBe(403);
    expect(chat).not.toHaveBeenCalled();
  });
  it.each([
    ['{', 400], [JSON.stringify({ ...input, question: 'x'.repeat(2001) }), 400],
    [' '.repeat(32768), 413], [JSON.stringify({ ...input, requestId: 'invalid' }), 400],
    [JSON.stringify({ ...input, preferences: { displayCurrency: 'XXX' } }), 400],
  ])('rejects invalid body before chat (%#)', async (body, status) => {
    const { handler, chat } = setup();
    expect((await handler(request(body))).status).toBe(status);
    expect(chat).not.toHaveBeenCalled();
  });
  it('rejects unknown routes and methods', async () => {
    const { handler } = setup();
    expect((await handler(request(undefined, '/chat'))).status).toBe(404);
    expect((await handler(new Request('http://localhost/agent/chat'))).status).toBe(405);
  });
  it('aborts work when the reader cancels', async () => {
    const { deps } = setup();
    let signal: AbortSignal;
    deps.chat = vi.fn(async function* (_input, _user, budget) {
      signal = budget.signal;
      yield { type: 'status', text: 'Pracuji…' } as AgentEvent;
      await new Promise(() => {});
    });
    const response = await makeHandler(deps)(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal!.aborted).toBe(true);
  });
  it('aborts work on request cancellation', async () => {
    const { deps } = setup();
    const controller = new AbortController();
    let signal: AbortSignal;
    deps.chat = vi.fn(async function* (_input, _user, budget) {
      signal = budget.signal;
      yield { type: 'status', text: 'Pracuji…' } as AgentEvent;
      await new Promise(() => {});
    });
    const response = await makeHandler(deps)(request(undefined, undefined, controller.signal));
    controller.abort();
    await response.text();
    expect(signal!.aborted).toBe(true);
  });
  it('terminates a stalled producer at the original 45 second deadline', async () => {
    vi.useFakeTimers();
    const { deps } = setup();
    // eslint-disable-next-line require-yield -- This producer deliberately never emits an event.
    deps.chat = vi.fn(async function* () { await new Promise(() => {}); });
    const response = await makeHandler(deps)(request());
    const result = readAgentEvents(response);
    await vi.advanceTimersByTimeAsync(45000);
    expect((await result).map(e => e.type)).toEqual(['error', 'done']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('includes authentication in the deadline even when it ignores abort', async () => {
    vi.useFakeTimers();
    const { deps, chat } = setup();
    deps.authenticate = () => new Promise(() => {});
    const result = makeHandler(deps)(request());
    await vi.advanceTimersByTimeAsync(45000);
    expect((await result).status).toBe(504);
    expect(chat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports producer failure and EOF without claiming success', async () => {
    const { deps } = setup();
    // eslint-disable-next-line require-yield -- This producer deliberately never emits an event.
    deps.chat = vi.fn(async function* () { throw new Error('private details'); });
    const events = await readAgentEvents(await makeHandler(deps)(request()));
    expect(events.map(e => e.type)).toEqual(['error', 'done']);
    expect(JSON.stringify(events)).not.toContain('private details');
    expect(events[1]).toMatchObject({ outcome: 'error', persisted: false });
  });
  it('turns producer EOF into a single error terminal event', async () => {
    const { deps } = setup();
    deps.chat = vi.fn(async function* (): AsyncIterable<AgentEvent> { yield { type: 'status', text: 'Pracuji…' }; });
    const events = await readAgentEvents(await makeHandler(deps)(request()));
    expect(events.map(e => e.type)).toEqual(['status', 'error', 'done']);
    expect(events[2]).toMatchObject({ persisted: false, outcome: 'error' });
  });
  it('ignores a body owner and passes only the verified identity to chat', async () => {
    const { handler, chat } = setup();
    await readAgentEvents(await handler(request(JSON.stringify({ ...input, user_id: 'foreign-user' }))));
    expect(chat.mock.calls[0][0]).not.toHaveProperty('user_id');
    expect(chat).toHaveBeenCalledWith(expect.anything(), { id: requestId, jwt: 'valid' }, expect.anything());
  });
  it('does not reset the total deadline after slow authentication', async () => {
    vi.useFakeTimers();
    const { deps } = setup();
    deps.authenticate = async () => { await new Promise(resolve => setTimeout(resolve, 40000)); return { id: requestId, jwt: 'valid' }; };
    // eslint-disable-next-line require-yield -- This producer deliberately never emits an event.
    deps.chat = vi.fn(async function* () { await new Promise(() => {}); });
    const response = makeHandler(deps)(request());
    await vi.advanceTimersByTimeAsync(40000);
    const events = readAgentEvents(await response);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await events).at(-1)).toMatchObject({ outcome: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('includes stalled body reads in the deadline and cancels the body reader', async () => {
    vi.useFakeTimers();
    const { handler, chat } = setup();
    const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel });
    const req = new Request('http://localhost/agent/chat', { method: 'POST', headers: { Authorization: 'Bearer valid' }, body, duplex: 'half' } as RequestInit);
    const response = handler(req);
    await vi.advanceTimersByTimeAsync(45000);
    expect((await response).status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('request budget', () => {
  it('caps a child timeout by remaining total time and aborts its work', async () => {
    vi.useFakeTimers();
    const budget = createRequestBudget(Date.now, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(44000);
    let signal: AbortSignal;
    const result = withTimeout(s => { signal = s; return new Promise(() => {}); }, 8000, budget);
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('settles immediately for an already aborted parent', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn();
    await expect(withTimeout(work, 8000, createRequestBudget(Date.now, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).not.toHaveBeenCalled();
  });
});
