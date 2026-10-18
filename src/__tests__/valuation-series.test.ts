import { describe, expect, it } from 'vitest';
import { medianOf, splitFactors, splitFactorsByDate, valuationSeries } from '@/lib/valuationSeries';
import type { CompanyFundamentals, FundamentalSeries } from '@/types/fundamentals';

const series = (periods: string[], values: Record<string, (number | null)[]>): FundamentalSeries =>
  ({ periods, values: values as FundamentalSeries['values'] });
const empty = series([], {});
const base = (annual: FundamentalSeries, quarterly = empty): CompanyFundamentals =>
  ({ symbol: 'X', currency: 'USD', fetchedAt: '2026-01-01T00:00:00Z', status: 'ok', annual, quarterly });

describe('valuationSeries', () => {
  it('scales share counts before a 10:1 split to today\'s basis', () => {
    expect(splitFactors(series(['2022-12-31', '2023-12-31', '2024-12-31'], { sharesOutstanding: [100, 101, 1010] }))).toEqual([10, 10, 1]);
  });

  it('puts annual and quarterly share counts on one split basis', () => {
    const f = base(
      series(['2024-12-31'], { sharesOutstanding: [100] }),
      series(['2025-03-31', '2025-06-30'], { sharesOutstanding: [100, 1000] }),
    );
    const m = splitFactorsByDate(f);
    expect(m.get('2024-12-31')).toBe(10);
    expect(m.get('2025-06-30')).toBe(1);
    // Annual figures still in use after the split: P/E stays on the split-adjusted basis.
    const g = base(series(['2024-12-31'], { netIncome: [100], sharesOutstanding: [100] }), series(['2025-06-30'], { sharesOutstanding: [1000] }));
    const [p] = valuationSeries(g, [{ date: '2025-09-01', close: 10 }]);
    expect(p.pe).toBe(100); // 10 × 1000 / 100, not 10
  });

  it('uses an annual report only 90 days after year end and computes the multiples', () => {
    const f = base(series(['2024-12-31'], {
      revenue: [1000], netIncome: [100], freeCashFlow: [50], ebitda: [200], sharesOutstanding: [10], cash: [100], totalDebt: [300],
    }));
    const pts = valuationSeries(f, [{ date: '2025-02-15', close: 20 }, { date: '2025-04-01', close: 20 }]);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({ date: '2025-04-01', pe: 2, ps: 0.2, pfcf: 4, evEbitda: 2 });
  });

  it('leaves multiples on losses or negative cash flow out', () => {
    const f = base(series(['2024-12-31'], { revenue: [1000], netIncome: [-5], freeCashFlow: [-1], sharesOutstanding: [10] }));
    const [p] = valuationSeries(f, [{ date: '2025-06-01', close: 20 }]);
    expect(p.pe).toBeNull();
    expect(p.pfcf).toBeNull();
    expect(p.ps).toBe(0.2);
  });

  it('prefers four published quarters, per metric, and falls back to the annual figure', () => {
    const f = base(
      series(['2024-12-31'], { revenue: [400], netIncome: [40], sharesOutstanding: [10] }),
      series(['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'], {
        revenue: [150, 150, 150, 150], netIncome: [20, null, 20, 20], sharesOutstanding: [10, 10, 10, 10],
      }),
    );
    const [p] = valuationSeries(f, [{ date: '2026-03-01', close: 10 }]);
    expect(p.ps).toBeCloseTo(100 / 600); // quarterly TTM revenue
    expect(p.pe).toBe(2.5); // a quarter lacks net income → annual 40
    expect(medianOf([p, { ...p, pe: 1.5 }], 'pe')).toBe(2);
  });
});
