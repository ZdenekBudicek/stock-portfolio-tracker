import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from '@/types/fundamentals';
import { medianOf, valuationSeries, type Multiple } from '@/lib/valuationSeries';

// All rates are fractions (0.10 = 10%). No IO, currency conversion or implicit zeroes.
export type Reason = 'currency' | 'missingFcf' | 'nonPositiveFcf' | 'missingShares' | 'missingEps'
  | 'nonPositiveEps' | 'missingEquity' | 'nonPositiveEquity' | 'missingDividends' | 'noDividends'
  | 'missingCashDebt' | 'invalidRates' | 'invalidPe' | 'invalidHorizon' | 'missingPrice'
  | 'unreachable' | 'nonFinite' | 'missingAverage' | 'financialCashFlow' | 'lossMaking'
  | 'minorDividend' | 'missingRevenue' | 'missingHistory' | 'missingAffo' | 'noApplicableMethods'
  | 'nonPositiveValue' | 'missingAnalysts';
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
  /** Growth model (Ocenění v2): revenue growth in years 1–2, then a fade to terminal growth. */
  revenueGrowth: number;
  /** Growth model: free cash flow margin reached in year 5 and kept. */
  targetMargin: number;
  /** Growth model: yearly growth of the share count (paying with stock). */
  dilution: number;
}
/** Consensus of one fiscal year, the shape analyst_snapshots stores (scripts/analyst-snapshot.mjs; live Nasdaq rows,
 * Ocenění v3, add up to two `later` years of EPS and no revenue). */
export interface ConsensusEstimate { period: 'current' | 'next' | 'later'; endDate: string | null; eps: number | null; revenue: number | null;
  epsGrowth: number | null; revenueGrowth: number | null; analysts: number | null }
/** What analysts expect. Estimates and targets are used only in the statements' currency. */
export interface MarketContext {
  estimates?: ConsensusEstimate[] | null; estimatesCurrency?: string | null;
  targetMean?: number | null; targetLow?: number | null; targetHigh?: number | null; targetCurrency?: string | null;
  /** Analysts behind the targets (buy + hold + sell); the target counts as a method from ANALYST_MIN on. */
  analystCount?: number | null;
  /** Valuation date (YYYY-MM-DD); defaults to the statement snapshot, never wall-clock time. */
  asOf?: string | null;
}
export interface DcfInput { fcfPerShare: number | null; growth: number; discount: number; terminalGrowth: number; netCashPerShare?: number | null }
export const METHOD_IDS = ['dcf', 'pe', 'peGrowth', 'pfcf', 'pb', 'ps', 'graham', 'dividend', 'earningsPath', 'analysts'] as const;
export type MethodId = typeof METHOD_IDS[number];
export type PriceClose = { date: string; close: number };
export type CompanyType = 'financial' | 'loss' | 'assetIncome' | 'cyclical' | 'growth' | 'dividend' | 'value' | 'mature';
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
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => values.length ? sum(values) / values.length : 0;

/* ----------------------------- Ocenění v2: growth model ----------------------------- */
/** Revenue growth from year 3 on starts at most here and falls linearly to terminal growth in year 10:
 * a company growing 70 % today does not keep it, but does not stop at once either. */
export const LATE_GROWTH_CAP = 0.30;
/** Margin path: today's margin moves linearly to the target by this year and stays. */
export const MARGIN_YEARS = 5;
/** Yearly revenue growth from which a company is valued with the growth model. */
export const GROWTH_MODEL_MIN = 0.15;

/** Consensus estimates in the statements' currency only; an unknown currency is not assumed. */
export function usableEstimates(f: CompanyFundamentals, market?: MarketContext | null): ConsensusEstimate[] {
  const currency = f.currency?.trim().toUpperCase();
  if (!market?.estimates?.length || !currency || market.estimatesCurrency?.trim().toUpperCase() !== currency) return [];
  return market.estimates.filter(e => (e.period === 'current' || e.period === 'next' || e.period === 'later')
    && (e.endDate == null || finite(Date.parse(e.endDate))));
}

/** Consensus EPS by fiscal year end, as years from the valuation date (closed years left out). */
export function epsPath(f: CompanyFundamentals, market?: MarketContext | null): { years: number; eps: number; analysts: number | null }[] {
  const asOf = market?.asOf ?? f.fetchedAt.slice(0, 10);
  return usableEstimates(f, market).flatMap(e => {
    const years = e.endDate ? dayGap(asOf, e.endDate) / 365.25 : NaN;
    return finite(e.eps) && finite(years) && years > -0.1 && years <= 5 ? [{ years, eps: e.eps, analysts: e.analysts }] : [];
  }).sort((a, b) => a.years - b.years);
}

/** Consensus EPS `years` ahead, linear between fiscal year ends; before the first one its value, beyond the last none. */
export function consensusEpsAt(path: { years: number; eps: number }[], years: number): number | null {
  if (!path.length || years > path[path.length - 1].years + 1e-9) return null;
  if (years <= path[0].years) return path[0].eps;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (years <= b.years) return a.eps + (b.eps - a.eps) * (years - a.years) / (b.years - a.years);
  }
  return null;
}

/** Analysts needed before their mean target becomes a method of the fair value. */
export const ANALYST_MIN = 3;

function revenueBase(f: CompanyFundamentals): { value: number; date: string } | null {
  const flow = annualFlow(f, 'revenue');
  if (flow.value == null || flow.value <= 0) return null;
  const date = flow.source === 'ttm' ? f.quarterly.periods[f.quarterly.periods.length - 1] : lastReported(f.annual, 'revenue')?.date;
  return date ? { value: flow.value, date } : null;
}

/** The latest four quarters against the four before; otherwise the latest fiscal year against the one before. */
export function recentRevenueGrowth(f: CompanyFundamentals): number | null {
  const q = f.quarterly, n = q.periods.length;
  if (n >= 8) {
    const dates = q.periods.slice(-8);
    const values = dates.map((_, i) => at(q, 'revenue', n - 8 + i));
    if (consecutive(dates, 60, 120) && values.every(finite)) {
      const last = sum((values as number[]).slice(4)), prior = sum((values as number[]).slice(0, 4));
      if (prior > 0 && last > 0) return last / prior - 1;
    }
  }
  const a = f.annual, m = a.periods.length;
  const last = at(a, 'revenue', m - 1), prior = at(a, 'revenue', m - 2);
  return m >= 2 && last != null && prior != null && last > 0 && prior > 0 && consecutive(a.periods.slice(-2), 320, 410) ? last / prior - 1 : null;
}

/**
 * The consensus revenue on the statements' basis. For a bank or fintech the statements carry net revenue while the
 * consensus counts gross revenue (NU 2025: 10.6 bn USD reported, 15.8 bn implied by the consensus), so comparing the
 * two reads the change of basis as growth. The current year's consensus and its own growth give the year before;
 * against that year as reported they give the scale (1 when the two agree within 10 %).
 */
export function revenueBasisFactor(f: CompanyFundamentals, estimates: ConsensusEstimate[]): number {
  const current = estimates.find(e => e.period === 'current');
  const last = lastReported(f.annual, 'revenue');
  if (!current?.endDate || !finite(current.revenue) || current.revenue <= 0 || !finite(current.revenueGrowth) || current.revenueGrowth <= -0.9
    || !last || last.value <= 0) return 1;
  const gap = dayGap(last.date, current.endDate);
  if (gap < 320 || gap > 410) return 1;
  const k = last.value / (current.revenue / (1 + current.revenueGrowth));
  return !finite(k) || (k > 0.9 && k < 1.1) ? 1 : clamp(k, 0.2, 5);
}

export type GrowthSource = 'consensus' | 'recent';
/** Yearly revenue growth from the latest reported revenue to the consensus of the next fiscal year
 * (or the current one); without estimates the latest year-on-year growth. */
export function forwardRevenueGrowth(f: CompanyFundamentals, market?: MarketContext | null): { rate: number; source: GrowthSource } | null {
  const base = revenueBase(f);
  const estimates = usableEstimates(f, market);
  const scale = revenueBasisFactor(f, estimates);
  if (base) for (const period of ['next', 'current'] as const) {
    const e = estimates.find(x => x.period === period);
    if (!e?.endDate || !finite(e.revenue) || e.revenue <= 0) continue;
    const years = dayGap(base.date, e.endDate) / 365.25;
    if (years < 0.4 || years > 3) continue;
    const rate = (e.revenue * scale / base.value) ** (1 / years) - 1;
    if (finite(rate)) return { rate: clamp(rate, -0.5, 1.5), source: 'consensus' };
  }
  const recent = recentRevenueGrowth(f);
  return recent == null ? null : { rate: clamp(recent, -0.5, 1.5), source: 'recent' };
}

/** Growth in each year 1..years: the starting rate for two years, then the fade toward terminal growth. */
export function revenueGrowthPath(start: number, terminal: number, years = 10): number[] {
  const late = Math.min(start, LATE_GROWTH_CAP);
  return Array.from({ length: years }, (_, i) => i < 2 ? start : i >= 9 ? terminal : late + (terminal - late) * (i - 1) / 8);
}

/** P/E a company growing earnings per share `growth` a year over the next five years earns: 12 + 0.9 × growth in %
 * (10 % ≈ 21, 20 % ≈ 30, 30 % ≈ 39), 12–45. It replaces the historical median for growth companies, so a past
 * of depressed earnings no longer caps a company whose growth is ahead of it. */
const rawGrowthMultiple = (growth: number) => 12 + 90 * growth;
export function growthMultiple(growth: number): number {
  return clamp(rawGrowthMultiple(growth), 12, 45);
}
/** Ocenění v3: growth earns its premium only with a margin behind it. The premium over 12 is scaled by the net margin,
 * in full from 15 %, half at 7.5 % or less: a server assembler growing 30 % at 7 % is not a software company. */
export const qualityFactor = (netMargin: number | null) => netMargin == null || !finite(netMargin) ? 1 : clamp(netMargin / 0.15, 0.5, 1);
export const qualityMultiple = (growth: number, netMargin: number | null) => 12 + (growthMultiple(growth) - 12) * qualityFactor(netMargin);

export interface GrowthDcfInput {
  revenuePerShare: number | null; revenueGrowth: number; discount: number; terminalGrowth: number;
  margin: number | null; targetMargin: number; dilution: number; netCashPerShare?: number | null;
}
/** Revenue → FCF margin → cash per share for ten years, the share count growing by `dilution`.
 * Terminal value: the average of Gordon growth and an exit multiple for the growth left in year 10. */
export function growthDcf(input: GrowthDcfInput): Estimate {
  const { revenuePerShare: revenue, revenueGrowth, discount, terminalGrowth, margin, targetMargin, dilution, netCashPerShare = 0 } = input;
  if (!finite(revenue) || revenue <= 0) return fail('missingRevenue');
  if (!finite(margin)) return fail('missingFcf');
  if (![revenueGrowth, discount, terminalGrowth, targetMargin, dilution].every(finite) || revenueGrowth <= -1 || terminalGrowth <= -1
    || discount <= 0 || discount <= terminalGrowth || dilution <= -0.5) return fail('invalidRates');
  if (targetMargin <= 0) return fail('nonPositiveFcf');
  if (!finite(netCashPerShare)) return fail('missingCashDebt');
  const path = revenueGrowthPath(revenueGrowth, terminalGrowth);
  let sales = revenue, present = 0, flow = 0;
  for (let year = 1; year <= 10; year++) {
    sales *= 1 + path[year - 1];
    const m = year >= MARGIN_YEARS ? targetMargin : margin + (targetMargin - margin) * year / MARGIN_YEARS;
    flow = sales * m / (1 + dilution) ** year;
    present += flow / (1 + discount) ** year;
  }
  if (flow <= 0) return fail('nonPositiveFcf');
  const gordon = (1 + terminalGrowth) / (discount - terminalGrowth);
  const terminal = flow * (gordon + growthMultiple(path[9])) / 2;
  return result(present + terminal / (1 + discount) ** 10 + netCashPerShare);
}

/** Starting revenue growth that makes the growth DCF equal the price, searched in -50 % to +200 %. */
export function reverseGrowthDcf(input: GrowthDcfInput, price: number | null): Estimate {
  if (!finite(price) || price <= 0) return fail('missingPrice');
  let low = -0.5, high = 2;
  const lower = growthDcf({ ...input, revenueGrowth: low });
  const upper = growthDcf({ ...input, revenueGrowth: high });
  if (lower.value == null) return lower;
  if (upper.value == null) return upper;
  if (price < lower.value || price > upper.value) return fail('unreachable');
  for (let i = 0; i < 100; i++) {
    const middle = (low + high) / 2;
    const estimate = growthDcf({ ...input, revenueGrowth: middle });
    if (estimate.value == null) return estimate;
    if (Math.abs(estimate.value - price) <= Math.max(1e-8, price * 1e-10)) return result(middle);
    if (estimate.value < price) low = middle; else high = middle;
  }
  return result((low + high) / 2);
}

/** Net margin the consensus implies for the next fiscal year (EPS × today's shares / revenue). Without a
 * revenue consensus (live Nasdaq data) the revenue is today's grown at `growth` to that year end. */
function consensusNetMargin(estimates: ConsensusEstimate[], shares: number | null, base?: { value: number; date: string } | null, growth?: number,
  scale = 1): number | null {
  const e = estimates.find(x => x.period === 'next') ?? estimates.find(x => x.period === 'current');
  if (!e || !finite(e.eps) || !shares) return null;
  const years = base && e.endDate ? dayGap(base.date, e.endDate) / 365.25 : null;
  // On the statements' basis (revenueBasisFactor), the same revenue the margin is later applied to.
  const revenue = finite(e.revenue) && e.revenue > 0 ? e.revenue * scale
    : base && finite(growth) && years != null && years > 0 && years <= 3 ? base.value * (1 + growth) ** years : null;
  if (!revenue) return null;
  const margin = e.eps * shares / revenue;
  return finite(margin) ? margin : null;
}

/** Best margin of the last five fiscal years; a single bad year does not set the target. */
function bestMargin(f: CompanyFundamentals, metric: FundamentalMetric): number | null {
  const a = f.annual, n = a.periods.length;
  const margins = a.periods.slice(-5).map((_, j) => {
    const i = n - Math.min(5, n) + j;
    const r = at(a, 'revenue', i), x = at(a, metric, i);
    return r != null && r > 0 && x != null ? x / r : null;
  }).filter(finite);
  return margins.length ? Math.max(...margins) : null;
}

/** A yearly flow (TTM or the latest fiscal year) as a share of the same window's revenue. */
function marginOf(f: CompanyFundamentals, value: number | null): number | null {
  const revenue = annualFlow(f, 'revenue').value;
  return revenue != null && revenue > 0 && value != null ? value / revenue : null;
}

/** Share-count change a year over the last three fiscal years, -3 % (buybacks) to +4 %. */
export function shareChange(f: CompanyFundamentals): number {
  const a = f.annual, n = a.periods.length;
  for (let i = Math.max(0, n - 4); i < n - 1; i++) {
    const start = at(a, 'dilutedShares', i) ?? at(a, 'sharesOutstanding', i);
    const end = at(a, 'dilutedShares', n - 1) ?? at(a, 'sharesOutstanding', n - 1);
    const years = dayGap(a.periods[i], a.periods[n - 1]) / 365.25;
    if (start != null && end != null && start > 0 && end > 0 && years >= 0.85) {
      const rate = (end / start) ** (1 / years) - 1;
      if (finite(rate)) return clamp(rate, -0.03, 0.04);
    }
  }
  return 0;
}
/** Dilution the growth DCF charges. Buybacks are paid from the same cash flow, so they never add value there. */
export const shareDilution = (f: CompanyFundamentals) => Math.max(0, shareChange(f));

const yearsUntil = (from: string, to: string | null) => to ? dayGap(from, to) / 365.25 : null;

/** Consensus EPS of the next fiscal year (else the current one) and how far its year end lies. */
export function forwardEps(f: CompanyFundamentals, market?: MarketContext | null): { eps: number; years: number; period: 'current' | 'next' } | null {
  const asOf = market?.asOf ?? f.fetchedAt.slice(0, 10);
  for (const period of ['next', 'current'] as const) {
    const e = usableEstimates(f, market).find(x => x.period === period);
    const years = yearsUntil(asOf, e?.endDate ?? null);
    if (e && finite(e.eps) && e.eps > 0 && years != null && years > -0.1 && years <= 2.5) return { eps: e.eps, years, period };
  }
  return null;
}

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

/** Ocenění v3: P/E paid for a cyclical company's earnings near the top of its cycle (memory chips, commodities):
 * the market never capitalises peak profit at a growth multiple, because the cycle turns. */
export const CYCLICAL_PE = 12;
/** Earnings that swing with an industry cycle: over the last 12 quarters (else five years) the net margin spans
 * at least 25 points, dipped to 5 % or less and reached 15 % or more, and the gross margin swung at least 25 points from
 * 30 % or less — the price of the product itself moves (memory chips 10 → 85 %), unlike a software company that simply
 * became profitable at a steady 80 % gross margin. Mid-cycle margins are the totals over that window. */
export function cycleProfile(f: CompanyFundamentals): { cyclical: boolean; midNetMargin: number | null; midFcfMargin: number | null } {
  const rows = (s: FundamentalSeries, count: number) => s.periods.slice(-count).map((_, j) => {
    const i = s.periods.length - Math.min(count, s.periods.length) + j;
    return { revenue: at(s, 'revenue', i), income: at(s, 'netIncome', i), fcf: at(s, 'freeCashFlow', i) };
  }).filter(r => r.revenue != null && r.revenue > 0 && r.income != null) as { revenue: number; income: number; fcf: number | null }[];
  const quarters = rows(f.quarterly, 12);
  const span = quarters.length >= 8 ? quarters : rows(f.annual, 5);
  if (span.length < 3) return { cyclical: false, midNetMargin: null, midFcfMargin: null };
  const margins = span.map(r => r.income / r.revenue);
  const grossSwing = (s: FundamentalSeries, count: number) => {
    const from = Math.max(0, s.periods.length - count);
    const gm = s.periods.slice(from).map((_, j) => {
      const r = at(s, 'revenue', from + j), g = at(s, 'grossProfit', from + j) ?? (r != null && at(s, 'costOfRevenue', from + j) != null ? r - at(s, 'costOfRevenue', from + j)! : null);
      return r != null && r > 0 && g != null ? g / r : null;
    }).filter(finite);
    return gm.length >= 3 && Math.max(...gm) - Math.min(...gm) >= 0.25 && Math.min(...gm) <= 0.30;
  };
  const cyclical = (grossSwing(f.quarterly, 12) || grossSwing(f.annual, 5))
    && Math.max(...margins) - Math.min(...margins) >= 0.25 && Math.min(...margins) <= 0.05 && Math.max(...margins) >= 0.15;
  const sales = sum(span.map(r => r.revenue));
  const withFcf = span.filter(r => r.fcf != null);
  return { cyclical, midNetMargin: sum(span.map(r => r.income)) / sales,
    midFcfMargin: withFcf.length === span.length ? sum(withFcf.map(r => r.fcf!)) / sales : null };
}

/** Reason keys are translated by the caller; this module has no i18n/global state dependency. */
export function defaultAssumptions(f: CompanyFundamentals, closes: PriceClose[] = [], market?: MarketContext | null) {
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
  // Ocenění v2: a growth company is valued from the consensus (or the latest growth), not from history.
  const estimates = usableEstimates(f, market);
  const forward = forwardRevenueGrowth(f, market);
  // Growth model only above 15 % a year (both consensus years above 10 %); slower companies keep the classic methods.
  // Only the years with a revenue consensus speak to revenue growth (live Nasdaq years have EPS only).
  const revenueYears = estimates.filter(e => e.period !== 'later' && finite(e.revenue));
  const consensusGrowing = revenueYears.length > 0 && revenueYears.every(e => finite(e.revenueGrowth) && e.revenueGrowth > 0.10);
  // A cyclical company at a high margin is valued through the cycle, never as a growth company on peak profit.
  const cycle = cycleProfile(f);
  const cyclical = cycle.cyclical && !profile.loss && !profile.financial && !profile.assetIncome;
  const growthModel = !cyclical && !profile.loss && !profile.financial && !profile.assetIncome && forward != null && forward.rate > GROWTH_MODEL_MIN
    && (forward.source === 'consensus' ? consensusGrowing : (historicalGrowth ?? 0) > 0.08)
    && !(profile.stableValue && clamp(history.pe.median ?? fallbackPe, 8, 45) <= 18);
  // A cyclical company grows from here as its EPS consensus does beyond the current year, not as at the upswing.
  const nextEps = estimates.find(e => e.period === 'next'), currentEps = estimates.find(e => e.period === 'current');
  // The provider's own growth for the next year first: this year's consensus can hold one-off gains (GOOGL, AMZN 2026).
  const consensusEpsGrowth = finite(nextEps?.epsGrowth) ? nextEps!.epsGrowth!
    : finite(nextEps?.eps) && finite(currentEps?.eps) && currentEps!.eps! > 0 ? nextEps!.eps! / currentEps!.eps! - 1 : null;
  const revenueGrowth = cyclical ? clamp(consensusEpsGrowth ?? Math.min(forward?.rate ?? growth, 0.1), -0.2, 0.3) : forward?.rate ?? growth;
  const path = revenueGrowthPath(revenueGrowth, 0.025);
  const fcfMode: Assumptions['fcfMode'] = normalizedFcf(f) == null ? 'latest' : 'normalized';
  const fcfMargin = marginOf(f, valuationInputs(f, fcfMode).fcf.value);
  const consensusMargin = consensusNetMargin(estimates, inputs.shares, revenueBase(f), revenueGrowth, revenueBasisFactor(f, estimates));
  const targetMargin = cyclical ? clamp(cycle.midFcfMargin ?? cycle.midNetMargin ?? 0.05, 0.02, 0.4)
    : clamp(Math.max(fcfMargin ?? 0, consensusMargin ?? bestMargin(f, 'freeCashFlow') ?? 0), 0.03, 0.55);
  // Required return by how much of the value lies in distant growth: 10 %, above 40 % growth 11 %.
  const growthDiscount = revenueGrowth > 0.4 ? 0.11 : 0.10;
  // Earnings per share grow with revenue plus buybacks (minus dilution); when analysts see EPS growing more slowly
  // than that after this year, their view pulls the growth down (never up), and the margin sets the premium.
  const revenueAhead = mean(path.slice(2, 7));
  const growthForPe = consensusEpsGrowth == null ? revenueAhead : Math.min(revenueAhead, (revenueAhead + clamp(consensusEpsGrowth, -0.2, 0.6)) / 2);
  const forwardPe = qualityMultiple(growthForPe - shareChange(f), consensusMargin ?? typicalNetMargin(f));
  const assumptions: Assumptions = {
    growth, discount: cyclical ? 0.11 : growthModel ? growthDiscount : discount, terminalGrowth: 0.025,
    pe: cyclical ? CYCLICAL_PE : growthModel ? forwardPe : clamp(history.pe.median ?? fallbackPe, 8, 45),
    pfcf: clamp(history.pfcf.median ?? (growth > 0.06 ? 25 : 18), 8, 50),
    // A company without profit is valued on its own P/S history, which for a fast grower lies far above 12.
    ps: clamp(history.ps.median ?? 2, 0.3, profile.loss ? 40 : 12),
    pb: clamp(roe == null ? 1 : (roe - 0.025) / (discount - 0.025), 0.5, 4),
    epsGrowth: growth, years: 5,
    dividendGrowth: clamp(growth, 0, 0.04), fcfMode, includeNetCash: false,
    revenueGrowth, targetMargin, dilution: shareDilution(f),
  };
  return { assumptions, historicalGrowth, history, profile, growthModel, cyclical, cycle, forward, estimates, consensusMargin, fcfMargin,
    rationale: cyclical ? 'cycle' as const : growthModel ? forward!.source : revenue != null ? 'revenue' as const : fcf != null ? 'fcf' as const : 'fallback' as const };
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
  // Ocenění v3: a company without profit is valued by the first consensus year with profit, else relatively.
  loss: { ps: 0.3, earningsPath: 0.7 },
  assetIncome: {},
  growth: { dcf: 0.30, pe: 0.40, peGrowth: 0.10, pfcf: 0.20 },
  dividend: { dcf: 0.20, pe: 0.45, pfcf: 0.25, dividend: 0.10 },
  value: { dcf: 0.20, pe: 0.45, pfcf: 0.20, graham: 0.15 },
  mature: { dcf: 0.30, pe: 0.50, pfcf: 0.20 },
  // Ocenění v3: next year's EPS at a cyclical P/E and the revenue DCF at the mid-cycle margin.
  cyclical: { dcf: 0.30, pe: 0.70 },
};

/** Growth model (Ocenění v2): the revenue → margin DCF and P/E on the consensus of the next fiscal year. */
const REVENUE_MODEL_WEIGHTS: Partial<Record<MethodId, number>> = { dcf: 0.60, pe: 0.40 };
/** Ocenění v3: the analysts' mean target takes this share of the fair value when there is one (more for a company
 * without profit, where the models say least); the model methods keep their proportions in the rest. */
export const ANALYST_SHARE: Record<CompanyType, number> = { financial: 0.2, loss: 0.3, assetIncome: 0, cyclical: 0.2, growth: 0.2, dividend: 0.2, value: 0.2, mature: 0.2 };

/** Which methods each assumption feeds. An assumption whose methods all have zero summary weight
 * changes only the method cards, never the fair value (e.g. everything but P/S for a loss maker). */
export const ASSUMPTION_METHODS: Record<keyof Assumptions, MethodId[]> = {
  growth: ['dcf'], discount: ['dcf', 'pe', 'peGrowth', 'dividend', 'earningsPath', 'analysts'], terminalGrowth: ['dcf', 'earningsPath'],
  pe: ['pe', 'peGrowth'], pfcf: ['pfcf'], ps: ['ps'], pb: ['pb'], epsGrowth: ['peGrowth'], years: ['peGrowth'],
  dividendGrowth: ['dividend'], fcfMode: ['dcf', 'pfcf'], includeNetCash: ['dcf'],
  revenueGrowth: ['dcf'], targetMargin: ['dcf'], dilution: ['dcf'],
};
/** Assumptions only one of the two DCF models reads. */
const FCF_MODEL_ONLY: (keyof Assumptions)[] = ['growth'];
const REVENUE_MODEL_ONLY: (keyof Assumptions)[] = ['revenueGrowth', 'targetMargin', 'dilution'];

export type AnalystCheck = { mean: number; low: number | null; high: number | null; ratio: number;
  status: 'inline' | 'below' | 'above' | 'outside' };
/** Fair value against the analysts' 12-month targets; `outside` = beyond their whole range. */
export function analystCheck(value: number | null, f: CompanyFundamentals, market?: MarketContext | null): AnalystCheck | null {
  const currency = f.currency?.trim().toUpperCase();
  const m = market?.targetMean;
  if (!finite(value) || value <= 0 || !finite(m) || m <= 0 || !currency || market?.targetCurrency?.trim().toUpperCase() !== currency) return null;
  const low = finite(market.targetLow) && market.targetLow > 0 ? market.targetLow : null;
  const high = finite(market.targetHigh) && market.targetHigh > 0 ? market.targetHigh : null;
  const ratio = value / m;
  const status = (low != null && value < low) || (high != null && value > high) ? 'outside'
    : ratio < 0.8 ? 'below' : ratio > 1.25 ? 'above' : 'inline';
  return { mean: m, low, high, ratio, status };
}

export function calculateFairValue(f: CompanyFundamentals, price: number | null,
  assumptions?: Assumptions, closes: PriceClose[] = [], market?: MarketContext | null) {
  const defaults = defaultAssumptions(f, closes, market);
  assumptions = { ...defaults.assumptions, ...assumptions };
  const inputs = valuationInputs(f, assumptions.fcfMode);
  const profile = defaults.profile;
  const validPrice = finite(price) && price > 0 ? price : null;
  const dividendYield = validPrice && inputs.shares && inputs.dividends.value != null
    ? -inputs.dividends.value / inputs.shares / validPrice : null;
  const meaningfulDividend = profile.payout != null && profile.payout >= 0.25 && profile.payout <= 1
    && dividendYield != null && dividendYield >= 0.015;
  // A consensus growth company stays `growth` even with a dividend; its defaults already assume that model.
  const companyType: CompanyType = profile.loss ? 'loss' : profile.financial ? 'financial' : profile.assetIncome ? 'assetIncome'
    : defaults.cyclical ? 'cyclical' : defaults.growthModel ? 'growth' : meaningfulDividend ? 'dividend' : profile.stableValue && defaults.assumptions.pe <= 18 ? 'value'
    : (defaults.historicalGrowth ?? 0) > 0.08 ? 'growth' : 'mature';
  // The revenue → margin DCF serves the growth model and, at the mid-cycle margin, a cyclical company.
  const revenueModel = (companyType === 'growth' && defaults.growthModel) || companyType === 'cyclical';
  const typeWeights = revenueModel && companyType === 'growth' ? REVENUE_MODEL_WEIGHTS : WEIGHTS[companyType];
  const revenue0 = annualFlow(f, 'revenue').value;
  const growthInput: GrowthDcfInput = {
    revenuePerShare: inputs.shares && revenue0 != null ? revenue0 / inputs.shares : null, revenueGrowth: assumptions.revenueGrowth,
    discount: assumptions.discount, terminalGrowth: assumptions.terminalGrowth, margin: marginOf(f, inputs.fcf.value),
    targetMargin: assumptions.targetMargin, dilution: assumptions.dilution, netCashPerShare: assumptions.includeNetCash ? inputs.netCashPerShare : 0,
  };
  const forward = revenueModel && companyType === 'growth' ? forwardEps(f, market) : null;
  // Ocenění v3: every profitable company looks ahead — EPS twelve months out (consensus) at its own historical P/E,
  // a year from now, discounted back; a company without profit by the first consensus year with profit.
  const path = epsPath(f, market);
  const ntmEps = consensusEpsAt(path, 1);
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
  // Forward P/E: next year's consensus EPS, discounted for the part of the year beyond twelve months.
  const forwardPeValue = forward ? earningsValue(forward.eps, assumptions.pe, 0, 0) : null;
  const forwardValue = forwardPeValue?.value != null
    ? result(forwardPeValue.value / (1 + assumptions.discount) ** Math.max(0, forward!.years - 1)) : forwardPeValue;
  const modelDcf = (input: DcfInput, growth: GrowthDcfInput) => revenueModel ? growthDcf(growth) : dcf(input);
  const nextYear = !forward && ntmEps != null && ntmEps > 0 ? earningsValue(ntmEps, assumptions.pe) : null;
  const classicForward = nextYear?.value != null ? result(nextYear.value / (1 + assumptions.discount)) : null;
  // A year one analyst covers says little: the furthest year with at least two, and the growth around it from such years.
  const covered = path.filter(p => (p.analysts ?? ANALYST_MIN) >= 2);
  const ahead = [...covered].reverse().find(p => p.eps > 0) ?? [...path].reverse().find(p => p.eps > 0);
  const earningsPathValue = (): Estimate => {
    if (!ahead) return fail(path.length ? 'nonPositiveEps' : 'missingEps');
    const later = covered.find(p => p.years > ahead.years && p.eps > 0);
    const before = [...covered].reverse().find(p => p.years < ahead.years && p.eps > 0);
    const rate = (a: { years: number; eps: number }, b: { years: number; eps: number }) => (b.eps / a.eps) ** (1 / (b.years - a.years)) - 1;
    const growthAfter = later ? rate(ahead, later) : before ? rate(before, ahead) : assumptions.revenueGrowth;
    // The growth left after that year fades toward terminal growth: its average over the next five years.
    const multiple = growthMultiple((clamp(growthAfter, 0, 0.5) + assumptions.terminalGrowth) / 2 - shareChange(f));
    return result(ahead.eps * multiple / (1 + assumptions.discount) ** Math.max(0, ahead.years));
  };
  // Ocenění v3, a company without profit: revenue per share three years out at its own P/S, which shrinks as growth
  // slows (the multiple of the growth left then against today's), discounted back three years.
  const salesAhead = (): Estimate => {
    if (!finite(revenue) || revenue <= 0) return fail('missingRevenue');
    if (!inputs.shares) return fail('missingShares');
    const sales = revenueGrowthPath(assumptions.revenueGrowth, assumptions.terminalGrowth, 8);
    const perShare = revenue / inputs.shares * sales.slice(0, 3).reduce((v, g) => v * (1 + g), 1) / (1 + assumptions.dilution) ** 3;
    const compression = clamp(rawGrowthMultiple(Math.max(0, mean(sales.slice(3, 8)))) / rawGrowthMultiple(Math.max(0, mean(sales.slice(0, 5)))), 0.15, 1.2);
    return result(perShare * assumptions.ps * compression / (1 + assumptions.discount) ** 3);
  };
  const targetsUsable = finite(market?.targetMean) && market!.targetMean! > 0 && f.currency?.trim().toUpperCase() === market?.targetCurrency?.trim().toUpperCase()
    && (market?.analystCount == null || market.analystCount >= ANALYST_MIN);
  const analystsValue = targetsUsable ? result(market!.targetMean! / (1 + assumptions.discount)) : fail('missingAnalysts');
  const methods: Record<MethodId, Estimate> = {
    dcf: dcfReason && !(revenueModel && dcfReason === 'missingFcf') ? fail(dcfReason) : modelDcf(dcfInput, growthInput),
    pe: earningsReason ? fail(earningsReason) : forwardValue ?? classicForward ?? earningsValue(inputs.eps.value, assumptions.pe),
    peGrowth: earningsReason ? fail(earningsReason) : earningsValue(inputs.eps.value, assumptions.pe, assumptions.epsGrowth, assumptions.years, assumptions.discount),
    pfcf: dcfReason ? fail(dcfReason) : multipleValue(inputs.fcf.value, assumptions.pfcf, inputs.fcf.value == null ? 'missingFcf' : 'nonPositiveFcf'),
    pb: multipleValue(inputs.equity, assumptions.pb, inputs.equity == null ? 'missingEquity' : 'nonPositiveEquity'),
    ps: defaults.history.ps.median == null && profile.loss ? fail('missingHistory') : profile.loss ? salesAhead() : multipleValue(revenue, assumptions.ps, 'missingRevenue'),
    graham: earningsReason ? fail(earningsReason) : grahamValue(inputs.eps.value, inputs.equity, inputs.shares),
    dividend: dividend.reason ? dividend : profile.loss ? fail('lossMaking') : meaningfulDividend ? dividend : fail('minorDividend'),
    earningsPath: profile.financial || profile.assetIncome ? fail('noApplicableMethods') : earningsPathValue(),
    analysts: profile.assetIncome ? fail('missingAffo') : analystsValue,
  };
  for (const method of METHOD_IDS) {
    if (currencyBlocked) methods[method] = fail('currency');
    else if (methods[method].value != null && methods[method].value! <= 0) methods[method] = fail('nonPositiveValue');
  }
  const weights = Object.fromEntries(METHOD_IDS.map(method => [method,
    methods[method].value == null ? 0 : typeWeights[method] ?? 0])) as Record<MethodId, number>;
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (total > 0) for (const method of METHOD_IDS) weights[method] /= total;
  const analystShare = methods.analysts.value != null ? ANALYST_SHARE[companyType] : 0;
  if (analystShare > 0) {
    if (total > 0) for (const method of METHOD_IDS) weights[method] *= 1 - analystShare;
    weights.analysts = total > 0 ? analystShare : 0;
  }
  const included = METHOD_IDS.filter(method => weights[method] > 0);
  const weighted = total > 0 ? included.reduce((sum, method) => sum + methods[method].value! * weights[method], 0) : null;
  const value = finite(weighted) && weighted > 0 ? weighted : null;
  // The models alone (without the analysts' target), for the honest comparison with the analysts.
  const modelWeight = included.filter(m => m !== 'analysts').reduce((sum, m) => sum + weights[m], 0);
  const modelOnly = modelWeight > 0 ? included.filter(m => m !== 'analysts').reduce((sum, m) => sum + methods[m].value! * weights[m], 0) / modelWeight : null;
  const modelValue = finite(modelOnly) && modelOnly > 0 ? modelOnly : null;
  const reason: Reason | null = value != null ? null : currencyBlocked ? 'currency'
    : profile.assetIncome ? 'missingAffo' : profile.loss ? methods.ps.reason ?? 'noApplicableMethods' : 'noApplicableMethods';
  const discounts = [-0.01, 0, 0.01].map(offset => assumptions!.discount + offset);
  const growths = revenueModel ? [-0.05, 0, 0.05].map(offset => assumptions!.revenueGrowth + offset)
    : [-0.02, 0, 0.02].map(offset => assumptions!.growth + offset);
  const dcfBlocked = dcfReason && !(revenueModel && dcfReason === 'missingFcf') ? dcfReason : null;
  const cell = (discount: number, growth: number) => dcfBlocked ? fail(dcfBlocked) : revenueModel
    ? growthDcf({ ...growthInput, discount, revenueGrowth: growth }) : dcf({ ...dcfInput, discount, growth });
  const unusedKeys = revenueModel ? FCF_MODEL_ONLY : REVENUE_MODEL_ONLY;
  return {
    model: revenueModel ? 'revenue' as const : 'fcf' as const, forward, growthSource: revenueModel ? defaults.forward?.source ?? null : null,
    estimates: defaults.estimates, analystCheck: analystCheck(modelValue, f, market), modelValue, epsPath: path, ntmEps,
    inputs, methods, value, reason, companyType, weights, included, relativeOnly: companyType === 'loss' && !included.some(m => m === 'earningsPath' || m === 'analysts'),
    // The FCF base can make an unavailable DCF / P/FCF usable, so judge it by the profile weights.
    affectsSummary: Object.fromEntries((Object.keys(ASSUMPTION_METHODS) as (keyof Assumptions)[]).map(key => [key,
      !unusedKeys.includes(key) && ASSUMPTION_METHODS[key].some(method => key === 'fcfMode' ? (typeWeights[method] ?? 0) > 0 : weights[method] > 0)],
    )) as Record<keyof Assumptions, boolean>,
    usableCount: included.length, marginOfSafety: marginOfSafety(value, price), potential: fairValuePotential(value, price),
    priceDeviation: value != null && validPrice != null ? fairValuePotential(validPrice, value) : null,
    reverse: dcfBlocked ? fail(dcfBlocked) : revenueModel ? reverseGrowthDcf(growthInput, price) : reverseDcf(dcfInput, price),
    sensitivity: { discounts, growths, cells: discounts.map(discount => growths.map(growth => cell(discount, growth))) },
  };
}

/* ----------------------------- Ocenění v2: price scenarios ----------------------------- */
export type ScenarioKind = 'bear' | 'base' | 'bull';
/** Each case scales the growth above terminal growth, the net margin and the exit multiple by stated factors. */
export const SCENARIO_CASES: readonly { kind: ScenarioKind; growth: number; margin: number; multiple: number }[] = [
  { kind: 'bear', growth: 0.6, margin: 0.8, multiple: 0.8 },
  { kind: 'base', growth: 1, margin: 1, multiple: 1 },
  { kind: 'bull', growth: 1.25, margin: 1.1, multiple: 1.15 },
];
export interface PriceScenario {
  kind: ScenarioKind;
  /** `earnings`: EPS × P/E; `sales` (no profit yet): revenue × today's P/S, which shrinks as growth slows. */
  basis: 'earnings' | 'sales';
  startGrowth: number; netMargin: number | null; multiple: number;
  revenuePerShare: number; eps: number | null; price: number; annual: number | null;
}

/** Net margin of the latest four quarters and the last three fiscal years, the median: one-off gains do not set it. */
function typicalNetMargin(f: CompanyFundamentals): number | null {
  const a = f.annual, n = a.periods.length;
  const yearly = a.periods.slice(-3).map((_, j) => {
    const i = n - Math.min(3, n) + j, r = at(a, 'revenue', i), x = at(a, 'netIncome', i);
    return r != null && r > 0 && x != null ? x / r : null;
  });
  return median([marginOf(f, annualFlow(f, 'netIncome').value), ...yearly].filter(finite));
}

/** Price in `years` years: revenue per share along the growth path (the share count changing as it has), times the
 * consensus net margin (else the typical recent one) and the P/E of the growth still ahead then (growth companies) or
 * the company's own historical P/E. A company without profit: today's P/S scaled by how much its growth slows.
 * A model with stated assumptions, not a forecast. */
export function priceScenarios(f: CompanyFundamentals, price: number | null, years: number, market?: MarketContext | null,
  closes: PriceClose[] = []): { years: number; scenarios: PriceScenario[]; reason: Reason | null } {
  const none = (reason: Reason) => ({ years, scenarios: [], reason });
  if (!Number.isInteger(years) || years < 1 || years > 10) return none('invalidHorizon');
  if (f.currency?.trim().toUpperCase() !== 'USD') return none('currency');
  const defaults = defaultAssumptions(f, closes, market);
  const shares = valuationInputs(f).shares;
  const revenue = annualFlow(f, 'revenue').value;
  if (!shares) return none('missingShares');
  if (revenue == null || revenue <= 0) return none('missingRevenue');
  if (defaults.profile.financial) return none('financialCashFlow');
  if (defaults.profile.assetIncome) return none('missingAffo');
  const start = defaults.assumptions.revenueGrowth, terminal = defaults.assumptions.terminalGrowth;
  const change = shareChange(f);
  const margin = defaults.consensusMargin ?? (defaults.profile.loss ? null : typicalNetMargin(f));
  // Ocenění v3: where analysts (at least two) estimate EPS for the horizon, the base case is their EPS; the bear and
  // bull cases keep the model's distance from it. A company without profit today is valued on earnings then too.
  const consensusEps = consensusEpsAt(epsPath(f, market).filter(p => (p.analysts ?? ANALYST_MIN) >= 2), years);
  const anchored = consensusEps != null && consensusEps > 0;
  const sales = !anchored && (margin == null || margin <= 0.02);
  const validPrice = finite(price) && price > 0 ? price : null;
  if (sales && !validPrice) return none('missingPrice');
  if (defaults.cyclical) {
    const covered = epsPath(f, market).filter(p => (p.analysts ?? ANALYST_MIN) >= 2);
    const top = covered.length ? consensusEpsAt(covered, Math.min(years, covered[covered.length - 1].years)) : null;
    const sales = revenue / shares * revenueGrowthPath(start, terminal, years).reduce((v, g) => v * (1 + g), 1) / (1 + change) ** years;
    const mid = defaults.cycle.midNetMargin;
    const peak = top != null && top > 0 ? top : (typicalNetMargin(f) ?? 0) * sales;
    if (!(peak > 0) || mid == null) return none('nonPositiveEps');
    const pe = defaults.assumptions.pe;
    const cases: { kind: ScenarioKind; eps: number; multiple: number }[] = [
      // Bear: the cycle turns, earnings fall to the mid-cycle margin. Base: the consensus EPS, which by then is
      // behind the company, so the market pays less than today's cyclical P/E. Bull: the cycle runs longer.
      { kind: 'bear', eps: Math.max(0, mid) * sales, multiple: pe * 0.75 },
      { kind: 'base', eps: peak, multiple: pe * 0.85 },
      { kind: 'bull', eps: peak * 1.15, multiple: pe * 1.15 },
    ];
    const out = cases.map(c => ({ kind: c.kind, basis: 'earnings' as const, startGrowth: start, netMargin: c.eps / sales, multiple: c.multiple,
      revenuePerShare: sales, eps: c.eps, price: c.eps * c.multiple, annual: validPrice ? (c.eps * c.multiple / validPrice) ** (1 / years) - 1 : null }));
    return out.every(x => finite(x.price) && x.price > 0) ? { years, scenarios: out, reason: null } : none('nonPositiveEps');
  }
  const basePath = revenueGrowthPath(start, terminal, years + 5);
  const baseSales = revenue / shares * basePath.slice(0, years).reduce((v, g) => v * (1 + g), 1) / (1 + change) ** years;
  const scenarios = SCENARIO_CASES.map(c => {
    const path = basePath.map(g => terminal + (g - terminal) * c.growth);
    const perShare = revenue / shares * path.slice(0, years).reduce((v, g) => v * (1 + g), 1) / (1 + change) ** years;
    const ahead = mean(path.slice(years, years + 5)) - change;
    if (sales) {
      // Multiples of fast growers shrink as they mature: today's P/S × (multiple for the growth left then / for today's).
      // Uncapped, so hyper-growth today still compresses against the growth left later.
      const compression = clamp(rawGrowthMultiple(Math.max(0, ahead)) / rawGrowthMultiple(Math.max(0, mean(basePath.slice(0, 5)) - change)), 0.15, 1.2);
      const multiple = validPrice! / (revenue / shares) * compression * c.multiple;
      const value = perShare * multiple;
      return { kind: c.kind, basis: 'sales' as const, startGrowth: path[0], netMargin: null, multiple, revenuePerShare: perShare, eps: null,
        price: value, annual: (value / validPrice!) ** (1 / years) - 1 };
    }
    const multiple = (defaults.growthModel ? qualityMultiple(ahead, margin) : defaults.assumptions.pe) * c.multiple;
    const modelEps = (sales: number, m: number) => sales * Math.min(0.6, m);
    const eps = anchored
      ? consensusEps! * (margin != null && margin > 0 ? modelEps(perShare, margin * c.margin) / modelEps(baseSales, margin) : perShare / baseSales * c.margin)
      : modelEps(perShare, margin! * c.margin);
    const value = eps * multiple;
    return { kind: c.kind, basis: 'earnings' as const, startGrowth: path[0], netMargin: eps / perShare, multiple, revenuePerShare: perShare,
      eps, price: value, annual: validPrice ? (value / validPrice) ** (1 / years) - 1 : null };
  });
  return scenarios.every(x => finite(x.price) && x.price > 0) ? { years, scenarios, reason: null } : none('nonFinite');
}
