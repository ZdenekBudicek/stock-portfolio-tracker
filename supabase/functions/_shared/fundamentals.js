/** Yahoo suffix -> public metric name. Shared by the parser and Node request builder. */
export const YAHOO_FUNDAMENTAL_METRICS = Object.freeze({
  TotalRevenue: 'revenue',
  GrossProfit: 'grossProfit',
  OperatingIncome: 'operatingIncome',
  NetIncome: 'netIncome',
  OperatingCashFlow: 'operatingCashFlow',
  CapitalExpenditure: 'capex',
  FreeCashFlow: 'freeCashFlow',
  RepurchaseOfCapitalStock: 'buybacks',
  DilutedEPS: 'dilutedEps',
  CashAndCashEquivalents: 'cash',
  TotalDebt: 'totalDebt',
  OrdinarySharesNumber: 'sharesOutstanding',
  DilutedAverageShares: 'dilutedShares',
  StockholdersEquity: 'equity',
  CashDividendsPaid: 'dividendsPaid',
  ResearchAndDevelopment: 'rnd',
  SellingGeneralAndAdministration: 'sga',
  CostOfRevenue: 'costOfRevenue',
  EBITDA: 'ebitda',
});

const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

/**
 * Normalize without IO or mutation. The caller stamps the fetch time; the default is a
 * deterministic ISO sentinel for an unstamped response, never a claim of freshness.
 * @param {unknown} json
 * @param {string} symbol canonical application symbol (not necessarily Yahoo's symbol)
 * @param {string} fetchedAt
 * @returns {import('../../../src/types/fundamentals').CompanyFundamentals}
 */
export function normalizeYahooFundamentals(json, symbol, fetchedAt = '1970-01-01T00:00:00.000Z') {
  const result = json?.timeseries?.result;
  const rows = Array.isArray(result) ? result : [];
  let hasValues = false;
  // A company that changed reporting currency (e.g. NBIS, formerly Yandex in RUB) keeps old
  // entries in the previous one. The current currency is the one of the LATEST reported period;
  // older entries in another currency are treated as unknown so units never mix. Two currencies
  // on that same latest date are ambiguous, so that still fails.
  let latest = '';
  const onLatest = new Set();
  for (const row of rows) {
    for (const [key, entries] of Object.entries(row ?? {})) {
      if (!/^(annual|quarterly)/.test(key) || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        const code = entry?.currencyCode;
        const date = entry?.asOfDate;
        if (typeof code !== 'string' || !code || !validDate(date) || !Number.isFinite(entry?.reportedValue?.raw)) continue;
        if (date > latest) { latest = date; onLatest.clear(); }
        if (date === latest) onLatest.add(code);
      }
    }
  }
  if (onLatest.size > 1) throw new Error('Mixed reporting currencies');
  const currency = [...onLatest][0] ?? null;

  const series = (frequency) => {
    const byDate = new Map();
    for (const row of rows) {
      for (const [suffix, metric] of Object.entries(YAHOO_FUNDAMENTAL_METRICS)) {
        const entries = row?.[`${frequency}${suffix}`];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const date = entry?.asOfDate;
          if (!validDate(date)) continue;
          if (!byDate.has(date)) byDate.set(date, {});
          const raw = entry?.reportedValue?.raw;
          // Missing, NaN, Infinity and strings are unknown, not zero.
          if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
          const code = entry?.currencyCode;
          if (typeof code === 'string' && code && code !== currency) continue;
          byDate.get(date)[metric] = metric === 'capex' || metric === 'buybacks' || metric === 'dividendsPaid' ? -Math.abs(raw) : raw;
          hasValues = true;
        }
      }
    }
    const periods = [...byDate.keys()].sort();
    const values = Object.fromEntries(Object.values(YAHOO_FUNDAMENTAL_METRICS).map((metric) => [metric, []]));
    for (const date of periods) {
      const metrics = byDate.get(date);
      if (metrics.freeCashFlow == null && metrics.operatingCashFlow != null && metrics.capex != null) {
        metrics.freeCashFlow = metrics.operatingCashFlow + metrics.capex;
      }
      for (const metric of Object.values(YAHOO_FUNDAMENTAL_METRICS)) values[metric].push(metrics[metric] ?? null);
    }
    return { periods, values };
  };

  const annual = series('annual');
  const quarterly = series('quarterly');
  return {
    symbol, currency: currency ?? 'USD', fetchedAt,
    status: hasValues && !json?.timeseries?.error ? 'ok' : 'error',
    annual, quarterly,
  };
}
