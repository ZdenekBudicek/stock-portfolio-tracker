import { describe, expect, it } from 'vitest';
import { bucketOf, proceedsBreakdown } from '@/lib/taxBreakdown';

const row = (ticker: string, proceedsCzk: number | null, gainCzk: number | null, exempt = false) =>
  ({ ticker, proceedsCzk, gainCzk, exempt }) as never;

describe('proceedsBreakdown', () => {
  it('puts every sold lot in exactly one bucket and adds up to the total proceeds', () => {
    const b = proceedsBreakdown({
      rows: [row('AMD', 100_000, 40_000), row('AMD', 50_000, -10_000), row('NU', 30_000, -5_000), row('KO', 20_000, 8_000, true), row('X', null, null)],
      unmatched: [{ ticker: 'Y', proceedsCzk: 5_000 } as never],
    });
    expect(b.buckets.gain).toEqual({ lots: 1, proceedsCzk: 100_000, resultCzk: 40_000 });
    expect(b.buckets.loss).toEqual({ lots: 2, proceedsCzk: 80_000, resultCzk: -15_000 });
    expect(b.buckets.exempt).toEqual({ lots: 1, proceedsCzk: 20_000, resultCzk: 8_000 });
    expect(b.buckets.unknown.lots).toBe(2);
    expect(b.totalCzk).toBe(205_000);
    expect(b.byTicker[0]).toMatchObject({ ticker: 'AMD', lots: 2, proceedsCzk: 150_000, resultCzk: 30_000, lossLots: 1 });
    expect(b.byTicker[0].share).toBeCloseTo(150_000 / 205_000);
  });

  it('a loss on a lot past the time test stays exempt (it does not lower the tax)', () => {
    expect(bucketOf(row('KO', 10_000, -2_000, true))).toBe('exempt');
  });
});
