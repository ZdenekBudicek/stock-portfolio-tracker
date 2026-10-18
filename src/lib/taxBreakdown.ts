// What a year's sale proceeds are made of — for the "where does the limit come from" panel on
// the Taxes screen. Every sold lot falls into exactly one bucket:
//   exempt   — passed the 3-year time test (tax-free, still counts as proceeds)
//   gain     — taxable, sold above cost
//   loss     — taxable, sold below cost (the loss lowers the tax base of the same year)
//   unknown  — a rate or the purchase is missing, the result cannot be computed
// plus sells the ledger has no purchase for (unmatched): their proceeds count, their result is unknown.
import type { SalesYearReport, TaxedDisposal } from '@/lib/czTax';

export type Bucket = 'gain' | 'loss' | 'exempt' | 'unknown';
export interface BucketTotals { lots: number; proceedsCzk: number; resultCzk: number }
export interface TickerTotals { ticker: string; lots: number; proceedsCzk: number; resultCzk: number; lossLots: number; exemptLots: number; share: number }
export interface ProceedsBreakdown {
  totalCzk: number;
  buckets: Record<Bucket, BucketTotals>;
  byTicker: TickerTotals[];
}

export const bucketOf = (r: Pick<TaxedDisposal, 'exempt' | 'gainCzk' | 'proceedsCzk'>): Bucket =>
  r.proceedsCzk == null || r.gainCzk == null ? 'unknown' : r.exempt ? 'exempt' : r.gainCzk < 0 ? 'loss' : 'gain';

export function proceedsBreakdown(report: Pick<SalesYearReport, 'rows' | 'unmatched'>): ProceedsBreakdown {
  const empty = (): BucketTotals => ({ lots: 0, proceedsCzk: 0, resultCzk: 0 });
  const buckets: Record<Bucket, BucketTotals> = { gain: empty(), loss: empty(), exempt: empty(), unknown: empty() };
  const by = new Map<string, TickerTotals>();
  const tick = (t: string) => {
    let x = by.get(t);
    if (!x) by.set(t, (x = { ticker: t, lots: 0, proceedsCzk: 0, resultCzk: 0, lossLots: 0, exemptLots: 0, share: 0 }));
    return x;
  };
  for (const r of report.rows) {
    const b = bucketOf(r);
    const p = r.proceedsCzk ?? 0, g = r.gainCzk ?? 0;
    buckets[b].lots++; buckets[b].proceedsCzk += p; buckets[b].resultCzk += g;
    const x = tick(r.ticker);
    x.lots++; x.proceedsCzk += p; x.resultCzk += g;
    if (b === 'loss') x.lossLots++;
    if (b === 'exempt') x.exemptLots++;
  }
  for (const u of report.unmatched ?? []) {
    buckets.unknown.lots++; buckets.unknown.proceedsCzk += u.proceedsCzk ?? 0;
    const x = tick(u.ticker);
    x.lots++; x.proceedsCzk += u.proceedsCzk ?? 0;
  }
  const totalCzk = Object.values(buckets).reduce((a, b) => a + b.proceedsCzk, 0);
  const byTicker = [...by.values()]
    .map((x) => ({ ...x, share: totalCzk > 0 ? x.proceedsCzk / totalCzk : 0 }))
    .sort((a, b) => b.proceedsCzk - a.proceedsCzk);
  return { totalCzk, buckets, byTicker };
}
