import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from '@/types/fundamentals';
import { medianOf, valuationSeries, type Multiple } from '@/lib/valuationSeries';

// All rates are fractions (0.10 = 10%). No IO, currency conversion or implicit zeroes.
export type Reason = 'currency' | 'missingFcf' | 'nonPositiveFcf' | 'missingShares' | 'missingEps'
  | 'nonPositiveEps' | 'missingEquity' | 'nonPositiveEquity' | 'missingDividends' | 'noDividends'
  | 'missingCashDebt' | 'invalidRates' | 'invalidPe' | 'invalidHorizon' | 'missingPrice'
  | 'unreachable' | 'nonFinite' | 'missingAverage' | 'financialCashFlow' | 'lossMaking'
  | 'minorDividend' | 'missingRevenue' | 'missingHistory' | 'missingAffo' | 'noApplicableMethods'
  | 'nonPositiveValue';
export type Estimate = { value: number; reason: null } | { value: null; reason: Reason };
export type FlowSource = 'ttm' | 'annual' | 'average3' | 'normalized' | 'missing';
export interface Flow { value: number | null; source: FlowSource }
export interface Assumptions {
  growth: number;
  discount: number;
  terminalGrowth: number;
  pe: number;
  pfcf: number;
  ps: number;
  pb: number;
  epsGrowth: number;
  years: number;
  dividendGrowth: number;
  fcfMode: 'latest' | 'average3' | 'normalized';
  includeNetCash: boolean;
}
export interface DcfInput { fcfPerShare: number | null; growth: number; discount: number; terminalGrowth: number; netCashPerShare?: number | null }
export const METHOD_IDS = ['dcf', 'pe', 'peGrowth', 'pfcf', 'pb', 'ps', 'graham', 'dividend'] as const;
export type MethodId = typeof METHOD_IDS[number];
export type PriceClose = { date: string; close: number };
export type CompanyType = 'financial' | 'loss' | 'assetIncome' | 'growth' | 'dividend' | 'value' | 'mature';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fail = (reason: Reason): Estimate => ({ value: null, reason });
const result = (value: number): Estimate => finite(value) ? { value, reason: null } : fail('nonFinite');
const at = (s: FundamentalSeries, m: FundamentalMetric, i: number): number | null => {
  const v = s.values[m]?.[i];
  return finite(v) ? v : null;
};
const dayGap = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const consecutive = (dates: string[], min: number, max: number) => dates.every((d, i) =>
  Number.isFinite(Date.parse(d)) && (i === 0 || (dayGap(dates[i - 1], d) >= min && dayGap(dates[i - 1], d) <= max)));

function lastReported(s: FundamentalSeries, m: FundamentalMetric) {
  for (let i = s.periods.length - 1; i >= 0; i--) {
    const value = at(s, m, i);
    if (value != null) return { value, date: s.periods[i] };
  }
  return null;
}

/** Complete, consecutive latest four quarters; otherwise the latest reported annual value.
 * Never add nonconsecutive quarters or prefer older quarterly data to a newer annual report. */
export function annualFlow(f: CompanyFundamentals, metric: FundamentalMetric): Flow {
  const annual = lastReported(f.annual, metric);
  const q = f.quarterly;
  const dates = q.periods.slice(-4);
  const values = dates.map((_, i) => at(q, metric, q.periods.length - dates.length + i));
  if (dates.length === 4 && consecutive(dates, 60, 120) && values.every(finite)
    && (!annual || dates[3] >= annual.date)) {
    const value = (values as number[]).reduce((a, b) => a + b, 0);
    if (finite(value)) return { value, source: 'ttm' };
  }
  return annual ? { value: annual.value, source: 'annual' } : { value: null, source: 'missing' };
}

function latestDated(f: CompanyFundamentals, metric: FundamentalMetric): { date: string; value: number } | null {
  const a = lastReported(f.annual, metric);
  const q = lastReported(f.quarterly, metric);
  return q && (!a || q.date >= a.date) ? q : a ?? null;
}
function latest(f: CompanyFundamentals, metric: FundamentalMetric): number | null {
  return latestDated(f, metric)?.value ?? null;
}

export function valuationInputs(f: CompanyFundamentals, mode: Assumptions['fcfMode'] = 'latest') {
  // The newest share count wins (a split between an older diluted figure and a newer count in
  // issue would otherwise inflate every per-share value); on the same date prefer diluted.
  const diluted = latestDated(f, 'dilutedShares');
  const outstanding = latestDated(f, 'sharesOutstanding');
  const pick = [diluted, outstanding].filter((x): x is { date: string; value: number } => !!x && x.value > 0)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const shares = pick ? (diluted && diluted.value > 0 && diluted.date === pick.date ? diluted.value : pick.value) : null;
  let fcf = annualFlow(f, 'freeCashFlow');
  if (mode === 'normalized') {
    const normalized = normalizedFcf(f);
    if (normalized != null) fcf = { value: normalized, source: 'normalized' };
  }
  if (mode === 'average3') {
    const dates = f.annual.periods.slice(-3);
    const values = dates.map((_, i) => at(f.annual, 'freeCashFlow', f.annual.periods.length - dates.length + i));
    const mean = dates.length === 3 && consecutive(dates, 320, 410) && values.every(finite)
      ? (values as number[]).reduce((a, b) => a + b / 3, 0) : null;
    fcf = { value: finite(mean) ? mean : null, source: finite(mean) ? 'average3' : 'missing' };
  }
  // Cash and debt must refer to the same balance sheet, never mix reporting dates.
  const balances = [f.annual, f.quarterly].flatMap(s => s.periods.map((date, i) => ({
    date, cash: at(s, 'cash', i), debt: at(s, 'totalDebt', i),
  }))).filter(r => r.cash != null && r.debt != null).sort((a, b) => b.date.localeCompare(a.date));
  const balance = balances[0];
  return {
    shares, fcf, eps: annualFlow(f, 'dilutedEps'), dividends: annualFlow(f, 'dividendsPaid'), equity: latest(f, 'equity'),
    fcfPerShare: shares && fcf.value != null ? fcf.value / shares : null,
    netCashPerShare: shares && balance ? (balance.cash! - balance.debt!) / shares : null,
  };
}

function historicalCagr(s: FundamentalSeries, metric: FundamentalMetric): number | null {
  const end = s.periods.length - 1;
  const finish = at(s, metric, end);
  if (finish == null || finish <= 0) return null;
  for (let i = Math.max(0, end - 3); i < end; i++) {
    const start = at(s, metric, i);
    const years = dayGap(s.periods[i], s.periods[end]) / 365.25;
    if (start != null && start > 0 && years >= 0.85 && years <= 3.4) {
      const rate = (finish / start) ** (1 / years) - 1;
      if (finite(rate)) return rate;
    }
  }
  return null;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Only smooth an observable capex surge, not an operating deterioration or a loss history. */
function normalizedFcf(f: CompanyFundamentals): number | null {
  const revenue = annualFlow(f, 'revenue').value;
  const ocf = annualFlow(f, 'operatingCashFlow').value;
  const capex = annualFlow(f, 'capex').value;
  const current = annualFlow(f, 'freeCashFlow').value;
  const end = f.annual.periods.length - 1;
  const rows = f.annual.periods.slice(Math.max(0, end - 3), end).map((_, j) => {
    const i = Math.max(0, end - 3) + j;
    const r = at(f.annual, 'revenue', i), c = at(f.annual, 'capex', i), cf = at(f.annual, 'freeCashFlow', i);
    return r != null && r > 0 && c != null && c < 0 && cf != null
      ? { margin: cf / r, investment: -c / r } : null;
  }).filter((r): r is { margin: number; investment: number } => r != null);
  if (rows.length < 3 || revenue == null || revenue <= 0 || ocf == null || ocf <= 0
    || capex == null || current == null || (annualFlow(f, 'dilutedEps').value ?? 0) <= 0) return null;
  const margin = median(rows.map(r => r.margin))!;
  const investment = median(rows.map(r => r.investment))!;
  if (margin <= 0 || -capex / revenue < investment * 1.4 || current / revenue >= margin * 0.8) return null;
  // Retain half the current investment burden; do not invent more cash than operations earn.
  const normalized = Math.min(0.8 * ocf, (current + margin * revenue) / 2);
  return normalized > 0 ? normalized : null;
}

/** Trailing five calendar years relative to the statement snapshot, never wall-clock time.
 * At least 26 distinct observations spanning a year; a short burst of daily quotes is not history. */
export function historicalMultiples(f: CompanyFundamentals, closes: PriceClose[] = []) {
  const asOf = f.fetchedAt.slice(0, 10);
  const end = Date.parse(asOf);
  const start = new Date(end);
  if (finite(end)) start.setUTCFullYear(start.getUTCFullYear() - 5);
  const cutoff = finite(end) ? start.toISOString().slice(0, 10) : asOf;
  const clean = [...new Map(closes.filter(c => finite(c.close) && c.close > 0 && finite(Date.parse(c.date))
    && c.date >= cutoff && c.date <= asOf).map(c => [c.date, c])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const points = valuationSeries(f, clean);
  const read = (metric: Multiple) => {
    const usable = points.filter(p => finite(p[metric]) && p[metric]! > 0);
    const enough = usable.length >= 26 && dayGap(usable[0].date, usable[usable.length - 1].date) >= 365;
    return { median: enough ? medianOf(usable, metric) : null, count: usable.length,
      from: usable[0]?.date ?? null, to: usable[usable.length - 1]?.date ?? null };
  };
  return { pe: read('pe'), pfcf: read('pfcf'), ps: read('ps') };
}

/** No sector field exists in CompanyFundamentals. Infer a conservative financial-statement
 * profile, never a ticker-specific valuation target. Mixed lenders with cash flow dominated
 * by balance movements also use equity methods. */
function companyProfile(f: CompanyFundamentals, growth: number | null) {
  const i = valuationInputs(f);
  const revenue = annualFlow(f, 'revenue').value;
  const income = annualFlow(f, 'netIncome').value;
  const ocf = annualFlow(f, 'operatingCashFlow').value;
  const debt = latest(f, 'totalDebt');
  const financial = revenue != null && revenue > 0 && income != null && i.equity != null && i.equity > 0 && (
    (latest(f, 'grossProfit') == null && latest(f, 'costOfRevenue') == null && latest(f, 'operatingIncome') == null)
    || (income > 0 && ocf != null && ocf > income * 3 && debt != null && debt > i.equity));
  const loss = (i.eps.value != null && i.eps.value <= 0) || (income != null && income <= 0);
  const payout = i.shares && i.eps.value != null && i.eps.value > 0 && i.dividends.value != null
    ? -i.dividends.value / i.shares / i.eps.value : null;
  const assetIncome = !financial && payout != null && payout > 1.2 && latest(f, 'capex') == null;
  const earnings = (f.annual.values.dilutedEps ?? []).slice(-4).filter(finite);
  const stable = earnings.length >= 3 && earnings.every(e => e > 0) && Math.max(...earnings) / Math.min(...earnings) < 3;
  const rnd = annualFlow(f, 'rnd').value;
  const value = stable && growth != null && growth <= 0.06 && i.equity != null && i.equity > 0
    && revenue != null && revenue > 0 && (rnd ?? 0) / revenue < 0.05;
  return { financial, loss, payout, assetIncome, stableValue: value };
}

/** Reason keys are translated by the caller; this module has no i18n/global state dependency. */
export function defaultAssumptions(f: CompanyFundamentals, closes: PriceClose[] = []) {
  const revenue = historicalCagr(f.annual, 'revenue');
  const fcf = historicalCagr(f.annual, 'freeCashFlow');
  const historicalGrowth = revenue ?? fcf;
  const growth = historicalGrowth == null ? 0.05 : clamp(historicalGrowth * 0.75, -0.05, 0.20);
  const history = historicalMultiples(f, closes);
  const profile = companyProfile(f, historicalGrowth);
  const fallbackPe = profile.financial ? 15 : historicalGrowth != null && historicalGrowth > 0.08 ? 22 : 18;
  const discount = profile.loss ? 0.12 : profile.financial ? 0.10 : historicalGrowth != null && historicalGrowth > 0.20 ? 0.11 : 0.09;
  const inputs = valuationInputs(f);
  const roe = inputs.equity && inputs.equity > 0 && inputs.shares && inputs.eps.value != null
    ? inputs.eps.value * inputs.shares / inputs.equity : null;
  const assumptions: Assumptions = {
    growth, discount, terminalGrowth: 0.025, pe: clamp(history.pe.median ?? fallbackPe, 8, 45),
    pfcf: clamp(history.pfcf.median ?? (growth > 0.06 ? 25 : 18), 8, 50),
    ps: clamp(history.ps.median ?? 2, 0.3, 12),
    pb: clamp(roe == null ? 1 : (roe - 0.025) / (discount - 0.025), 0.5, 4),
    epsGrowth: growth, years: 5,
    dividendGrowth: clamp(growth, 0, 0.04), fcfMode: normalizedFcf(f) == null ? 'latest' : 'normalized', includeNetCash: false,
  };
  return { assumptions, historicalGrowth, history, profile,
    rationale: revenue != null ? 'revenue' as const : fcf != null ? 'fcf' as const : 'fallback' as const };
}

/** Years 1–5 use the initial rate; years 6–10 linearly converge to terminal growth.
 * Terminal value is FCF in year 11 / (discount - terminal growth), discounted ten years. */
export function dcf(input: DcfInput): Estimate {
  const { fcfPerShare: fcf, growth, discount, terminalGrowth, netCashPerShare = 0 } = input;
  if (!finite(fcf)) return fail('missingFcf');
  if (fcf <= 0) return fail('nonPositiveFcf');
  if (![growth, discount, terminalGrowth].every(finite) || growth <= -1 || terminalGrowth <= -1
    || discount <= 0 || discount <= terminalGrowth) return fail('invalidRates');
  if (!finite(netCashPerShare)) return fail('missingCashDebt');
  let flow = fcf;
  let present = 0;
  for (let year = 1; year <= 10; year++) {
    const rate = year <= 5 ? growth : growth + (terminalGrowth - growth) * (year - 5) / 5;
    flow *= 1 + rate;
    present += flow / (1 + discount) ** year;
  }
  return result(present + flow * (1 + terminalGrowth) / (discount - terminalGrowth) / (1 + discount) ** 10 + netCashPerShare);
}

export function earningsValue(eps: number | null, pe: number, growth = 0, years = 0, discount = 0): Estimate {
  if (!finite(eps)) return fail('missingEps');
  if (eps <= 0) return fail('nonPositiveEps');
  if (!finite(pe) || pe <= 0) return fail('invalidPe');
  if (!Number.isInteger(years) || years < 0 || years > 50) return fail('invalidHorizon');
  if (!finite(growth) || growth <= -1 || !finite(discount) || discount < 0) return fail('invalidRates');
  return result(eps * pe * ((1 + growth) / (1 + discount)) ** years);
}

export function grahamValue(eps: number | null, equity: number | null, shares: number | null): Estimate {
  if (!finite(eps)) return fail('missingEps');
  if (eps <= 0) return fail('nonPositiveEps');
  if (!finite(equity)) return fail('missingEquity');
  if (equity <= 0) return fail('nonPositiveEquity');
  if (!finite(shares) || shares <= 0) return fail('missingShares');
  return result(Math.sqrt(22.5 * eps * (equity / shares)));
}

export function dividendValue(paid: number | null, shares: number | null, growth: number, discount: number): Estimate {
  if (!finite(paid)) return fail('missingDividends');
  // Outgoing dividends are negative in the source data. Do not turn an inflow into a payout.
  if (paid >= 0) return fail('noDividends');
  if (!finite(shares) || shares <= 0) return fail('missingShares');
  if (!finite(growth) || !finite(discount) || growth <= -1 || discount <= 0 || discount <= growth) return fail('invalidRates');
  return result((-paid / shares) * (1 + growth) / (discount - growth));
}

/** Search a stated finite interval: -90% to +300% initial annual growth. */
export function reverseDcf(input: DcfInput, price: number | null): Estimate {
  if (!finite(price) || price <= 0) return fail('missingPrice');
  let low = -0.9;
  let high = 3;
  const lower = dcf({ ...input, growth: low });
  const upper = dcf({ ...input, growth: high });
  if (lower.value == null) return lower;
  if (upper.value == null) return upper;
  if (price < lower.value || price > upper.value) return fail('unreachable');
  for (let i = 0; i < 100; i++) {
    const middle = (low + high) / 2;
    const estimate = dcf({ ...input, growth: middle });
    if (estimate.value == null) return estimate;
    if (Math.abs(estimate.value - price) <= Math.max(1e-8, price * 1e-10)) return result(middle);
    if (estimate.value < price) low = middle; else high = middle;
  }
  return result((low + high) / 2);
}

export function median(values: number[]): number | null {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return !sorted.length ? null : sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
}

/** Only show classical margin of safety when buying below estimated value. */
export function marginOfSafety(value: number | null, price: number | null): number | null {
  if (!finite(value) || value <= 0 || !finite(price) || price <= 0 || price >= value) return null;
  const margin = 1 - price / value;
  return finite(margin) ? margin : null;
}

export function fairValuePotential(value: number | null, price: number | null): number | null {
  if (!finite(value) || value < 0 || !finite(price) || price <= 0) return null;
  const potential = value / price - 1;
  return finite(potential) ? potential : null;
}

const WEIGHTS: Record<CompanyType, Partial<Record<MethodId, number>>> = {
  financial: { pe: 0.75, pb: 0.25 },
  loss: { ps: 1 },
  assetIncome: {},
  growth: { dcf: 0.30, pe: 0.40, peGrowth: 0.10, pfcf: 0.20 },
  dividend: { dcf: 0.20, pe: 0.45, pfcf: 0.25, dividend: 0.10 },
  value: { dcf: 0.20, pe: 0.45, pfcf: 0.20, graham: 0.15 },
  mature: { dcf: 0.30, pe: 0.50, pfcf: 0.20 },
};

export function calculateFairValue(f: CompanyFundamentals, price: number | null,
  assumptions?: Assumptions, closes: PriceClose[] = []) {
  const defaults = defaultAssumptions(f, closes);
  assumptions = assumptions ?? defaults.assumptions;
  const inputs = valuationInputs(f, assumptions.fcfMode);
  const profile = defaults.profile;
  const validPrice = finite(price) && price > 0 ? price : null;
  const dividendYield = validPrice && inputs.shares && inputs.dividends.value != null
    ? -inputs.dividends.value / inputs.shares / validPrice : null;
  const meaningfulDividend = profile.payout != null && profile.payout >= 0.25 && profile.payout <= 1
    && dividendYield != null && dividendYield >= 0.015;
  const companyType: CompanyType = profile.loss ? 'loss' : profile.financial ? 'financial' : profile.assetIncome ? 'assetIncome'
    : meaningfulDividend ? 'dividend' : profile.stableValue && defaults.assumptions.pe <= 18 ? 'value'
    : (defaults.historicalGrowth ?? 0) > 0.08 ? 'growth' : 'mature';
  const currencyBlocked = f.currency?.trim().toUpperCase() !== 'USD';
  const dcfInput: DcfInput = {
    fcfPerShare: inputs.fcfPerShare, growth: assumptions.growth, discount: assumptions.discount,
    terminalGrowth: assumptions.terminalGrowth, netCashPerShare: assumptions.includeNetCash ? inputs.netCashPerShare : 0,
  };
  const dcfReason: Reason | null = currencyBlocked ? 'currency' : inputs.shares == null ? 'missingShares'
    : profile.financial ? 'financialCashFlow' : profile.loss ? 'lossMaking' : profile.assetIncome ? 'missingAffo'
    : inputs.fcf.value == null ? assumptions.fcfMode === 'average3' ? 'missingAverage' : 'missingFcf' : null;
  const revenue = annualFlow(f, 'revenue').value;
  const multipleValue = (base: number | null, multiple: number, reason: Reason): Estimate => {
    if (!finite(base) || base <= 0) return fail(reason);
    if (!inputs.shares) return fail('missingShares');
    return earningsValue(base / inputs.shares, multiple);
  };
  const dividend = dividendValue(inputs.dividends.value, inputs.shares, assumptions.dividendGrowth, assumptions.discount);
  const earningsReason: Reason | null = profile.loss ? inputs.eps.value != null && inputs.eps.value <= 0 ? 'nonPositiveEps' : 'lossMaking' : null;
  const methods: Record<MethodId, Estimate> = {
    dcf: dcfReason ? fail(dcfReason) : dcf(dcfInput),
    pe: earningsReason ? fail(earningsReason) : earningsValue(inputs.eps.value, assumptions.pe),
    peGrowth: earningsReason ? fail(earningsReason) : earningsValue(inputs.eps.value, assumptions.pe, assumptions.epsGrowth, assumptions.years, assumptions.discount),
    pfcf: dcfReason ? fail(dcfReason) : multipleValue(inputs.fcf.value, assumptions.pfcf, inputs.fcf.value == null ? 'missingFcf' : 'nonPositiveFcf'),
    pb: multipleValue(inputs.equity, assumptions.pb, inputs.equity == null ? 'missingEquity' : 'nonPositiveEquity'),
    ps: defaults.history.ps.median == null && profile.loss ? fail('missingHistory') : multipleValue(revenue, assumptions.ps, 'missingRevenue'),
    graham: earningsReason ? fail(earningsReason) : grahamValue(inputs.eps.value, inputs.equity, inputs.shares),
    dividend: dividend.reason ? dividend : profile.loss ? fail('lossMaking') : meaningfulDividend ? dividend : fail('minorDividend'),
  };
  for (const method of METHOD_IDS) {
    if (currencyBlocked) methods[method] = fail('currency');
    else if (methods[method].value != null && methods[method].value! <= 0) methods[method] = fail('nonPositiveValue');
  }
  const weights = Object.fromEntries(METHOD_IDS.map(method => [method,
    methods[method].value == null ? 0 : WEIGHTS[companyType][method] ?? 0])) as Record<MethodId, number>;
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (total > 0) for (const method of METHOD_IDS) weights[method] /= total;
  const included = METHOD_IDS.filter(method => weights[method] > 0);
  const weighted = total > 0 ? included.reduce((sum, method) => sum + methods[method].value! * weights[method], 0) : null;
  const value = finite(weighted) && weighted > 0 ? weighted : null;
  const reason: Reason | null = value != null ? null : currencyBlocked ? 'currency'
    : profile.assetIncome ? 'missingAffo' : profile.loss ? methods.ps.reason ?? 'noApplicableMethods' : 'noApplicableMethods';
  const discounts = [-0.01, 0, 0.01].map(offset => assumptions.discount + offset);
  const growths = [-0.02, 0, 0.02].map(offset => assumptions.growth + offset);
  return {
    inputs, methods, value, reason, companyType, weights, included, relativeOnly: companyType === 'loss',
    usableCount: included.length, marginOfSafety: marginOfSafety(value, price), potential: fairValuePotential(value, price),
    priceDeviation: value != null && validPrice != null ? fairValuePotential(validPrice, value) : null,
    reverse: dcfReason ? fail(dcfReason) : reverseDcf(dcfInput, price),
    sensitivity: { discounts, growths, cells: discounts.map(discount => growths.map(growth =>
      dcfReason ? fail(dcfReason) : dcf({ ...dcfInput, discount, growth }))) },
  };
}
