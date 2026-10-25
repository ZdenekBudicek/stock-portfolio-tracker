// Long statement history from SEC EDGAR (XBRL companyfacts, US filers from ~2009, 20-F filers
// annual only) merged UNDER the Yahoo series: Yahoo wins every period it has, EDGAR only fills
// gaps and adds older periods, and only for metrics whose definitions agree where both report.
// Pure functions; the worker does the IO.
import { YAHOO_FUNDAMENTAL_METRICS } from './fundamentals.js';

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
export const secFactsUrl = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
export const yahooSplitsUrl = (symbol, now) => `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  + `?period1=0&period2=${Math.floor(now / 1000) + 86400}&interval=3mo&events=split`;

const METRICS = Object.values(YAHOO_FUNDAMENTAL_METRICS);
const DAY_MS = 24 * 60 * 60 * 1000;
const days = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
const quarterLong = (d) => d >= 80 && d <= 100; // 13 or 14 weeks, or calendar quarters
const yearLong = (d) => d >= 350 && d <= 380; // 52/53-week fiscal years
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s));

/**
 * XBRL concepts per metric, in priority order: within one period the first concept that reports
 * wins (companies switch concepts over the years, e.g. SalesRevenueNet → RevenueFromContract…).
 * kind: 'flow' sums over time (missing quarters derive from year-to-date figures),
 * 'average' does not (EPS, weighted shares: only directly reported periods), 'instant' is a
 * balance at the period end. totalDebt and ebitda have no reliable XBRL concept: Yahoo only.
 */
export const EDGAR_METRICS = Object.freeze({
  revenue: { kind: 'flow', concepts: ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:SalesRevenueNet', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax', 'us-gaap:SalesRevenueGoodsNet', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers'] },
  costOfRevenue: { kind: 'flow', concepts: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales'] },
  grossProfit: { kind: 'flow', concepts: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'] },
  operatingIncome: { kind: 'flow', concepts: ['us-gaap:OperatingIncomeLoss', 'ifrs-full:ProfitLossFromOperatingActivities'] },
  netIncome: { kind: 'flow', concepts: ['us-gaap:NetIncomeLoss', 'ifrs-full:ProfitLossAttributableToOwnersOfParent'] },
  operatingCashFlow: { kind: 'flow', concepts: ['us-gaap:NetCashProvidedByUsedInOperatingActivities', 'ifrs-full:CashFlowsFromUsedInOperatingActivities'] },
  capex: { kind: 'flow', outflow: true, concepts: ['us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PaymentsToAcquireProductiveAssets', 'ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'] },
  buybacks: { kind: 'flow', outflow: true, concepts: ['us-gaap:PaymentsForRepurchaseOfCommonStock', 'ifrs-full:PaymentsToAcquireOrRedeemEntitysShares'] },
  dividendsPaid: { kind: 'flow', outflow: true, concepts: ['us-gaap:PaymentsOfDividends', 'us-gaap:PaymentsOfDividendsCommonStock', 'ifrs-full:DividendsPaidClassifiedAsFinancingActivities'] },
  rnd: { kind: 'flow', concepts: ['us-gaap:ResearchAndDevelopmentExpense', 'us-gaap:ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost', 'ifrs-full:ResearchAndDevelopmentExpense'] },
  sga: { kind: 'flow', concepts: ['us-gaap:SellingGeneralAndAdministrativeExpense', 'ifrs-full:SellingGeneralAndAdministrativeExpense'] },
  dilutedEps: { kind: 'average', unit: 'perShare', split: 'divide', concepts: ['us-gaap:EarningsPerShareDiluted', 'ifrs-full:DilutedEarningsLossPerShare'] },
  dilutedShares: { kind: 'average', unit: 'shares', split: 'multiply', concepts: ['us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding', 'ifrs-full:AdjustedWeightedAverageShares'] },
  cash: { kind: 'instant', concepts: ['us-gaap:CashAndCashEquivalentsAtCarryingValue', 'ifrs-full:CashAndCashEquivalents'] },
  equity: { kind: 'instant', concepts: ['us-gaap:StockholdersEquity', 'ifrs-full:EquityAttributableToOwnersOfParent'] },
  sharesOutstanding: { kind: 'instant', unit: 'shares', split: 'multiply', concepts: ['us-gaap:CommonStockSharesOutstanding'] },
});

/** SEC spells share classes like Yahoo (BRK-B); exchange-suffixed symbols (SAP.DE) are not SEC filers. */
export function secTicker(yahooSymbol) {
  const s = String(yahooSymbol ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9-]{0,9}$/.test(s) ? s : null;
}

/** company_tickers.json → Map(ticker → 10-digit CIK). */
export function secCikMap(json) {
  const map = new Map();
  for (const row of Object.values(json && typeof json === 'object' ? json : {})) {
    const ticker = String(row?.ticker ?? '').trim().toUpperCase();
    const cik = Number(row?.cik_str);
    if (ticker && Number.isInteger(cik) && cik > 0 && !map.has(ticker)) map.set(ticker, String(cik).padStart(10, '0'));
  }
  return map;
}

/** Yahoo chart split events → [{ date, ratio }] (4-for-1 → 4). null = unusable answer. */
export function parseYahooSplits(json) {
  const result = json?.chart?.result?.[0];
  if (!result || json?.chart?.error) return null;
  return Object.values(result.events?.splits ?? {})
    .map((s) => ({ date: new Date(Number(s?.date) * 1000).toISOString().slice(0, 10), ratio: Number(s?.numerator) / Number(s?.denominator) }))
    .filter((s) => Number.isFinite(s.ratio) && s.ratio > 0 && s.ratio !== 1 && validDate(s.date));
}

/** Latest-filed fact per (start, end): later filings carry restatements. */
function latestFacts(json, concept, unit) {
  const [taxonomy, name] = concept.split(':');
  const list = json?.facts?.[taxonomy]?.[name]?.units?.[unit];
  const byPeriod = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (typeof f?.val !== 'number' || !Number.isFinite(f.val) || !validDate(f.end)) continue;
    if (f.start != null && !validDate(f.start)) continue;
    const key = `${f.start ?? ''}|${f.end}`;
    const prev = byPeriod.get(key);
    if (!prev || String(f.filed ?? '') >= String(prev.filed ?? '')) byPeriod.set(key, f);
  }
  return [...byPeriod.values()];
}

/** Durations → { annual, quarterly } Map(end → fact-like { val, filed }). */
function durationPeriods(facts, additive) {
  const annual = new Map();
  const quarterly = new Map();
  const byStart = new Map();
  for (const f of facts) {
    if (!f.start) continue;
    const d = days(f.start, f.end);
    if (yearLong(d)) annual.set(f.end, f);
    if (quarterLong(d)) quarterly.set(f.end, f);
    if (!byStart.has(f.start)) byStart.set(f.start, []);
    byStart.get(f.start).push(f);
  }
  if (additive) {
    // 10-Qs report cash flows only year-to-date and no filing reports Q4 on its own:
    // a quarter = YTD at its end − YTD one quarter earlier (same fiscal-year start), Q4 = FY − 9M.
    for (const ytd of byStart.values()) {
      ytd.sort((a, b) => a.end.localeCompare(b.end));
      for (let i = 1; i < ytd.length; i++) {
        if (quarterly.has(ytd[i].end) || !quarterLong(days(ytd[i - 1].end, ytd[i].end) - 1)) continue;
        quarterly.set(ytd[i].end, { val: ytd[i].val - ytd[i - 1].val, filed: ytd[i].filed });
      }
    }
  }
  return { annual, quarterly };
}

/**
 * companyfacts → { annual, quarterly } as Map(period end → { metric: value }), in the SEC's own
 * period-end dates. Only units in `currency` are read, so currencies never mix. Share counts and
 * EPS are restated to today's share basis with `splits`; without them (null) they are left out.
 */
export function normalizeEdgarFacts(json, currency, splits) {
  const out = { annual: new Map(), quarterly: new Map() };
  const instants = {};
  // A figure reflects every split before it was filed; only later splits are applied.
  const splitFactor = (filed) => (splits ?? []).reduce((k, s) => (s.date > String(filed ?? '') ? k * s.ratio : k), 1);
  const value = (def, f) => {
    let v = f.val;
    if (def.split === 'divide') v /= splitFactor(f.filed);
    if (def.split === 'multiply') v *= splitFactor(f.filed);
    return def.outflow ? -Math.abs(v) : v;
  };
  for (const [metric, def] of Object.entries(EDGAR_METRICS)) {
    if (def.split && !splits) continue;
    const unit = def.unit === 'shares' ? 'shares' : def.unit === 'perShare' ? `${currency}/shares` : currency;
    if (def.kind === 'instant') instants[metric] = new Map();
    for (const concept of def.concepts) {
      const facts = latestFacts(json, concept, unit);
      if (def.kind === 'instant') {
        for (const f of facts) if (!f.start && !instants[metric].has(f.end)) instants[metric].set(f.end, value(def, f));
        continue;
      }
      const periods = durationPeriods(facts, def.kind === 'flow');
      for (const frequency of ['annual', 'quarterly']) {
        for (const [end, f] of periods[frequency]) {
          if (!out[frequency].has(end)) out[frequency].set(end, {});
          const row = out[frequency].get(end);
          if (row[metric] == null) row[metric] = value(def, f);
        }
      }
    }
  }
  // Balances belong to periods some statement defines; a lone balance-sheet date is no period.
  for (const frequency of ['annual', 'quarterly']) {
    for (const [end, row] of out[frequency]) {
      for (const [metric, byEnd] of Object.entries(instants)) if (row[metric] == null && byEnd.has(end)) row[metric] = byEnd.get(end);
    }
    for (const metric of ['dilutedShares', 'sharesOutstanding']) dropMisScaled(out[frequency], metric);
  }
  return out;
}

/** Early XBRL filings sometimes tag share counts in thousands as units (NVDA FY2008: 606 732
 * shares). Counts move slowly once split-adjusted, so a value 50× off its neighbours is an error. */
function dropMisScaled(rows, metric) {
  const points = [...rows.entries()].filter(([, r]) => r[metric] > 0).sort(([a], [b]) => a.localeCompare(b));
  const bad = points.filter(([, r], i) => {
    const near = [points[i - 2], points[i - 1], points[i + 1], points[i + 2]].filter(Boolean).map(([, n]) => n[metric]).sort((a, b) => a - b);
    if (!near.length) return false;
    const median = near.length % 2 ? near[(near.length - 1) / 2] : (near[near.length / 2 - 1] + near[near.length / 2]) / 2;
    return r[metric] / median > 50 || median / r[metric] > 50;
  });
  for (const [, r] of bad) delete r[metric];
}

/** FundamentalSeries → Map(period → { metric: value }); a missing metric array is all null. */
export function seriesRows(series) {
  const rows = new Map();
  (series?.periods ?? []).forEach((period, i) => {
    const row = {};
    for (const m of METRICS) {
      const v = series.values?.[m]?.[i];
      if (typeof v === 'number' && Number.isFinite(v)) row[m] = v;
    }
    rows.set(period, row);
  });
  return rows;
}

const monthEnd = (iso) => {
  const t = Date.parse(iso);
  const d = new Date(t);
  const thisEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  const prevEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0);
  const best = Math.abs(thisEnd - t) <= Math.abs(t - prevEnd) ? thisEnd : prevEnd;
  return Math.abs(best - t) <= 7 * DAY_MS ? new Date(best).toISOString().slice(0, 10) : iso;
};

/** History period end → the Yahoo period it is (within 10 days), else Yahoo's month-end convention. */
function alignPeriod(end, yahooPeriods) {
  const t = Date.parse(end);
  const near = yahooPeriods.find((p) => Math.abs(Date.parse(p) - t) <= 10 * DAY_MS);
  return near ?? monthEnd(end);
}

export const SEAM_TOLERANCE = 0.03;
const agrees = (metric, a, b) => Math.abs(a - b) <= SEAM_TOLERANCE * Math.max(Math.abs(a), Math.abs(b)) + (metric === 'dilutedEps' ? 0.015 : 0);

/**
 * Yahoo first; `history` (EDGAR, or the previously stored data) fills gaps and older periods.
 * A metric is taken from history only if its definition matches Yahoo's: at least 2/3 of the
 * periods both report agree within SEAM_TOLERANCE. If Yahoo reports the metric but never in a
 * period history has, it cannot be checked and is not taken; a metric Yahoo lacks entirely is.
 * @param {import('../../../src/types/fundamentals.ts').FundamentalSeries} yahoo
 * @param {Map<string, Record<string, number>>} history period end → values
 * @returns {{ series: import('../../../src/types/fundamentals.ts').FundamentalSeries, used: string[] }}
 */
export function mergeSeries(yahoo, history) {
  const rows = seriesRows(yahoo);
  const yahooPeriods = [...rows.keys()];
  const aligned = new Map();
  for (const [end, values] of history ?? []) {
    const period = alignPeriod(end, yahooPeriods);
    if (!aligned.has(period)) aligned.set(period, values);
  }
  const used = METRICS.filter((m) => {
    let both = 0;
    let same = 0;
    for (const [period, values] of aligned) {
      const y = rows.get(period)?.[m];
      if (y == null || values[m] == null) continue;
      both++;
      if (agrees(m, values[m], y)) same++;
    }
    const inHistory = [...aligned.values()].some((v) => v[m] != null);
    const inYahoo = [...rows.values()].some((v) => v[m] != null);
    return inHistory && (both ? same >= Math.max(1, Math.ceil((both * 2) / 3)) : !inYahoo);
  });
  for (const [period, values] of aligned) {
    const fill = Object.fromEntries(used.filter((m) => values[m] != null).map((m) => [m, values[m]]));
    if (!Object.keys(fill).length) continue;
    rows.set(period, { ...fill, ...rows.get(period) }); // Yahoo's own values win
  }
  const periods = [...rows.keys()].sort();
  const values = Object.fromEntries(METRICS.map((m) => [m, []]));
  for (const period of periods) {
    const row = rows.get(period);
    if (row.freeCashFlow == null && row.operatingCashFlow != null && row.capex != null) row.freeCashFlow = row.operatingCashFlow + row.capex;
    for (const m of METRICS) values[m].push(row[m] ?? null);
  }
  return { series: { periods, values }, used };
}

/**
 * @param {import('../../../src/types/fundamentals.ts').CompanyFundamentals} yahoo normalized Yahoo data (status ok)
 * @param {{ annual: Map<string, object>, quarterly: Map<string, object> } | null} history
 */
export function mergeFundamentals(yahoo, history) {
  if (!history) return { data: yahoo, used: { annual: [], quarterly: [] } };
  const annual = mergeSeries(yahoo.annual, history.annual);
  const quarterly = mergeSeries(yahoo.quarterly, history.quarterly);
  return { data: { ...yahoo, annual: annual.series, quarterly: quarterly.series }, used: { annual: annual.used, quarterly: quarterly.used } };
}

/** Previously stored data as history (when SEC is unreachable), only in the same currency. */
export function storedHistory(stored, currency) {
  if (!stored || stored.currency !== currency) return null;
  return { annual: seriesRows(stored.annual), quarterly: seriesRows(stored.quarterly) };
}
