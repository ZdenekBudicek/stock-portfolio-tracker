/** Last rate on or before the date, with a six-day carry limit; missing history is NaN. */
export function makeRateLookup(rows: { date: string; close: number | string }[], maxAgeDays = 6): (date: string) => number {
  const pts = rows.map((r) => ({ d: r.date, v: Number(r.close) })).filter((r) => Number.isFinite(r.v) && r.v > 0).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!pts.length) return () => NaN;
  return (date: string) => {
    if (!Number.isFinite(Date.parse(date))) return NaN;
    let lo = 0, hi = pts.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].d <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0 || (Date.parse(date) - Date.parse(pts[best].d)) / 86400000 > maxAgeDays) return NaN;
    return pts[best].v;
  };
}

import cnb from "@/data/cnbRates.json";
const rates = cnb.rates as Record<string, Record<string, number>>;
const lookups = new Map<string, (date: string) => number>();
export function datedCzkPer(currency: string, date: string): number {
  if (currency === "CZK") return 1;
  if (currency === "GBX") return datedCzkPer("GBP", date) / 100;
  if (!lookups.has(currency)) lookups.set(currency, makeRateLookup(Object.entries(rates).map(([date, r]) => ({ date, close: r[currency] }))));
  return lookups.get(currency)!(date);
}

export function datedUsd(amount: number, currency: string | undefined, date: string): number {
  if (currency === "USD") return amount;
  if (!currency) return NaN;
  return amount * datedCzkPer(currency, date) / datedCzkPer("USD", date);
}
