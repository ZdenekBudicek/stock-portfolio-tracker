import type { Lang } from './protocol.ts';

export type MarketValue<T> = { data: T | null; source: string; asOf: string | null; fetchedAt: string | null;
  freshness: 'fresh' | 'stale' | 'missing'; warnings: string[] };
export type Quote = { ticker: string; price: number; currency: string; previousClose: number | null;
  changePct: number | null; kind: 'quote' | 'close' | 'cost' };
export type HistoryPoint = { date: string; close: number; currency: string };
export type AnalystView = { ticker: string; consensus: string | null;
  counts: { strongBuy: number | null; buy: number | null; hold: number | null; sell: number | null; strongSell: number | null };
  targetMean: number | null; targetLow: number | null; targetHigh: number | null; currency: string | null;
  changes: { date: string; firm: string; from: string | null; to: string | null }[];
  /** Consensus estimates for the current and the next fiscal year (Ocenění v2), in `estimatesCurrency` (the statements' currency). */
  estimates?: ConsensusEstimate[]; estimatesCurrency?: string | null };
/** One fiscal year's consensus: average EPS and revenue, their growth (ratio) against the year before, the analysts behind it. */
export type ConsensusEstimate = { period: 'current' | 'next' | 'later'; endDate: string | null; eps: number | null; revenue: number | null;
  epsGrowth: number | null; revenueGrowth: number | null; analysts: number | null };
// `excerpt`: the most relevant part of the article text (clean, ≤ 1,200 characters), only when articles were asked for.
// `kind` (company research only): what the page was searched for — the business, analyst expectations, the industry.
export type NewsItem = { title: string; summary: string | null; publisher: string; url: string; published: string | null; lang: Lang | 'original';
  excerpt?: string; kind?: ResearchKind };
/** What a company research search looks for (Běh 27): what the company does, what analysts expect, its industry's outlook. */
export type ResearchKind = 'business' | 'analysts' | 'industry' | 'financials' | 'moat' | 'management' | 'dividends' | 'catalysts';
export const RESEARCH_KINDS: readonly ResearchKind[] = ['business', 'analysts', 'industry', 'financials', 'moat', 'management', 'dividends', 'catalysts'];
/**
 * Key metrics of any listed company from the provider (Finnhub basic financials), for stocks without stored statements:
 * trailing P/E, P/S and EPS, market capitalisation (millions), revenue growth and five-year EPS growth (percent), 52-week range.
 */
export type KeyMetrics = { ticker: string; currency: string | null; peTtm: number | null; psTtm: number | null; epsTtm: number | null;
  marketCapMillions: number | null; revenueGrowthTtm: number | null; epsGrowth5y: number | null; high52w: number | null; low52w: number | null };
/** Articles with text for news analysis: `related` peers widen which paragraphs count as relevant. */
export type NewsOptions = { articles?: { related?: readonly string[] } };
export type EarningsInfo = { ticker: string; date: string; epsEstimate: number | null; epsActual: number | null;
  revenueEstimate: number | null; revenueActual: number | null; currency: string | null };
// Comparable instruments: the provider's peers, the same stored industry, or other major coins.
export type PeerList = { peers: string[]; basis: 'provider' | 'industry' | 'crypto' };
/** `unverified`: a symbol written as one that no provider could check (no keys, providers down); used with a warning. */
export type TickerResolution = { status: 'resolved'; ticker: string; assetType: 'stock' | 'etf' | 'crypto'; unverified?: true }
  | { status: 'unknown' | 'ambiguous'; candidates: string[] };

// price_cache stores when Trackora fetched a price or rate from its provider, not the market time.
// That fetch time is the best observation time there is: it dates the fact, and the note says what it is.
export const QUOTE_TTL_MS = 15 * 60_000;
export const RETRIEVAL_TIME_NOTE = 'The time of this cached price or exchange rate is when Trackora retrieved it from its data provider, not the exact market trade time.';
/** Market time and freshness of a cached row: dated by its provider fetch time, never by the time it is read. */
export function cachedQuoteTime(fetchedAt: string, now: number): Pick<MarketValue<never>, 'asOf' | 'freshness' | 'warnings'> {
  const age = now - Date.parse(fetchedAt);
  return { asOf: fetchedAt, freshness: age >= 0 && age <= QUOTE_TTL_MS ? 'fresh' : 'stale', warnings: [RETRIEVAL_TIME_NOTE] };
}

/* ------------------------- currency normalization (I1) ------------------------- */

// The UI prices every holding in USD from price_cache / price_history. Its conventions, which the
// agent reuses so both give the same numbers on the same inputs:
// - Finnhub and Twelve Data quotes are stored as USD (scripts/price-worker.mjs: "Twelve Data free is
//   USD-listed"); a quote without a currency follows that convention.
// - Binance pairs are USDT; refresh-prices stores their price unchanged, i.e. USDT at par with USD.
// - Other currencies (EUR, GBP, GBp/GBX pence) are converted only by the daily history worker
//   (price-worker.mjs toUsd) into price_history. A live quote in such a currency is therefore not
//   used: the caller falls back to the USD-normalized stored data the UI shows, or reports none.
export const USDT_AT_PAR_NOTE = 'usdt_valued_as_usd';
export function usdQuoteCurrency(currency: string | null): { ok: true; warnings: string[] } | { ok: false; warning: string } {
  if (currency === null || currency === 'USD') return { ok: true, warnings: [] };
  if (currency === 'USDT') return { ok: true, warnings: [USDT_AT_PAR_NOTE] };
  return { ok: false, warning: `quote_currency_unsupported:${currency}` };
}

/* ------------------------- validity time per data kind (I7) ------------------------- */

// The time a value was downloaded (fetchedAt) says nothing about when it was valid (asOf).
// A provider quote is fresh only by its own market time:
// - crypto trades around the clock: at most 15 minutes old (QUOTE_TTL_MS);
// - US stocks: at most 15 minutes old while the regular session runs; while it is closed, a quote
//   from the last regular close on (15 minutes of slack) is the current price.
// Unknown market time is never fresh. Exchange holidays are not modelled (a holiday makes the
// previous close look stale, never the other way round).
const QUOTE_FUTURE_SKEW_MS = 60_000;
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function nyParts(ms: number) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second), weekday: p.weekday };
}
/** UTC epoch of a New York wall-clock time (exact except inside the 2 a.m. DST switch hour). */
function nyInstant(y: number, m: number, d: number, h: number): number {
  const guess = Date.UTC(y, m - 1, d, h);
  const wall = nyParts(guess);
  return guess - (Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.min, wall.s) - guess);
}
/** The most recent US regular-session close (16:00 New York, Mon–Fri) at or before `now`. */
export function lastUsClose(now: number): number {
  for (let back = 0; back < 8; back++) {
    const day = nyParts(now - back * 86_400_000);
    if (day.weekday === 'Sat' || day.weekday === 'Sun') continue;
    const close = nyInstant(day.y, day.m, day.d, 16);
    if (close <= now) return close;
  }
  return now - 7 * 86_400_000;
}
function usSessionOpen(now: number): boolean {
  const t = nyParts(now);
  if (t.weekday === 'Sat' || t.weekday === 'Sun') return false;
  const minutes = t.h * 60 + t.min;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
export function quoteFreshness(kind: 'stock' | 'crypto', asOf: string | null, now: number): 'fresh' | 'stale' {
  const at = asOf === null ? NaN : Date.parse(asOf);
  if (!Number.isFinite(at) || at - now > QUOTE_FUTURE_SKEW_MS) return 'stale';
  if (now - at <= QUOTE_TTL_MS) return 'fresh';
  return kind === 'stock' && !usSessionOpen(now) && at >= lastUsClose(now) - QUOTE_TTL_MS ? 'fresh' : 'stale';
}
