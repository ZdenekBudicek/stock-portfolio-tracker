import { createRequestBudget, withTimeout } from './core/budget.ts';
import type { RequestBudget } from './core/budget.ts';
import { parseChatRequest } from './core/protocol.ts';
import type { AgentEvent, ChatRequest } from './core/protocol.ts';
import type { VerifiedUser } from './live/auth.ts';

export type HandlerDeps = {
  authenticate: (req: Request, signal: AbortSignal) => Promise<VerifiedUser | null>;
  chat: (input: ChatRequest, user: VerifiedUser, budget: RequestBudget) => AsyncIterable<AgentEvent>;
  /** Every other `/agent/...` route, called only after authentication; null means 404. */
  dispatch?: (req: Request, user: VerifiedUser, budget: RequestBudget) => Promise<Response | null>;
  /** The operational switch (AGENT_ENABLED): when false every route is 503 before auth, storage or models. */
  enabled?: boolean;
  now: () => number;
  allowedOrigins: readonly string[];
};
const MAX_BODY_BYTES = 32 * 1024;

/** `/functions/v1/agent/x` and `/agent/x` → `/agent/x`, normalized once; anything else is null. */
export function agentPath(url: string): string | null {
  const path = new URL(url).pathname.replace(/^\/functions\/v1(?=\/agent(\/|$))/, '').replace(/\/+$/, '');
  return path === '/agent' || path.startsWith('/agent/') ? path : null;
}

/** Reads a JSON body of at most 32 KiB, whatever Content-Length claims. */
export async function readBody(req: Request, signal: AbortSignal): Promise<unknown> {
  if (Number(req.headers.get('Content-Length')) >= MAX_BODY_BYTES) throw new RangeError('Body too large');
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size >= MAX_BODY_BYTES) { cancel(); throw new RangeError('Body too large'); }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function makeHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async req => {
    const lifetime = new AbortController();
    const abort = () => lifetime.abort(req.signal.reason);
    req.signal.addEventListener('abort', abort, { once: true });
    if (req.signal.aborted) abort();
    const budget = createRequestBudget(deps.now, lifetime.signal);
    const cleanup = () => { req.signal.removeEventListener('abort', abort); lifetime.abort(); };
    const origin = req.headers.get('Origin');
    const headers = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store' });
    if (origin && deps.allowedOrigins.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'authorization, content-type, apikey, x-client-info');
    }
    const fail = (status: number, text: string) => {
      cleanup();
      return new Response(JSON.stringify({ text }), { status, headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' } });
    };
    // Thread history, tool schemas and test-only routes: authenticated first, then the dispatcher.
    const route = async (): Promise<Response> => {
      let response: Response | null;
      try {
        const user = await withTimeout(signal => deps.authenticate(req, signal), budget.remainingMs(), budget);
        if (!user) return fail(401, 'Přihlas se prosím znovu.');
        response = deps.dispatch ? await withTimeout(signal => deps.dispatch!(req, user, { ...budget, signal }), budget.remainingMs(), budget) : null;
      } catch (error) {
        const name = error instanceof Error || error instanceof DOMException ? error.name : '';
        if (name === 'TimeoutError') return fail(504, 'Čas na odpověď vypršel.');
        if (lifetime.signal.aborted) return fail(499, 'Dotaz byl zrušen.');
        return fail(503, 'Historie teď není dostupná. Zkus to prosím později.');
      }
      if (!response) return fail(404, 'Nenalezeno.');
      cleanup();
      const merged = new Headers(response.headers);
      headers.forEach((value, key) => merged.set(key, value));
      return new Response(response.body, { status: response.status, headers: merged });
    };
    const path = agentPath(req.url);
    if (!path) return fail(404, 'Nenalezeno.');
    if (origin && !deps.allowedOrigins.includes(origin)) return fail(403, 'Tento původ není povolen.');
    if (req.method === 'OPTIONS') { cleanup(); return new Response(null, { status: 204, headers }); }
    if (deps.enabled === false) return fail(503, 'Asistent je teď vypnutý. Zbytek Trackory funguje normálně.');
    if (path !== '/agent/chat') return route();
    if (req.method !== 'POST') return fail(405, 'Použij odeslání dotazu.');
    let user: VerifiedUser | null;
    let input: ChatRequest;
    try {
      user = await withTimeout(signal => deps.authenticate(req, signal), budget.remainingMs(), budget);
      if (!user) return fail(401, 'Přihlas se prosím znovu.');
      input = parseChatRequest(await withTimeout(signal => readBody(req, signal), budget.remainingMs(), budget));
    } catch (error) {
      const name = error instanceof Error || error instanceof DOMException ? error.name : '';
      if (name === 'TimeoutError') return fail(504, 'Čas na odpověď vypršel.');
      if (lifetime.signal.aborted) return fail(499, 'Dotaz byl zrušen.');
      if (error instanceof RangeError) return fail(413, 'Dotaz je příliš velký.');
      return fail(user! ? 400 : 503, user! ? 'Dotaz nemá platný formát.' : 'Přihlášení teď nelze ověřit.');
    }
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    headers.set('X-Accel-Buffering', 'no');
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: AgentEvent) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
        let iterator: AsyncIterator<AgentEvent> | undefined;
        try {
          await withTimeout(async signal => {
            iterator = deps.chat(input, user!, { ...budget, signal })[Symbol.asyncIterator]();
            while (!signal.aborted) {
              const next = await iterator.next();
              if (signal.aborted || closed) return;
              if (next.done) throw new Error('Missing terminal event');
              emit(next.value);
              if (next.value.type === 'done') return;
            }
          }, budget.remainingMs(), budget);
        } catch (error) {
          const timeout = (error as { name?: string })?.name === 'TimeoutError';
          const cancelled = lifetime.signal.aborted;
          if (!cancelled) emit({ type: 'error', code: timeout ? 'timeout' : 'failed', text: timeout ? 'Čas na odpověď vypršel.' : 'Odpověď se nepodařila. Zkus to znovu.' });
          emit({ type: 'done', requestId: input.requestId, persisted: false, outcome: cancelled ? 'cancelled' : timeout ? 'timeout' : 'error' });
        } finally {
          cleanup();
          // An uncooperative iterator must not hold the response beyond its deadline.
          void iterator?.return?.().catch(() => {});
          if (!closed) { closed = true; controller.close(); }
        }
      },
      cancel() { closed = true; cleanup(); },
    });
    return new Response(stream, { headers });
  };
}
