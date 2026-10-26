// Shared by the portfolio chart and Returns, with the original UTC live-point date.
import { useMemo } from 'react';
import { useComputedPortfolio, useDailySnapshots, useTransactions } from '@/hooks/usePortfolio';
import { useBenchmark, useDividends } from '@/hooks/useExtras';
import { computePerformanceModel } from '@/lib/performanceModel';
import type { DisplayCurrency } from '@/lib/displayCurrency';

// One empty list for data not loaded yet: a fresh `[]` on every render would recompute the series each time, and the
// chart, which sets its window stats from a new series, would render again for ever (it starved route changes).
const NONE: never[] = [];

export function usePerformanceSeries(currency: DisplayCurrency) {
  const snapshots = useDailySnapshots().data ?? NONE;
  const portfolio = useComputedPortfolio();
  const benchmark = useBenchmark('SPX').data ?? NONE;
  const transactions = useTransactions().data ?? NONE;
  const dividends = useDividends().data ?? NONE;
  const today = new Date().toISOString().slice(0, 10);
  // The model reads three figures of the portfolio, which is a new object on every render: keyed by those figures.
  const cashUsd = portfolio.positions.find(p => p.ticker === 'CASH')?.value ?? 0;
  return useMemo(() => computePerformanceModel({ snapshots, portfolio, transactions, dividends, benchmark, currency, today }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- portfolio enters through totalValue, usdLocal and cash only
    [snapshots, portfolio.totalValue, portfolio.usdLocal, cashUsd, transactions, dividends, benchmark, currency, today]);
}
