// Range presets and growth figures for the enlarged company-financials chart. Periods are
// matched by their end dates (fiscal years and quarters drift by a few days), never by index,
// so a gap in the statements cannot turn "a year ago" into some other period.

export type ChartRange = '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | 'ALL';
export const CHART_RANGES: readonly ChartRange[] = ['1Y', '2Y', '3Y', '5Y', '10Y', 'ALL'];
const RANGE_YEARS: Record<Exclude<ChartRange, 'ALL'>, number> = { '1Y': 1, '2Y': 2, '3Y': 3, '5Y': 5, '10Y': 10 };

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
/** Fiscal periods end a few days apart from year to year (52/53-week years). */
const SLACK = 45 * DAY;

/** Index of the first period inside the last `range` (counted back from the newest period end). */
export function rangeStartIndex(ends: string[], range: ChartRange): number {
  if (range === 'ALL' || ends.length === 0) return 0;
  const cutoff = Date.parse(ends[ends.length - 1]) - RANGE_YEARS[range] * YEAR + SLACK;
  const i = ends.findIndex((e) => Date.parse(e) > cutoff);
  return i < 0 ? ends.length - 1 : i;
}

/** Presets that actually narrow the chart: at least two periods, but not all of them. ALL always. */
export function usableRanges(ends: string[]): Set<ChartRange> {
  const out = new Set<ChartRange>(['ALL']);
  for (const r of CHART_RANGES) {
    if (r === 'ALL') continue;
    const n = ends.length - rangeStartIndex(ends, r);
    if (n >= 2 && n < ends.length) out.add(r);
  }
  return out;
}

/** The preset that selects exactly [start, end] (end = newest period), if any. */
export function rangeFor(ends: string[], start: number, end: number): ChartRange | null {
  if (ends.length === 0) return null;
  if (start === 0 && end === ends.length - 1) return 'ALL';
  if (end !== ends.length - 1) return null;
  const usable = usableRanges(ends);
  return CHART_RANGES.find((r) => r !== 'ALL' && usable.has(r) && rangeStartIndex(ends, r) === start) ?? null;
}

export interface Growth {
  years: number;
  /** Period ends of the compared values (older, newer). */
  from: string;
  to: string;
  /** Total change; null when either value is zero or negative (a percentage would mislead). */
  growth: number | null;
  /** Compound annual growth rate; null under the same condition. */
  cagr: number | null;
  /** Plain difference — used for percentages (margins), where it reads as percentage points. */
  diff: number;
}

/**
 * Growth of the newest reported value against the period ending N years earlier, for each
 * horizon the history reaches. Horizons without a matching period are left out.
 */
export function growthStats(ends: string[], values: (number | null)[], horizons: readonly number[] = [1, 2, 3, 5, 10]): Growth[] {
  let i = values.length - 1;
  while (i >= 0 && values[i] == null) i--;
  if (i < 0) return [];
  const v = values[i]!;
  const last = Date.parse(ends[i]);
  const out: Growth[] = [];
  for (const years of horizons) {
    const target = last - years * YEAR;
    let best = -1;
    for (let j = 0; j < i; j++) {
      if (values[j] == null) continue;
      const d = Math.abs(Date.parse(ends[j]) - target);
      if (d <= SLACK && (best < 0 || d < Math.abs(Date.parse(ends[best]) - target))) best = j;
    }
    if (best < 0) continue;
    const p = values[best]!;
    const ok = p > 0 && v > 0;
    out.push({
      years, from: ends[best], to: ends[i],
      growth: ok ? v / p - 1 : null,
      cagr: ok ? Math.pow(v / p, 1 / years) - 1 : null,
      diff: v - p,
    });
  }
  return out;
}
