// Which companies a user's request should fetch right now (request-fundamentals edge function).
// Pure, no IO — tested in src/__tests__/fundamentals-requests.test.ts.
//
// Only companies nobody has data for yet are fetched on demand; everything already in
// company_fundamentals stays with the nightly job, which refreshes it after results. The final
// word on "already running" is the atomic reserve_fundamentals_requests in the database; this
// is the cheap pre-filter.
//
// Two keys per company: the TICKER as the user's data spells it (case kept — aliases such as
// 'BATSl' are case-sensitive and price_history is stored under it) and the canonical SYMBOL
// (upper case) that company_fundamentals and fundamentals_requests are keyed by.
import { isCryptoHolding } from './crypto.js';

export const MAX_TICKERS = 10;
/** A request still running is not repeated (a GitHub run takes ~1–3 minutes). */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** A finished request (also a failed one, e.g. an ETF) is not repeated for a day. */
export const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;

const up = (v) => String(v ?? '').trim().toUpperCase();
/** Letters (either case), digits, dot, dash, underscore; starts with a letter or digit. */
export const validTicker = (t) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(String(t ?? '').trim());

/** Raw tickers from the request: trimmed, valid, distinct (case-sensitive), capped. */
export function cleanTickers(tickers) {
  const out = [];
  for (const raw of Array.isArray(tickers) ? tickers : []) {
    const t = String(raw ?? '').trim();
    if (!validTicker(t) || up(t) === 'CASH' || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_TICKERS) break;
  }
  return out;
}

/** Canonical symbol for a raw ticker (alias lookup case-insensitive, as the hook does). */
export function canonicalOf(ticker, aliases) {
  const a = aliases.find((x) => up(x.alias) === up(ticker));
  return up(a?.canonical) || up(ticker);
}

/**
 * @param {{ tickers: string[], types?: Record<string, string>, aliases: { alias: string, canonical: string | null, yahoo_symbol?: string | null }[],
 *   existing: string[], requests: { symbol: string, status: string, requested_at: string, finished_at?: string | null }[], now: number }} input
 * @returns {{ dispatch: { ticker: string, symbol: string }[], known: string[], recent: string[], ignored: string[] }}
 */
export function planFundamentalsRequest({ tickers, types = {}, aliases, existing, requests, now }) {
  const have = new Set(existing.map(up));
  const req = new Map(requests.map((r) => [up(r.symbol), r]));
  const out = { dispatch: [], known: [], recent: [], ignored: [] };
  const seen = new Set();
  for (const ticker of cleanTickers(tickers)) {
    const a = aliases.find((x) => up(x.alias) === up(ticker));
    const symbol = canonicalOf(ticker, aliases);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const yahoo = String(a?.yahoo_symbol ?? '');
    const pinnedEquity = !!yahoo && !/-USD$/i.test(yahoo);
    const type = types[ticker] ?? types[up(ticker)];
    if (/-USD$/i.test(yahoo) || (!pinnedEquity && (isCryptoHolding(up(ticker), type) || isCryptoHolding(symbol, type)))) {
      out.ignored.push(symbol); // crypto has no company statements
      continue;
    }
    if (have.has(symbol)) { out.known.push(symbol); continue; }
    const r = req.get(symbol);
    if (r) {
      const since = now - Date.parse(r.status === 'pending' ? r.requested_at : (r.finished_at ?? r.requested_at));
      if (since < (r.status === 'pending' ? PENDING_TTL_MS : FINISHED_TTL_MS)) { out.recent.push(symbol); continue; }
    }
    out.dispatch.push({ ticker, symbol });
  }
  return out;
}
