import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { analyticsDividend, analyticsFixture, analyticsSnapshot } from '@/test/agentAnalyticsFixture';
import { usePerformanceSeries } from '@/hooks/usePerformanceSeries';
import { computePerformanceModel, summarizePerformance } from '@/lib/performanceModel';

const state = vi.hoisted(() => ({ input: null as ReturnType<typeof analyticsFixture> }));
vi.mock('@/hooks/usePortfolio', async () => ({
  computeTradeFlows: (await import('@/lib/portfolioModel')).computeTradeFlows,
  useDailySnapshots: () => ({ data: state.input.snapshots }),
  useComputedPortfolio: () => state.input.portfolio,
  useTransactions: () => ({ data: state.input.transactions }),
}));
vi.mock('@/hooks/useExtras', () => ({ useBenchmark: () => ({ data: state.input.benchmark }),
  useDividends: () => ({ data: state.input.dividends }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('performance characterization', () => {
  it.each(['USD', 'CZK', 'EUR', 'GBP', 'PLN'] as const)('preserves original %s hook output', currency => {
    state.input = analyticsFixture();
    state.input.snapshots = state.input.snapshots.map(s => ({ ...s, displayCurrency: currency === 'USD' ? 'EUR' : currency }));
    vi.useFakeTimers(); vi.setSystemTime(new Date(`${state.input.today}T12:00:00Z`));
    const { result } = renderHook(() => usePerformanceSeries(currency));
    expect(result.current).toMatchSnapshot();
    expect(computePerformanceModel({ ...state.input, currency })).toEqual(result.current);
    expect(result.current.points).toHaveLength(2);
    expect(result.current.points.map(p => p.total)).toEqual(currency === 'USD' ? [120, 130] : [96, 117]);
  });
});

describe('shared performance model', () => {
  it('returns ratios, money and dates; empty benchmark stays null', () => {
    const input = analyticsFixture();
    input.snapshots = [analyticsSnapshot('2026-10-22', 100, 0)];
    input.portfolio.positions = [input.portfolio.positions[0]];
    input.portfolio.totalValue = 110;
    const model = computePerformanceModel({ ...input, benchmark: [], currency: 'USD' });
    const summary = summarizePerformance(model, { from: '2026-10-22', to: input.today });
    expect(summary.portfolioReturn).toBeCloseTo(0.1, 14);
    expect(summary.profit).toBe(10);
    expect(summary.from).toBe('2026-10-22');
    expect(summary.to).toBe(input.today);
    expect(summary.annualReturn).toBeNull();
    expect(summary.benchmarkReturn).toBeNull();
    expect(summary.benchmarkAnnualReturn).toBeNull();
    expect(model.hasBench).toBe(false);
  });

  it('received dividends increasing cash are income, not deposits', () => {
    const input = analyticsFixture();
    input.snapshots = [analyticsSnapshot('2026-10-22', 100, 20)];
    input.portfolio.positions[0].value = 100;
    input.portfolio.positions[1].value = 25;
    input.portfolio.totalValue = 125;
    const model = computePerformanceModel({ ...input, currency: 'USD', dividends: [
      analyticsDividend({ pay_date: input.today, total_amount_usd: 5 }),
      analyticsDividend({ id: 'auto', pay_date: input.today, total_amount_usd: 5, broker: 'auto' }),
    ] });
    expect(model.points.map(p => p.cumDep)).toEqual([20, 20]);
    expect(summarizePerformance(model, { from: '2026-10-22', to: input.today }).portfolioReturn).toBeCloseTo(5 / 120);
  });

  it('keeps unknown historical cash unknown and reports gaps', () => {
    const input = analyticsFixture();
    input.snapshots = [analyticsSnapshot('2026-10-01', 100, null)];
    const model = computePerformanceModel({ ...input, currency: 'USD' });
    expect(model.points[0].total).toBe(100);
    expect(model.quality.cashTrackedFrom).toBe(input.today);
    expect(model.quality.reasons).toContain('cash-untracked-period');
    expect(model.quality.reasons).toContain('gaps');
  });

  it('uses historical EUR rates and never applies current FX twice', () => {
    const model = computePerformanceModel({ ...analyticsFixture(), currency: 'EUR' });
    expect(model.points.map(p => p.total)).toEqual([96, 117]);
    expect(summarizePerformance(model, { from: '2026-10-22', to: '2026-10-23' }).portfolioReturn).toBeCloseTo(117 / 96 - 1);
  });

  it('keeps the actual base date, annualization and bounded end date', () => {
    const model = { points: [{ date: '2024-01-01', total: 100, cumDep: 100, benchVal: 100 },
      { date: '2025-01-01', total: 110, cumDep: 100, benchVal: 120 },
      { date: '2026-01-01', total: 999, cumDep: 100, benchVal: 999 }],
    holdingsUsd: 999, cashUsd: 0, hasBench: true,
    quality: { level: 'estimated' as const, reasons: ['proxy-flows'], extremeDays: [], cashTrackedFrom: '2024-01-01' } };
    const result = summarizePerformance(model, { from: '2024-06-01', to: '2025-01-01' });
    expect(result.from).toBe('2024-01-01');
    expect(result.to).toBe('2025-01-01');
    expect(result.profit).toBe(10);
    expect(result.portfolioReturn).toBeCloseTo(0.1);
    expect(result.benchmarkReturn).toBeCloseTo(0.2);
    expect(result.annualReturn).toBeCloseTo(Math.pow(1.1, 365.25 / 366) - 1);
    expect(result.benchmarkAnnualReturn).toBeCloseTo(Math.pow(1.2, 365.25 / 366) - 1);
  });

  it('does not invent zero returns from empty or single-point history', () => {
    const model = computePerformanceModel({ ...analyticsFixture(), currency: 'USD' });
    for (const points of [[], model.points.slice(0, 1)]) {
      const result = summarizePerformance({ ...model, points }, { from: '2026-10-22', to: '2026-10-23' });
      expect(result.portfolioReturn).toBeNull();
      expect(result.profit).toBeNull();
    }
  });
});
