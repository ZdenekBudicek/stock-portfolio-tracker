// Historical valuation multiples (P/E, P/S, P/FCF, EV/EBITDA) from daily closes and the
// company's statements. An approximation, not a point-in-time database:
//
// - Closes are split-adjusted, reported share counts are not. Share counts from the annual AND
//   quarterly statements go on one timeline; a jump by a near-integer ratio between two
//   neighbouring counts is treated as a split and every older count is scaled to today's basis.
// - No look-ahead by design: a period is used only from a conservative publication lag after it
//   ended (annual reports 90 days, quarterly 45). Real filing dates are not in the source, and
//   later restatements are not visible either.
// - Trailing twelve months per metric: four consecutive published quarters when all four have
//   the metric, otherwise the latest published fiscal year — a missing quarter never blanks a
//   multiple that the annual report can still give.
// - A multiple on zero or negative earnings / cash flow is meaningless and is left out (null).
import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from '@/types/fundamentals';

export type Multiple = 'pe' | 'ps' | 'pfcf' | 'evEbitda';
export interface ValuationPoint { date: string; pe: number | null; ps: number | null; pfcf: number | null; evEbitda: number | null }

export const ANNUAL_LAG_DAYS = 90;
export const QUARTER_LAG_DAYS = 45;
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const gap = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;

const val = (s: FundamentalSeries, m: FundamentalMetric, i: number): number | null => {
  const v = s.values[m]?.[i];
  return v == null || !Number.isFinite(v) ? null : v;
};
const sharesAt = (s: FundamentalSeries, i: number) => val(s, 'dilutedShares', i) ?? val(s, 'sharesOutstanding', i);

/**
 * Split factor per share-count date (annual and quarterly together): multiply a count reported
 * for that period end by it to get today's basis.
 */
export function splitFactorsByDate(f: CompanyFundamentals): Map<string, number> {
  const byDate = new Map<string, number>();
  // Quarterly last so it wins on a shared period end.
  for (const s of [f.annual, f.quarterly]) s.periods.forEach((d, i) => { const v = sharesAt(s, i); if (v != null && v > 0) byDate.set(d, v); });
  const pts = [...byDate].sort(([a], [b]) => a.localeCompare(b));
  const out = new Map<string, number>();
  let factor = 1;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (i < pts.length - 1) {
      const r = pts[i + 1][1] / pts[i][1];
      const near = (x: number) => x >= 1.8 && Math.abs(x - Math.round(x)) / Math.round(x) < 0.06;
      if (near(r)) factor *= Math.round(r); // forward split between the two counts
      else if (near(1 / r)) factor /= Math.round(1 / r); // reverse split
    }
    out.set(pts[i][0], factor);
  }
  return out;
}

/** Kept for callers that only have one series. */
export function splitFactors(series: FundamentalSeries): number[] {
  const m = splitFactorsByDate({ symbol: '', currency: 'USD', fetchedAt: '', status: 'ok', annual: series, quarterly: { periods: [], values: {} as FundamentalSeries['values'] } });
  return series.periods.map((d) => m.get(d) ?? 1);
}

export type Flow = 'revenue' | 'netIncome' | 'fcf' | 'ebitda' | 'dividendsPaid';
const FLOWS: Flow[] = ['revenue', 'netIncome', 'fcf', 'ebitda'];
const flowAt = (s: FundamentalSeries, m: Flow, i: number): number | null => {
  if (m === 'fcf') {
    const fcf = val(s, 'freeCashFlow', i);
    if (fcf != null) return fcf;
    const ocf = val(s, 'operatingCashFlow', i), capex = val(s, 'capex', i);
    return ocf != null && capex != null ? ocf + capex : null;
  }
  return val(s, m, i);
};

interface Step { from: string; end: string; value: number }

/** Publication-dated trailing-twelve-month values of one flow metric, from both sources. */
function flowSteps(f: CompanyFundamentals, m: Flow): Step[] {
  const out: Step[] = [];
  const a = f.annual, q = f.quarterly;
  a.periods.forEach((end, i) => { const v = flowAt(a, m, i); if (v != null) out.push({ from: addDays(end, ANNUAL_LAG_DAYS), end, value: v }); });
  for (let i = 3; i < q.periods.length; i++) {
    let ok = true, sum = 0;
    for (let k = i - 3; k <= i; k++) {
      if (k > i - 3) { const g = gap(q.periods[k - 1], q.periods[k]); if (g < 60 || g > 120) { ok = false; break; } }
      const v = flowAt(q, m, k);
      if (v == null) { ok = false; break; }
      sum += v;
    }
    if (ok) out.push({ from: addDays(q.periods[i], QUARTER_LAG_DAYS), end: q.periods[i], value: sum });
  }
  return out.sort((x, y) => x.from.localeCompare(y.from));
}

/** Balance-sheet items; 'shares' prefers diluted counts, 'basicShares' the period-end count. */
export type Stock = 'shares' | 'basicShares' | 'cash' | 'totalDebt' | 'equity';
const isShares = (m: Stock) => m === 'shares' || m === 'basicShares';

/** Publication-dated balance-sheet values (shares on today's split basis, cash, debt, equity). */
function stockSteps(f: CompanyFundamentals, m: Stock): Step[] {
  const factors = splitFactorsByDate(f);
  const out: Step[] = [];
  for (const [s, lag] of [[f.annual, ANNUAL_LAG_DAYS], [f.quarterly, QUARTER_LAG_DAYS]] as const) {
    s.periods.forEach((end, i) => {
      const raw = m === 'shares' ? sharesAt(s, i) : m === 'basicShares' ? val(s, 'sharesOutstanding', i) ?? sharesAt(s, i) : val(s, m, i);
      if (raw == null) return;
      out.push({ from: addDays(end, lag), end, value: isShares(m) ? raw * (factors.get(end) ?? 1) : raw });
    });
  }
  return out.sort((x, y) => x.from.localeCompare(y.from));
}

/** The published step with the latest period end as of `date` (a newer period beats an older one published later). */
function asOf(steps: Step[], date: string): number | null {
  let best: Step | null = null;
  for (const s of steps) {
    if (s.from > date) break;
    if (!best || s.end >= best.end) best = s;
  }
  return best?.value ?? null;
}

const latest = (steps: Step[]) => steps.reduce<Step | null>((b, s) => (!b || s.end >= b.end ? s : b), null);

/** The latest trailing-twelve-month value of a flow (no publication lag — for "today"), with its period end. */
export function latestFlow(f: CompanyFundamentals, m: Flow): { value: number; end: string } | null {
  return latest(flowSteps(f, m));
}

/** The latest reported balance-sheet value, shares on today's split basis. */
export function latestStock(f: CompanyFundamentals, m: Stock): { value: number; end: string } | null {
  return latest(stockSteps(f, m));
}

const ratio = (num: number | null, den: number | null) => (num == null || den == null || den <= 0 || num <= 0 ? null : num / den);

/** One point per trading day from the first published statement on. */
export function valuationSeries(f: CompanyFundamentals, closes: { date: string; close: number }[]): ValuationPoint[] {
  const flows = Object.fromEntries(FLOWS.map((m) => [m, flowSteps(f, m)])) as Record<Flow, Step[]>;
  const shares = stockSteps(f, 'shares'), cash = stockSteps(f, 'cash'), debt = stockSteps(f, 'totalDebt');
  const first = [...Object.values(flows).flat(), ...shares].map((s) => s.from).sort()[0];
  if (!first) return [];
  const out: ValuationPoint[] = [];
  for (const c of closes) {
    if (c.date < first) continue;
    const n = asOf(shares, c.date);
    const cap = n != null && n > 0 ? c.close * n : null;
    const cs = asOf(cash, c.date), dt = asOf(debt, c.date);
    const ev = cap != null && cs != null && dt != null ? cap + dt - cs : null;
    out.push({
      date: c.date,
      pe: ratio(cap, asOf(flows.netIncome, c.date)),
      ps: ratio(cap, asOf(flows.revenue, c.date)),
      pfcf: ratio(cap, asOf(flows.fcf, c.date)),
      evEbitda: ratio(ev, asOf(flows.ebitda, c.date)),
    });
  }
  return out;
}

/** Median of the non-null values of one multiple — a "typical" level to compare today with. */
export function medianOf(points: ValuationPoint[], m: Multiple): number | null {
  const v = points.map((p) => p[m]).filter((x): x is number => x != null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
