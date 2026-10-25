import { describe, expect, it } from 'vitest';
import { keyStats } from '@/lib/keyStats';
import type { CompanyFundamentals, FundamentalSeries } from '@/types/fundamentals';

const series = (periods: string[], values: Record<string, (number | null)[]>): FundamentalSeries =>
  ({ periods, values: values as FundamentalSeries['values'] });
const empty = series([], {});
const base = (annual: FundamentalSeries, quarterly = empty, currency = 'USD'): CompanyFundamentals =>
  ({ symbol: 'X', currency, fetchedAt: '2026-01-01T00:00:00Z', status: 'ok', annual, quarterly });

const annual = series(['2025-12-31'], {
  revenue: [1000], netIncome: [100], freeCashFlow: [50], ebitda: [200], sharesOutstanding: [10],
  cash: [100], totalDebt: [300], equity: [400], dividendsPaid: [-20],
});

describe('keyStats', () => {
  it('prices the latest statements at the live price', () => {
    const s = keyStats(base(annual), 20);
    expect(s).toMatchObject({
      marketCap: 200, ev: 400, pe: 2, ps: 0.2, pb: 0.5, pfcf: 4, evEbitda: 2, divYield: 0.1,
      eps: 10, netMargin: 0.1, roe: 0.25, debtToEquity: 0.75, netCash: -200, sharesAsOf: '2025-12-31',
    });
    // P/E is exactly price / EPS.
    expect(20 / s.eps!).toBe(s.pe);
    // Follows the price: double the price, double the cap and the multiples.
    expect(keyStats(base(annual), 40)).toMatchObject({ marketCap: 400, pe: 4 });
  });

  it('uses four fresh quarters over an older fiscal year, without a publication lag', () => {
    const q = series(['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31'], {
      netIncome: [10, 10, 10, 30], revenue: [100, 100, 100, 100], sharesOutstanding: [20, 20, 20, 20],
    });
    const s = keyStats(base(annual, q), 10);
    expect(s.ttmAsOf).toBe('2026-12-31');
    expect(s.marketCap).toBe(200);
    expect(s.pe).toBe(200 / 60);
  });

  it('leaves multiples on losses out and gives no price-based figures for other currencies', () => {
    const loss = series(['2025-12-31'], { revenue: [1000], netIncome: [-5], sharesOutstanding: [10], equity: [100] });
    const s = keyStats(base(loss), 20);
    expect(s.pe).toBeNull();
    expect(s.ps).toBe(0.2);
    expect(s.roe).toBe(-0.05);
    expect(s.divYield).toBeNull();
    const twd = keyStats(base(annual, empty, 'TWD'), 20);
    expect(twd).toMatchObject({ priced: false, marketCap: null, pe: null, netMargin: 0.1, eps: 10 });
  });
});
