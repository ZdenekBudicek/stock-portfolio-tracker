import bundled from "@/data/cnbRates.json";
import type { FxProvider, FxQuote, TaxCurrency } from "./types";

export interface CnbTable { rates: Record<string, { USD: number; EUR: number; GBP: number; PLN: number }> }
/** All legs use ONE published date. No interpolation or stale future weekday fallback. */
export function createCnbFx(table: CnbTable): FxProvider {
  const dates = Object.keys(table.rates).sort();
  return (date: string, currency: TaxCurrency): FxQuote | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return null;
    if (currency === "USD") return { rate: 1, ref: date, source: "USD", statutory: true };
    let lo = 0, hi = dates.length - 1, idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >>> 1;
      if (dates[m] <= date) { idx = m; lo = m + 1; } else hi = m - 1;
    }
    if (idx < 0) return null;
    const ref = dates[idx], elapsed = (Date.parse(date) - Date.parse(ref)) / 86400000;
    if (elapsed > 6 || elapsed < 0) return null;
    if (date > dates[dates.length - 1]) {
      for (let n = 1; n <= elapsed; n++) {
        const weekday = new Date(Date.parse(ref) + n * 86400000).getUTCDay();
        if (weekday !== 0 && weekday !== 6) return null;
      }
    }
    const row = table.rates[ref];
    if (!(row.USD > 0) || !(row[currency] > 0)) return null;
    const rate = row.USD / row[currency];
    return Number.isFinite(rate) && rate > 0 ? { rate, ref, source: "CNB-cross", statutory: false } : null;
  };
}
export const cnbTaxFx = createCnbFx(bundled as CnbTable);
