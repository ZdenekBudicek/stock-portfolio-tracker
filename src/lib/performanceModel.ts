import { computeTradeFlows, type ComputedPortfolio } from './portfolioModel';
import { paidDividendsByDay } from './dividendAnalytics';
import { buildPerformanceSeries, type SeriesPoint } from './performanceSeries';
import { assessReturnQuality, type ReturnQuality } from './performanceQuality';
import { baseIndex, chain, dailyReturns } from './returns';
import type { DisplayCurrency } from './displayCurrency';
import type { DbTransaction, DisplaySnapshot } from './portfolioTypes';
import type { DividendRecord } from './dividendTax';

export interface PerformanceInput {
  snapshots: DisplaySnapshot[];
  portfolio: ComputedPortfolio;
  transactions: DbTransaction[];
  dividends: DividendRecord[];
  benchmark: { date: string; close_value: number }[];
  currency: DisplayCurrency;
  today: string;
}
export interface PerformanceModel {
  points: SeriesPoint[];
  holdingsUsd: number;
  cashUsd: number;
  hasBench: boolean;
  quality: ReturnQuality;
}
export interface PerformanceSummary {
  portfolioReturn: number | null;
  benchmarkReturn: number | null;
  annualReturn: number | null;
  benchmarkAnnualReturn: number | null;
  profit: number | null;
  from: string;
  to: string;
  years: number;
  quality: ReturnQuality;
}

export function computePerformanceModel({ snapshots, portfolio, transactions, dividends, benchmark, currency, today }: PerformanceInput): PerformanceModel {
  const cashUsd = portfolio.positions.find((p) => p.ticker === 'CASH')?.value ?? 0;
  const holdingsUsd = portfolio.totalValue - cashUsd;

  const sorted = (() => {
    const data = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    // Live point = today's holdings from the same `positions` table the stored snapshots are
    // reconstructed against, so the curve joins the live value without a step.
    if (Number.isFinite(holdingsUsd) && holdingsUsd > 0) {
      const last = data[data.length - 1];
      const livePoint = {
        ...(last ?? { value_czk: 0, profit_usd: 0, profit_pct: 0, profit_czk: 0 }),
        snapshot_date: today,
        value_usd: holdingsUsd,
        // Snapshots are in the local currency (koruny or the chosen one): today's USD→local.
        value_czk: holdingsUsd * portfolio.usdLocal,
        fx_rate: portfolio.usdLocal,
        cash_usd: cashUsd, // today's balance is known exactly — no estimate needed
      };
      if (!last || last.snapshot_date < today) data.push(livePoint as DisplaySnapshot);
      else if (last.snapshot_date === today) data[data.length - 1] = livePoint as DisplaySnapshot;
    }
    return data;
  })();

  const benchSorted = [...benchmark].sort((a, b) => a.date.localeCompare(b.date));
  const tradeFlows = computeTradeFlows(transactions);
  const income = paidDividendsByDay(dividends);

  const points = (() => {
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
    return buildPerformanceSeries({ snapshots: sorted, tradeFlowsUsd: tradeFlows, incomeUsd: income, benchAt, currency, fallbackFx: portfolio.usdLocal, fxAt: (date) => rates.get(date) });
  })();

  const quality = assessReturnQuality(points, {
    cashTrackedFrom: sorted.find((s) => s.cash_usd != null)?.snapshot_date ?? null,
  });

  return { points, holdingsUsd, cashUsd, hasBench: points.some((p) => p.benchVal != null), quality };
}

export function summarizePerformance(model: PerformanceModel, period: { from: string; to: string }): PerformanceSummary {
  const points = model.points.filter(p => p.date <= period.to);
  const empty = { portfolioReturn: null, benchmarkReturn: null, annualReturn: null, benchmarkAnnualReturn: null,
    profit: null, from: points[0]?.date ?? period.from, to: points[points.length - 1]?.date ?? period.to, years: 0, quality: model.quality };
  if (points.length < 2 || period.from > period.to) return empty;
  // Keep Returns' actual base close for both the money and the chained return.
  const startIdx = baseIndex(points, period.from);
  const a = points[startIdx], b = points[points.length - 1];
  const inRange = (d: string) => d > a.date;
  const portfolioReturn = chain(dailyReturns(points).filter(d => inRange(d.date)).map(d => d.r));
  const bench = points.filter(x => x.benchVal != null).map(x => ({ date: x.date, total: x.benchVal!, cumDep: x.cumDep }));
  const benchmarkReturn = bench.length > 1 ? chain(dailyReturns(bench).filter(d => inRange(d.date)).map(d => d.r)) : null;
  const years = Math.max(1 / 365, (Date.parse(b.date) - Date.parse(a.date)) / (365.25 * 86400000));
  return { portfolioReturn, benchmarkReturn,
    annualReturn: years >= 1 ? Math.pow(1 + portfolioReturn, 1 / years) - 1 : null,
    benchmarkAnnualReturn: benchmarkReturn != null && years >= 1 ? Math.pow(1 + benchmarkReturn, 1 / years) - 1 : null,
    profit: (b.total - a.total) - (b.cumDep - a.cumDep), from: a.date, to: b.date, years, quality: model.quality };
}
