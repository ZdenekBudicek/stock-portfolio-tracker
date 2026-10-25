// Shared by the portfolio chart and Returns, with the original UTC live-point date.
import { useMemo } from 'react';
import { useComputedPortfolio, useDailySnapshots, useTransactions } from '@/hooks/usePortfolio';
import { useBenchmark, useDividends } from '@/hooks/useExtras';
import { computePerformanceModel } from '@/lib/performanceModel';
import type { DisplayCurrency } from '@/lib/displayCurrency';

export function usePerformanceSeries(currency: DisplayCurrency) {
  const { data: snapshots = [] } = useDailySnapshots();
  const portfolio = useComputedPortfolio();
  const { data: benchmark = [] } = useBenchmark('SPX');
  const { data: transactions = [] } = useTransactions();
  const { data: dividends = [] } = useDividends();
  const today = new Date().toISOString().slice(0, 10);
  return useMemo(() => computePerformanceModel({ snapshots, portfolio, transactions, dividends, benchmark, currency, today }),
    [snapshots, portfolio, transactions, dividends, benchmark, currency, today]);
}
