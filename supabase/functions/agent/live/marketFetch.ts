import { withTimeout } from '../core/budget.ts';
import type { ReadContext } from '../core/dataTypes.ts';

const paths: Readonly<Record<string, readonly string[]>> = {
  'finnhub.io': ['/api/v1/quote', '/api/v1/stock/recommendation', '/api/v1/company-news', '/api/v1/news', '/api/v1/stock/peers', '/api/v1/stock/metric', '/api/v1/search'],
  'api.twelvedata.com': ['/quote', '/time_series'],
  'api.coingecko.com': ['/api/v3/simple/price'],
  'api.binance.com': ['/api/v3/ticker/24hr'],
};
// JSON POST endpoints (search APIs that take their key in a header); never reachable with GET.
const postPaths: Readonly<Record<string, readonly string[]>> = {
  'api.tavily.com': ['/search'],
};
export type FetchDeps = { fetchImpl: typeof fetch; now: () => number };

export function marketOperation<T>(ctx: ReadContext, now: () => number, work: (ctx: ReadContext) => Promise<T>): Promise<T> {
  const deadline = Math.min(ctx.deadline, now() + 8000);
  return withTimeout(signal => work({ signal, deadline }), 8000, {
    ...ctx, startedAt: now(), remainingMs: () => Math.max(0, deadline - now()),
  });
}

// Reads the stream under the same deadline as the headers; never logs a URL/key/body.
export async function boundedJson(response: Response, signal: AbortSignal, maxBytes = 262144): Promise<unknown> {
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Market response unavailable');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('Market response too large'); }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    if (signal.aborted) throw new Error('Market request cancelled');
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('Market request cancelled');
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('Market response too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const pinned = (url: string, allow: Readonly<Record<string, readonly string[]>>): URL => {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.search || !allow[target.hostname]?.includes(target.pathname)) {
    throw new Error('Market destination rejected');
  }
  return target;
};

/**
 * A JSON POST to a pinned endpoint (Tavily search): bearer key in a header (never in the URL or body), no redirects,
 * the tool's abort signal and deadline, a response size cap, and provider errors inside HTTP 200 rejected.
 */
export function marketPostJson(url: string, body: Record<string, unknown>, bearer: string, deps: FetchDeps, ctx: ReadContext, maxBytes = 1_048_576): Promise<unknown> {
  return marketOperation(ctx, deps.now, async inner => {
    const target = pinned(url, postPaths);
    const response = await deps.fetchImpl(target.toString(), { method: 'POST', signal: inner.signal, redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const raw = await boundedJson(response, inner.signal, maxBytes);
    if (raw && typeof raw === 'object' && ('error' in raw || 'detail' in raw)) throw new Error('Market provider unavailable');
    return raw;
  });
}

export function marketFetch(url: string, deps: FetchDeps, ctx: ReadContext): Promise<unknown> {
  return marketOperation(ctx, deps.now, async inner => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !paths[target.hostname]?.includes(target.pathname)) {
      throw new Error('Market destination rejected');
    }
    const response = await deps.fetchImpl(target.toString(), { signal: inner.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    const raw = await boundedJson(response, inner.signal);
    if (raw && typeof raw === 'object' && ('error' in raw || ('status' in raw && raw.status === 'error'))) throw new Error('Market provider unavailable');
    return raw;
  });
}
