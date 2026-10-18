/**
 * Rate on `date` = the last rate published on or before it (binary search over rows sorted
 * by date); a date before the series starts takes the FIRST rate, never the latest.
 */
export function makeRateLookup(rows: { date: string; close: number | string }[], fallback = 22): (date: string) => number {
  const pts = rows.map((r) => ({ d: r.date, v: Number(r.close) })).filter((r) => r.v > 0).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!pts.length) return () => fallback;
  return (date: string) => {
    let lo = 0, hi = pts.length - 1, best = pts[0].v;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].d <= date) { best = pts[mid].v; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };
}
