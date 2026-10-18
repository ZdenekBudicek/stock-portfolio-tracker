// Time-weighted returns from the "Vývoj portfolia" series (lib/performanceSeries).
//
// Convention: money moved in on a day counts at the end of that day,
//     r_d = (V_d − F_d) / V_(d−1) − 1,   F_d = cumDep_d − cumDep_(d−1)
// and periods chain geometrically, ∏(1 + r_d) − 1. A deposit at flat prices is 0 %; selling a
// position into tracked cash moves nothing.
//
// The flows are the series' own money-in (cash change + what was spent on stock), i.e. a
// proxy for the real external deposits — which is why the UI labels these returns as
// approximate. Days with no base value are skipped rather than read as −100 %.

export interface FlowPoint {
  date: string; // YYYY-MM-DD
  total: number;
  cumDep: number;
}

export interface DailyReturn { date: string; r: number; flow: number; }

export function dailyReturns(points: FlowPoint[]): DailyReturn[] {
  const out: DailyReturn[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], cur = points[i];
    const flow = cur.cumDep - prev.cumDep;
    if (!(prev.total > 0)) continue;
    out.push({ date: cur.date, r: (cur.total - flow) / prev.total - 1, flow });
  }
  return out;
}

export const chain = (rs: number[]): number => rs.reduce((acc, r) => acc * (1 + r), 1) - 1;

export interface PeriodReturn {
  key: string; // YYYY-MM or YYYY
  r: number;
  /** The period's first or last day is missing from the series (it started or ends inside it). */
  partial: boolean;
}

/** Geometric return per calendar month. A month is chained from the last close of the previous one. */
export function monthlyReturns(points: FlowPoint[]): PeriodReturn[] {
  const daily = dailyReturns(points);
  const groups = new Map<string, number[]>();
  for (const d of daily) {
    const k = d.date.slice(0, 7);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(d.r);
  }
  const first = points[0]?.date.slice(0, 7);
  const last = points[points.length - 1]?.date;
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => ({
    key, r: chain(rs),
    partial: key === first || (!!last && key === last.slice(0, 7) && !isMonthEnd(last)),
  }));
}

/** Year = product of its months. */
export function yearlyReturns(months: PeriodReturn[]): PeriodReturn[] {
  const groups = new Map<string, PeriodReturn[]>();
  for (const m of months) {
    const k = m.key.slice(0, 4);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, ms]) => ({
    key, r: chain(ms.map((m) => m.r)),
    partial: ms.length < 12 || ms.some((m) => m.partial),
  }));
}

/** TWR between two dates (inclusive of the end day's return). */
export function twrBetween(points: FlowPoint[], from: string, to: string): number | null {
  const rs = dailyReturns(points).filter((d) => d.date > from && d.date <= to).map((d) => d.r);
  return rs.length ? chain(rs) : null;
}

/** Net money in per calendar month (positive = in, negative = out). */
export function monthlyNetFlows(points: FlowPoint[]): Map<string, number> {
  // Straight from the cumulative money-in, the first point's own amount included — returns
  // skip days without a base value, flows must not.
  const m = new Map<string, number>();
  let prev = 0;
  for (const p of points) {
    const flow = p.cumDep - prev;
    prev = p.cumDep;
    if (flow !== 0) m.set(p.date.slice(0, 7), (m.get(p.date.slice(0, 7)) ?? 0) + flow);
  }
  return m;
}

/** Index of the last point on or before `date` (0 when none) — the base of a period. */
export function baseIndex(points: FlowPoint[], date: string): number {
  let idx = 0;
  for (let i = 0; i < points.length; i++) { if (points[i].date <= date) idx = i; else break; }
  return idx;
}

function isMonthEnd(date: string): boolean {
  const [y, mo, d] = date.split("-").map(Number);
  return d === new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
