// How the chat panel reaches the assistant. `live` calls the Edge function with the user's current
// access token; `fixture` talks only to the loopback test runner (dev builds); `demo` replays
// synthetic answers in the browser and has no network path at all. Model and market keys never
// appear here: they live only in the server's environment.
import type { AgentEvent, ChatRequest } from '../../supabase/functions/agent/core/protocol.ts';
import type { Thread, ThreadHistory } from '../../supabase/functions/agent/core/dataTypes.ts';
import { createSseParser } from '@/lib/sse';

export type { Thread, ThreadHistory };
export type AssistantTransport = {
  stream(input: ChatRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  threads(signal: AbortSignal): Promise<Thread[]>;
  history(id: string, signal: AbortSignal): Promise<ThreadHistory>;
  remove(id: string, signal: AbortSignal): Promise<void>;
};
export type TransportMode = 'live' | 'fixture' | 'demo';

/** An HTTP error before the stream started (auth, limit, disabled, server). */
export class AssistantHttpError extends Error {
  readonly status: number;
  readonly retryAt?: string;
  constructor(status: number, retryAt?: string) { super(`Assistant HTTP ${status}`); this.status = status; this.retryAt = retryAt; }
}

/**
 * The UI switch: on unless VITE_ASSISTANT_ENABLED is exactly `false` (a new build is needed to change it).
 * The server flag AGENT_ENABLED is the operational kill switch; switched off, the panel shows a clear error.
 */
export function readAssistantConfig(env: Record<string, unknown>): { enabled: boolean; mode: TransportMode } {
  const wanted = env.VITE_ASSISTANT_TRANSPORT;
  // The static public demo (vite --mode demo) always replays fixed answers; it has no network path to any assistant.
  const mode: TransportMode = wanted === 'demo' || env.MODE === 'demo' ? 'demo' : wanted === 'fixture' && env.DEV === true ? 'fixture' : 'live';
  return { enabled: env.VITE_ASSISTANT_ENABLED !== 'false', mode };
}
export const assistantConfig = () => readAssistantConfig(import.meta.env as unknown as Record<string, unknown>);

type Deps = { fetchImpl?: typeof fetch; baseUrl?: string; token?: () => Promise<string | null>; delayMs?: number };
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/** Stops waiting even when authentication or a custom transport ignores cancellation. */
export function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try { work().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); }); }
    catch (error) { cleanup(); reject(error); }
  });
}

export async function* abortableEvents(events: AsyncIterable<AgentEvent>, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await abortable(() => iterator.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } finally { void iterator.return?.().catch(() => {}); }
}

async function liveToken(): Promise<string | null> {
  // Loaded only for the live transport, so a demo build never touches the family project.
  const { supabase } = await import('@/integrations/supabase/client');
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** The demo replay (fixed answers over invented data) is loaded on first use, so the app's bundle never carries it. */
function demoTransport(delayMs?: number): AssistantTransport {
  let replay: Promise<AssistantTransport> | null = null;
  const get = () => (replay ??= import('@/demo/assistantReplay').then(m => m.createReplayTransport({ delayMs })));
  return {
    async *stream(input, signal) { yield* (await get()).stream(input, signal); },
    threads: async signal => (await get()).threads(signal),
    history: async (id, signal) => (await get()).history(id, signal),
    remove: async (id, signal) => (await get()).remove(id, signal),
  };
}

export function createAssistantTransport(mode: TransportMode, deps: Deps = {}): AssistantTransport {
  if (mode === 'demo') return demoTransport(deps.delayMs);
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const base = (deps.baseUrl ?? (mode === 'fixture' ? `${env.VITE_ASSISTANT_FIXTURE_URL ?? 'http://127.0.0.1:8787'}/agent`
    : `${env.VITE_SUPABASE_URL ?? ''}/functions/v1/agent`)).replace(/\/$/, '');
  if (mode === 'fixture' && !LOOPBACK.test(base)) throw new Error('The fixture transport only talks to a loopback runner');
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const token = deps.token ?? (mode === 'fixture' ? async () => `fixture-user-${env.VITE_ASSISTANT_FIXTURE_USER === 'b' ? 'b' : 'a'}` : liveToken);

  async function call(path: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    // Always the current token: Supabase refreshes it, the panel never keeps one.
    const jwt = await abortable(token, init.signal);
    if (init.signal.aborted) throw init.signal.reason;
    if (!jwt) throw new AssistantHttpError(401);
    const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (mode === 'live' && env.VITE_SUPABASE_PUBLISHABLE_KEY) headers.apikey = env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const response = await abortable(() => fetchImpl(`${base}${path}`, { ...init, headers, redirect: 'error', cache: 'no-store' }), init.signal);
    if (!response.ok) {
      let retryAt: string | undefined;
      try { const body = await abortable(() => response.json(), init.signal); if (typeof body?.retryAt === 'string') retryAt = body.retryAt; } catch { /* no JSON body */ }
      throw new AssistantHttpError(response.status, retryAt);
    }
    return response;
  }

  return {
    async *stream(input, signal) {
      const response = await call('/chat', { method: 'POST', body: JSON.stringify(input), signal });
      if (!response.body) throw new AssistantHttpError(response.status);
      const reader = response.body.getReader();
      const parser = createSseParser();
      try {
        while (true) {
          const { done, value } = await abortable(() => reader.read(), signal);
          for (const event of done ? parser.finish() : parser.push(value)) {
            yield event;
            if (event.type === 'done') return;
          }
          if (done) return;
        }
      } finally { void reader.cancel().catch(() => {}); }
    },
    async threads(signal) { return (await (await call('/threads', { method: 'GET', signal })).json()).threads as Thread[]; },
    async history(id, signal) { return await (await call(`/threads/${encodeURIComponent(id)}`, { method: 'GET', signal })).json() as ThreadHistory; },
    async remove(id, signal) { await call(`/threads/${encodeURIComponent(id)}`, { method: 'DELETE', signal }); },
  };
}
