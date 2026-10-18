// Nightly Yahoo fundamentals, run from GitHub Actions (Yahoo rejects Supabase edge IPs).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Importing this file never performs IO.
import { pathToFileURL } from 'node:url';
import { isCryptoHolding } from '../supabase/functions/_shared/crypto.js';
import { normalizeYahooFundamentals, YAHOO_FUNDAMENTAL_METRICS } from '../supabase/functions/_shared/fundamentals.js';
import { parseOnlySymbols } from './only-symbols.mjs';

const up = (value) => String(value ?? '').trim().toUpperCase();
const FRESH_MS = 20 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

/** One row per canonical symbol, with the curated Yahoo spelling taking precedence. */
export function fundamentalsSymbols(positions, watchlist, aliases) {
  const byAlias = new Map(aliases.map((a) => [up(a.alias), a]));
  const yahooByCanonical = new Map();
  for (const a of aliases) {
    const canonical = up(a.canonical) || up(a.alias);
    const yahoo = String(a.yahoo_symbol ?? '').trim();
    if (yahoo && !yahooByCanonical.has(canonical)) yahooByCanonical.set(canonical, yahoo);
  }
  const selected = new Map();
  const holdings = positions.filter((p) => Number(p.shares) > 0);
  for (const p of [...holdings, ...watchlist]) {
    const ticker = up(p.ticker);
    const symbol = up(byAlias.get(ticker)?.canonical) || ticker;
    if (!symbol || symbol === 'CASH' || ticker === 'CASH' || up(p.type) === 'CASH') continue;
    const yahoo = String(byAlias.get(ticker)?.yahoo_symbol ?? '').trim() || yahooByCanonical.get(symbol);
    const pinnedEquity = !!yahoo && !/-USD$/i.test(yahoo);
    if (/-USD$/i.test(yahoo ?? '') || (!pinnedEquity && (isCryptoHolding(ticker, p.type) || isCryptoHolding(symbol, p.type)))) continue;
    selected.set(symbol, { symbol, yahooSymbol: yahoo || symbol.replace(/_US_EQ$/, '').replace(/_EQ$/, '').replace(/\.([ABC])$/, '-$1') });
    // Only share classes (BRK.B → BRK-B) take a dash; exchange suffixes (SAP.DE, VOD.L) stay.
  }
  return [...selected.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function fundamentalsFresh(row, now) {
  const fetched = Date.parse(row?.fetched_at);
  return Number.isFinite(fetched) && now - fetched < FRESH_MS;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Safety net: even without an earnings date in the calendar, refresh this often. */
export const MAX_AGE_DAYS = 30;
/** A symbol Yahoo has no statements for (ETFs, delisted) is retried this rarely. */
export const ERROR_RETRY_DAYS = 7;
/** After results are published, keep checking daily for this long until the new quarter shows up. */
export const EARNINGS_WINDOW_DAYS = 21;
/** The quarter announced in results ended at most this long before the announcement. */
export const REPORTED_QUARTER_MAX_DAYS = 80;

/**
 * Statements change once a quarter, so the nightly job only fetches what is due:
 * - never fetched (a company someone just added is fetched on demand anyway);
 * - results were published since the last fetch, or the stored quarters do not include the
 *   just-reported one yet (Yahoo can lag a few days) — daily within EARNINGS_WINDOW_DAYS;
 * - the safety-net age MAX_AGE_DAYS (restatements, a missing calendar entry);
 * - a symbol without statements only every ERROR_RETRY_DAYS.
 * Nothing is fetched twice within the same ~day (FRESH_MS).
 * @param {{ fetched_at?: string, last_attempt_at?: string | null, status?: string, qperiods?: string[] | null } | undefined} row
 * @param {string | undefined} lastEarnings latest earnings date (YYYY-MM-DD) on or before today
 */
export function fundamentalsDue(row, lastEarnings, now) {
  if (!row) return true;
  const fetched = Date.parse(row.fetched_at ?? '');
  if (!Number.isFinite(fetched)) return true;
  const age = now - fetched;
  if (age < FRESH_MS) return false;
  if (row.status === 'error') {
    // Spaced from the last ATTEMPT, so a symbol without statements is tried weekly, not daily.
    const tried = Date.parse(row.last_attempt_at ?? '');
    return now - (Number.isFinite(tried) ? Math.max(tried, fetched) : fetched) >= ERROR_RETRY_DAYS * DAY_MS;
  }
  if (age >= MAX_AGE_DAYS * DAY_MS) return true;
  if (!lastEarnings) return false;
  const reported = Date.parse(lastEarnings);
  // Results come before/after market; give Yahoo the day to pick them up.
  if (!Number.isFinite(reported) || now - reported < DAY_MS || now - reported > EARNINGS_WINDOW_DAYS * DAY_MS) return false;
  if (fetched <= reported + DAY_MS) return true; // first fetch after the results
  const newestQuarter = [...(row.qperiods ?? [])].sort().pop();
  // The just-reported quarter ended at most ~80 days before the results (10-Q within 40–45
  // days, slower filers a bit more); an older newest quarter means the new one is not in yet.
  return !newestQuarter || Date.parse(newestQuarter) < reported - REPORTED_QUARTER_MAX_DAYS * DAY_MS;
}

const emptySeries = () => ({ periods: [], values: Object.fromEntries(Object.values(YAHOO_FUNDAMENTAL_METRICS).map((m) => [m, []])) });

export function fundamentalsUrl(symbol, now) {
  const types = ['annual', 'quarterly'].flatMap((prefix) => Object.keys(YAHOO_FUNDAMENTAL_METRICS).map((m) => prefix + m));
  return `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`
    + `?type=${types.join(',')}&period1=1483228800&period2=${Math.floor(now / 1000) + 86400}`;
}

/** Injectable transport/clock for tests; production uses only the service-role REST API. */
export async function runFundamentalsWorker({
  url, key, fetchFn = fetch, now = Date.now(), only = [],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log,
}) {
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const root = `${url.replace(/\/$/, '')}/rest/v1/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const read = async (path) => {
    const rows = [];
    for (let start = 0; ; start += 1000) {
      const response = await fetchFn(root + path, {
        headers: { ...headers, Range: `${start}-${start + 999}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Read ${path.split('?')[0]}: HTTP ${response.status}`);
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error(`Read ${path.split('?')[0]}: unexpected payload`);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  };
  const write = async (path, method, payload, prefer = 'resolution=merge-duplicates,return=minimal') => {
    const response = await fetchFn(root + path, {
      method, headers: { ...headers, 'Content-Type': 'application/json', Prefer: prefer },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Write ${path.split("?")[0]}: HTTP ${response.status}`);
  };

  const today = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - (EARNINGS_WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const [positions, watchlist, aliases, existing, earnings] = await Promise.all([
    read('positions?select=ticker,type,shares&shares=gt.0&order=id.asc'),
    read('watchlist?select=ticker&order=id.asc'),
    read('ticker_alias?select=alias,canonical,yahoo_symbol&order=alias.asc'),
    read('company_fundamentals?select=symbol,fetched_at,last_attempt_at,status,qperiods:data->quarterly->periods&order=symbol.asc'),
    read(`earnings_calendar?select=ticker,earnings_date&earnings_date=gte.${since}&earnings_date=lte.${today}&order=earnings_date.asc`),
  ]);
  const lastEarnings = new Map();
  for (const e of earnings) lastEarnings.set(up(e.ticker), String(e.earnings_date).slice(0, 10)); // ascending → last wins
  const prior = new Map(existing.map((row) => [up(row.symbol), row]));
  // On-demand (a company someone just added): exactly the requested tickers, fresh or not.
  const requested = (only ?? []).filter(Boolean);
  const symbols = requested.length
    ? fundamentalsSymbols(requested.map((ticker) => ({ ticker, shares: 1 })), [], aliases)
    : fundamentalsSymbols(positions, watchlist, aliases);
  const queue = requested.length ? symbols : symbols.filter(({ symbol }) => fundamentalsDue(prior.get(symbol), lastEarnings.get(symbol), now));
  const summary = { updated: 0, failed: 0, skipped: symbols.length - queue.length };

  for (const [index, { symbol, yahooSymbol }] of queue.entries()) {
    // Sequential requests plus 500 ms between completions and starts: at most ~2/s.
    if (index > 0) await sleep(500);
    let data;
    let failure;
    try {
      const response = await fetchFn(fundamentalsUrl(yahooSymbol, now), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
      data = normalizeYahooFundamentals(await response.json(), symbol, new Date(now).toISOString());
      if (data.status !== 'ok') throw new Error('Yahoo returned no usable fundamentals');
    } catch (error) {
      failure = String(error?.message ?? error).slice(0, 500);
    }
    const attempt = new Date(now).toISOString();
    if (failure) {
      if (prior.has(symbol)) {
        // PATCH only: never replace good data, currency or the last successful fetched_at.
        await write(`company_fundamentals?symbol=eq.${encodeURIComponent(symbol)}`, 'PATCH', { status: 'error', last_error: failure, last_attempt_at: attempt });
      } else {
        // First-ever failure (an ETF has no statements): store the attempt so the app can say
        // so instead of 'not fetched yet', and the job retries only every ERROR_RETRY_DAYS.
        // ignore-duplicates: if a parallel run stored real data meanwhile, keep it.
        await write('company_fundamentals?on_conflict=symbol', 'POST', {
          symbol, data: { symbol, currency: 'USD', fetchedAt: attempt, status: 'error', annual: emptySeries(), quarterly: emptySeries() },
          currency: null, fetched_at: attempt, last_attempt_at: attempt, status: 'error', last_error: failure,
        }, 'resolution=ignore-duplicates,return=minimal');
      }
      summary.failed++;
      log(`${symbol}: ${failure}`);
    } else {
      await write('company_fundamentals?on_conflict=symbol', 'POST', {
        symbol, data, currency: data.currency, fetched_at: data.fetchedAt, last_attempt_at: attempt, status: 'ok', last_error: null,
      });
      summary.updated++;
    }
  }
  log(`Fundamentals: ${summary.updated} updated, ${summary.failed} failed, ${summary.skipped} not due`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let only = null;
  try { only = parseOnlySymbols(process.env.ONLY_SYMBOLS); } catch (e) { console.error(e.message); process.exit(1); }
  runFundamentalsWorker({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY, only })
    // ETFs and delisted symbols never have statements; only a run where nothing loaded is a failure.
    // On demand a missing company (ETF) is an answer, not a failure: finish-requests records it.
    .then((summary) => { if (!only && summary.failed && !summary.updated && !summary.skipped) process.exitCode = 1; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
