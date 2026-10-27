// Nightly analyst snapshots (targets, recommendation counts, rating changes) from Yahoo
// quoteSummary, run from GitHub Actions only: Yahoo rejects Supabase edge IPs and the agent's
// Edge function never calls Yahoo — it reads analyst_snapshots (see agent/live/market.ts).
// Its TTL/retry (analystsDue) is independent of fundamentalsDue and the fundamentals queue.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (worker-only; never part of the chat path) and
// AGENT_MARKET_ENABLED=true. Importing this file never performs IO.
import { pathToFileURL } from 'node:url';
import { analystsDue, parseAnalystSnapshot } from './analyst-snapshot.mjs';
import { askedPositions, fundamentalsSymbols } from './fundamentals-worker.mjs';
import { parseOnlySymbols } from './only-symbols.mjs';
import { NASDAQ_HEADERS, nasdaqForecastUrl, parseNasdaqSnapshot } from '../supabase/functions/_shared/companyData.js';

/** Ocenění v3: Yahoo's current and next fiscal year plus up to two later years of consensus EPS from Nasdaq. */
export function withLaterYears(view, nasdaq) {
  const known = (view.estimates ?? []).map((e) => e.endDate).filter(Boolean).sort();
  const last = known[known.length - 1] ?? '';
  const later = (nasdaq?.estimates ?? []).filter((e) => e.endDate > last).slice(0, 2).map((e) => ({ ...e, period: 'later' }));
  return later.length && view.estimates?.length ? { ...view, estimates: [...view.estimates, ...later] } : view;
}

const up = (value) => String(value ?? '').trim().toUpperCase();
const PAGE = 1000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_000_000;
const UA = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
// `price` carries the trading currency, which is the currency of the analysts' targets.
// earningsTrend: consensus EPS and revenue for the current and next fiscal year (Ocenění v2).
const MODULES = 'financialData,price,recommendationTrend,upgradeDowngradeHistory,earningsTrend';

/** Every row of one table, paged until a short page; any page error fails the whole run. */
async function readAll(db, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = await db.read(table, from, from + PAGE - 1);
    if (!Array.isArray(page) || page.length > PAGE) throw new Error(`Read ${table}: unexpected payload`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** Response text up to MAX_BYTES; a larger or unreadable body is a failure, not a partial parse. */
async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('Response too large'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Response too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Equity symbols of every position and watchlist row, without crypto, cash and funds. */
export function analystSymbols(positions, watchlist, aliases, profiles) {
  const funds = new Set([
    ...positions.filter((p) => /etf|fund/i.test(String(p.type ?? ''))).map((p) => up(p.ticker)),
    ...profiles.filter((p) => /etf|fund|crypto/i.test(String(p.asset_type ?? ''))).map((p) => up(p.ticker)),
  ]);
  return fundamentalsSymbols(positions, watchlist, aliases).filter(({ symbol }) => !funds.has(symbol));
}

// quoteSummary requires a cookie + crumb since 2023; without one each call is still tried.
async function yahooSession(fetchImpl) {
  try {
    const consent = await fetchImpl('https://fc.yahoo.com/', { headers: UA, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const raw = typeof consent.headers.getSetCookie === 'function' ? consent.headers.getSetCookie() : [consent.headers.get('set-cookie') ?? ''];
    await consent.body?.cancel();
    const cookie = raw.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) return null;
    // getcrumb answers plain text; `Accept: application/json` gets HTTP 406 and then every quote 401.
    const response = await fetchImpl('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...UA, Accept: '*/*', Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const crumb = response.ok ? (await boundedText(response)).trim() : '';
    if (!response.ok) await response.body?.cancel();
    return /^[A-Za-z0-9./_-]{1,64}$/.test(crumb) ? { cookie, crumb } : null;
  } catch {
    return null;
  }
}

export function analystUrl(yahooSymbol, crumb) {
  return `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${MODULES}`
    + (crumb ? `&crumb=${encodeURIComponent(crumb)}` : '');
}

/**
 * One run over the deduplicated equity union. All reads complete before the first write, so a
 * failed page never leads to a partial run. A failure PATCHes only status/last_attempt_at and
 * keeps the last good data and fetched_at; HTTP 429 stops the run, the rest waits for the next.
 * @param {{ db: { read(table: string, from: number, to: number): Promise<unknown[]>,
 *   write(symbol: string, patch: Record<string, unknown>, preserve: boolean): Promise<void> },
 *   fetchImpl?: typeof fetch, now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void }} deps
 */
export async function runAnalystWorker({
  db, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log, only = null,
}) {
  const tables = {};
  for (const table of ['positions', 'watchlist', 'ticker_alias', 'ticker_profiles', 'analyst_snapshots', 'fundamentals_requests']) tables[table] = await readAll(db, table);
  // On-demand (a company someone just added, ONLY_SYMBOLS): exactly those tickers, fresh or not, so the
  // valuation has the consensus the same day; ETFs and funds are still left out.
  const requested = (only ?? []).filter(Boolean);
  const symbols = requested.length
    ? analystSymbols(requested.map((ticker) => ({ ticker, shares: 1 })), [], tables.ticker_alias, tables.ticker_profiles)
    // Plus companies someone asked about recently (the assistant queues them), not only holdings and watchlists.
    : analystSymbols([...tables.positions, ...askedPositions(tables.fundamentals_requests, now())], tables.watchlist, tables.ticker_alias, tables.ticker_profiles);
  const prior = new Map(tables.analyst_snapshots.map((row) => [up(row.symbol), row]));
  const queue = requested.length ? symbols : symbols.filter(({ symbol }) => analystsDue(prior.get(symbol) ?? null, now()));
  // `unavailable`: no analyst coverage (an OTC or delisted symbol, an empty consensus) — an answer, not a failure.
  const summary = { updated: 0, failed: 0, unavailable: 0, skipped: symbols.length - queue.length };
  let session = queue.length ? await yahooSession(fetchImpl) : null;
  let renewed = false;

  for (const [index, { symbol, yahooSymbol }] of queue.entries()) {
    if (index > 0) await sleep(500); // sequential, at most ~2 requests/s
    let data, status = 'error', limited = false;
    try {
      let response = await fetchImpl(analystUrl(yahooSymbol, session?.crumb), {
        headers: session ? { ...UA, Cookie: session.cookie } : UA, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 && !renewed) {
        // An expired crumb is renewed once per run, then the symbol is retried.
        await response.body?.cancel(); renewed = true; session = await yahooSession(fetchImpl);
        response = await fetchImpl(analystUrl(yahooSymbol, session?.crumb), {
          headers: session ? { ...UA, Cookie: session.cookie } : UA, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      }
      limited = response.status === 429;
      // Yahoo does not know the symbol (delisted, OTC): no coverage, like an empty consensus.
      if (response.status === 404) status = 'unavailable';
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Yahoo HTTP ${response.status}`); }
      try {
        data = parseAnalystSnapshot(JSON.parse(await boundedText(response)), symbol);
        try {
          const forecast = await fetchImpl(nasdaqForecastUrl(yahooSymbol), { headers: NASDAQ_HEADERS, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (forecast.ok) data = withLaterYears(data, parseNasdaqSnapshot(JSON.parse(await boundedText(forecast)), null, symbol, new Date(now()).toISOString().slice(0, 10)));
          else await forecast.body?.cancel();
        } catch { /* Yahoo's two years stay */ }
      } catch (error) {
        if (String(error?.message).includes('empty')) status = 'unavailable';
        throw error;
      }
    } catch (error) {
      const attempt = new Date(now()).toISOString();
      await db.write(symbol, prior.has(symbol)
        ? { status, last_attempt_at: attempt }
        : { data: null, fetched_at: null, last_attempt_at: attempt, status }, prior.has(symbol));
      if (status === 'unavailable') summary.unavailable++; else summary.failed++;
      log(`${symbol}: ${String(error?.message ?? error).slice(0, 120)}`);
      if (limited) { summary.skipped += queue.length - index - 1; log('Yahoo rate limit: remaining symbols wait for the next run'); break; }
      continue;
    }
    const fetched = new Date(now()).toISOString();
    await db.write(symbol, { data, fetched_at: fetched, last_attempt_at: fetched, status: 'ok' }, false);
    summary.updated++;
  }
  log(`Analysts: ${summary.updated} updated, ${summary.failed} failed, ${summary.unavailable} without coverage, ${summary.skipped} not due or deferred`);
  return summary;
}

const QUERIES = {
  positions: 'positions?select=ticker,type,shares&shares=gt.0&order=id.asc',
  watchlist: 'watchlist?select=ticker&order=id.asc',
  ticker_alias: 'ticker_alias?select=alias,canonical,yahoo_symbol&order=alias.asc',
  ticker_profiles: 'ticker_profiles?select=ticker,asset_type&order=ticker.asc',
  analyst_snapshots: 'analyst_snapshots?select=symbol,fetched_at,last_attempt_at,status&order=symbol.asc',
  fundamentals_requests: 'fundamentals_requests?select=symbol,requested_at&order=symbol.asc',
};

/** Service-role PostgREST adapter; used only by this GitHub Actions worker. */
export function restAnalystDb(url, key, fetchImpl = fetch) {
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const root = `${url.replace(/\/$/, '')}/rest/v1/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    async read(table, from, to) {
      if (!QUERIES[table]) throw new Error('Unexpected table');
      const response = await fetchImpl(root + QUERIES[table], { headers: { ...headers, Range: `${from}-${to}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Read ${table}: HTTP ${response.status}`);
      return response.json();
    },
    async write(symbol, patch, preserve) {
      const path = preserve ? `analyst_snapshots?symbol=eq.${encodeURIComponent(symbol)}` : 'analyst_snapshots?on_conflict=symbol';
      // A first failed attempt must not overwrite data a parallel run has just stored.
      const prefer = preserve ? 'return=minimal' : `resolution=${patch.status === 'ok' ? 'merge' : 'ignore'}-duplicates,return=minimal`;
      const response = await fetchImpl(root + path, {
        method: preserve ? 'PATCH' : 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: prefer },
        body: JSON.stringify(preserve ? patch : { symbol, ...patch }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Write analyst_snapshots: HTTP ${response.status}`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.AGENT_MARKET_ENABLED !== 'true') {
    console.log('AGENT_MARKET_ENABLED is not true: analyst worker disabled');
  } else {
    let only = null;
    try { only = parseOnlySymbols(process.env.ONLY_SYMBOLS); } catch (e) { console.error(e.message); process.exit(1); }
    Promise.resolve()
      .then(() => runAnalystWorker({ db: restAnalystDb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY), only }))
      .then((summary) => { if (summary.failed && !summary.updated) process.exitCode = 1; })
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
