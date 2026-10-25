// Company data fetched live, while a user waits (Ocenění v3, company-data edge function).
// Yahoo rejects Supabase edge IPs, so live data come from sources that answer there: SEC EDGAR
// (statements of US filers) and Nasdaq's analyst pages (Zacks consensus EPS for up to four fiscal
// years, price targets, ratings). The nightly worker (Yahoo + EDGAR) later replaces these with
// fuller data. Pure functions; the edge function does the IO. Tested in src/__tests__/company-data.test.ts.
import { mergeFundamentals, normalizeEdgarFacts } from './edgar.js';

const DAY_MS = 86_400_000;
const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : null;
const count = (v) => { const n = num(v); return n !== null && Number.isInteger(n) && n >= 0 ? n : null; };
const positive = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };

/** Live data are refreshed when older than this (the nightly job refreshes held companies daily). */
export const LIVE_TTL_MS = 3 * DAY_MS;
export const NASDAQ_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
});
export const nasdaqForecastUrl = (symbol) => `https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-forecast`;
export const nasdaqTargetUrl = (symbol) => `https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/targetprice`;

/** A stored row is due for a live refresh: missing, not ok, or older than LIVE_TTL_MS. */
export function liveDue(row, now) {
  if (!row || row.status !== 'ok' || !row.data) return true;
  const fetched = Date.parse(row.fetched_at ?? '');
  return !Number.isFinite(fetched) || now - fetched >= LIVE_TTL_MS;
}

/**
 * Splits from the share count alone (no split history reachable from the edge): two consecutive
 * periods whose diluted share counts differ by ≈ a whole factor 2–50 (within 6 %). Dated midway
 * between them, so filings before it are restated and later (already restated) ones are not.
 * @param {{ annual: Map<string, object>, quarterly: Map<string, object> }} history
 */
export function inferSplits(history) {
  const points = [...history.quarterly, ...history.annual]
    .filter(([, r]) => r.dilutedShares > 0).map(([end, r]) => ({ end, shares: r.dilutedShares }))
    .sort((a, b) => a.end.localeCompare(b.end));
  const splits = [];
  for (let i = 1; i < points.length; i++) {
    const ratio = points[i].shares / points[i - 1].shares;
    const k = Math.round(ratio);
    if (k >= 2 && k <= 50 && Math.abs(ratio / k - 1) <= 0.06) {
      const mid = new Date((Date.parse(points[i - 1].end) + Date.parse(points[i].end)) / 2).toISOString().slice(0, 10);
      if (!splits.some((s) => s.date === mid)) splits.push({ date: mid, ratio: k });
    }
  }
  return splits;
}

/** Quarterly EPS and diluted shares the SEC cannot give (Q4 is never filed on its own): the share count
 * of the nearest quarter (counts move slowly) and net income / that count. */
function fillQuarterlyEps(series) {
  const v = series.values;
  if (!v.netIncome || !v.dilutedShares) return series;
  const n = series.periods.length;
  const shares = series.periods.map((_, i) => {
    if (v.dilutedShares[i] > 0) return v.dilutedShares[i];
    for (let d = 1; d < n; d++) for (const j of [i - d, i + d]) if (j >= 0 && j < n && v.dilutedShares[j] > 0) return v.dilutedShares[j];
    return null;
  });
  const eps = series.periods.map((_, i) => v.dilutedEps?.[i] ?? (v.netIncome[i] != null && shares[i] > 0 ? v.netIncome[i] / shares[i] : null));
  return { ...series, values: { ...v, dilutedShares: shares, dilutedEps: eps } };
}

/**
 * CompanyFundamentals from SEC companyfacts only (USD filers). `sharesFallback` (e.g. a provider's
 * shares outstanding) is used only when the filings give no share count at all.
 * @param {unknown} facts @param {string} symbol @param {string} nowIso @param {number | null} [sharesFallback]
 * @returns {import('../../../src/types/fundamentals.ts').CompanyFundamentals | null}
 */
export function edgarOnlyFundamentals(facts, symbol, nowIso, sharesFallback = null) {
  const raw = normalizeEdgarFacts(facts, 'USD', []);
  const history = normalizeEdgarFacts(facts, 'USD', inferSplits(raw));
  const empty = { periods: [], values: {} };
  const base = { symbol, currency: 'USD', status: 'ok', fetchedAt: nowIso, annual: empty, quarterly: empty };
  const merged = mergeFundamentals(base, history).data;
  const data = { ...merged, quarterly: fillQuarterlyEps(merged.quarterly), source: 'sec_live' };
  if (!data.annual.periods.length && !data.quarterly.periods.length) return null;
  const hasShares = ['annual', 'quarterly'].some((k) => ['dilutedShares', 'sharesOutstanding'].some((m) => (data[k].values[m] ?? []).some((x) => x > 0)));
  const fallback = positive(sharesFallback);
  if (!hasShares && fallback && data.quarterly.periods.length) {
    const n = data.quarterly.periods.length;
    data.quarterly = { ...data.quarterly, values: { ...data.quarterly.values, sharesOutstanding: Array.from({ length: n }, (_, i) => i === n - 1 ? fallback : null) } };
  }
  return data;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** "Dec 2027" → the month's last day, "2027-12-31". */
export function fiscalEnd(text) {
  const m = /^([A-Z][a-z]{2})\s+(\d{4})$/.exec(String(text ?? '').trim());
  if (!m || !MONTHS[m[1]]) return null;
  const month = Number(MONTHS[m[1]]), year = Number(m[2]);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Nasdaq earnings-forecast + targetprice → an analyst_snapshots `data` row (same shape as the Yahoo
 * worker's, scripts/analyst-snapshot.mjs). Yearly EPS: the first fiscal year still open is `current`,
 * the next `next`, up to two more `later`; no revenue consensus in this source.
 * @returns {import('../agent/core/marketTypes.ts').AnalystView | null}
 */
export function parseNasdaqSnapshot(forecast, target, ticker, today) {
  const rows = forecast?.data?.yearlyForecast?.rows;
  const years = (Array.isArray(rows) ? rows : []).map((r) => ({ endDate: fiscalEnd(r?.fiscalEnd), eps: num(r?.consensusEPSForecast), analysts: count(r?.noOfEstimates) }))
    .filter((r) => r.endDate && r.eps !== null && r.endDate >= today).sort((a, b) => a.endDate.localeCompare(b.endDate)).slice(0, 4);
  const estimates = years.map((r, i) => ({ period: i === 0 ? 'current' : i === 1 ? 'next' : 'later', endDate: r.endDate, eps: r.eps, revenue: null,
    epsGrowth: i > 0 && years[i - 1].eps > 0 ? r.eps / years[i - 1].eps - 1 : null, revenueGrowth: null, analysts: r.analysts }));
  const o = target?.data?.consensusOverview ?? {};
  const counts = { strongBuy: null, buy: count(o.buy), hold: count(o.hold), sell: count(o.sell), strongSell: null };
  const total = (counts.buy ?? 0) + (counts.hold ?? 0) + (counts.sell ?? 0);
  const consensus = !total ? null : counts.buy / total >= 0.6 ? 'buy' : (counts.sell ?? 0) / total >= 0.4 ? 'sell' : 'hold';
  const view = {
    ticker, consensus, counts, targetMean: positive(o.priceTarget), targetLow: positive(o.lowPriceTarget), targetHigh: positive(o.highPriceTarget),
    // Nasdaq lists US-traded shares: targets and EPS are in US dollars, like the trading currency.
    currency: 'USD', currencyBasis: 'trading', changes: [], source: 'nasdaq',
    ...(estimates.length ? { estimates, estimatesCurrency: 'USD' } : {}),
  };
  const empty = view.targetMean === null && !estimates.length && Object.values(counts).every((n) => n === null);
  return empty ? null : view;
}
