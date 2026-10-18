// The "Vývoj portfolia" series (positions + recorded cash, money in, the same money in the
// S&P 500) in a given currency — shared by the chart and the Výnosy screen so both read the
// very same points.
import { useMemo } from 'react';
import { computeTradeFlows, useComputedPortfolio, useDailySnapshots, useTransactions } from '@/hooks/usePortfolio';
import { useBenchmark, useDividends } from '@/hooks/useExtras';
import { paidDividendsByDay } from '@/lib/dividendAnalytics';
import { buildPerformanceSeries, type SeriesPoint } from '@/lib/performanceSeries';
import { assessReturnQuality, type ReturnQuality } from '@/lib/performanceQuality';

export function usePerformanceSeries(currency: 'USD' | 'CZK'): { points: SeriesPoint[]; holdingsUsd: number; cashUsd: number; hasBench: boolean; quality: ReturnQuality } {
  const { data: snapshots = [] } = useDailySnapshots();
  const portfolio = useComputedPortfolio();
  const { data: bench = [] } = useBenchmark('SPX');
  const { data: transactions = [] } = useTransactions();
  const { data: dividends = [] } = useDividends();

  const cashUsd = portfolio.positions.find((p) => p.ticker === 'CASH')?.value ?? 0;
  const holdingsUsd = portfolio.totalValue - cashUsd;

  const sorted = useMemo(() => {
    const data = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const today = new Date().toISOString().slice(0, 10);
    // Live point = today's holdings from the same `positions` table the stored snapshots are
    // reconstructed against, so the curve joins the live value without a step.
    if (Number.isFinite(holdingsUsd) && holdingsUsd > 0) {
      const last = data[data.length - 1];
      const livePoint = {
        ...(last ?? { value_czk: 0, profit_usd: 0, profit_pct: 0, profit_czk: 0 }),
        snapshot_date: today,
        value_usd: holdingsUsd,
        value_czk: holdingsUsd * portfolio.usdCzk,
        fx_rate: portfolio.usdCzk,
        cash_usd: cashUsd, // today's balance is known exactly — no estimate needed
      };
      if (!last || last.snapshot_date < today) data.push(livePoint as any);
      else if (last.snapshot_date === today) data[data.length - 1] = livePoint as any;
    }
    return data;
  }, [snapshots, holdingsUsd, cashUsd, portfolio.usdCzk]);

  const benchSorted = useMemo(() => [...bench].sort((a, b) => a.date.localeCompare(b.date)), [bench]);
  const tradeFlows = useMemo(() => computeTradeFlows(transactions as any), [transactions]);
  const income = useMemo(() => paidDividendsByDay(dividends as any), [dividends]);

  const points = useMemo(() => {
    const benchAt = (date: string): number | null => {
      if (benchSorted.length === 0) return null;
      let lo = 0, hi = benchSorted.length - 1, best: number | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (benchSorted[mid].date <= date) { best = benchSorted[mid].close_value; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    };
    const rates = new Map(sorted.map((s) => [s.snapshot_date, s.fx_rate]));
    return buildPerformanceSeries({ snapshots: sorted, tradeFlowsUsd: tradeFlows, incomeUsd: income, benchAt, currency, fallbackFx: portfolio.usdCzk, fxAt: (date) => rates.get(date) });
  }, [sorted, tradeFlows, income, benchSorted, currency, portfolio.usdCzk]);

  const quality = useMemo(() => assessReturnQuality(points, {
    cashTrackedFrom: sorted.find((s) => s.cash_usd != null)?.snapshot_date ?? null,
  }), [points, sorted]);

  return { points, holdingsUsd, cashUsd, hasBench: points.some((p) => p.benchVal != null), quality };
}
