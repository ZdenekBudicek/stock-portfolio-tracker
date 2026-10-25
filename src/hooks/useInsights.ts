// Shared derived models for the V2 screens. Each one is computed once per data change and
// reused by every card that shows it, so the same number never differs between screens.
import { useMemo } from "react";
import { useComputedPortfolio, useLivePrices, useTransactions } from "@/hooks/usePortfolio";
import { useDividends, useEarnings, useWatchlist } from "@/hooks/useExtras";
import { addDays, DEFAULT_TAX_SETTINGS, limitStateOf, overallTaxState, pragueDate, summarizeSalesYear, type TaxSettings } from "@/lib/czTax";
import { computeCzTaxModel } from "@/lib/czTaxModel";
import { computeDividendModel } from "@/lib/dividendModel";
import { deriveAlerts } from "@/lib/alerts";
import { useJurisdiction } from "@/hooks/useTaxResidence";
import { useInstrumentRegistry } from "@/hooks/useAssetKinds";

export const todayPrague = () => pragueDate(new Date().toISOString());

export { limitStateOf, overallTaxState, type LimitState, type OverallTaxState } from "@/lib/czTax";

export function useTaxModel(year = Number(todayPrague().slice(0, 4)), settings: TaxSettings = DEFAULT_TAX_SETTINGS) {
  const txsQ = useTransactions();
  const portfolio = useComputedPortfolio();
  const registryQ = useInstrumentRegistry();
  const today = todayPrague();
  const model = useMemo(() => computeCzTaxModel({ transactions: txsQ.data ?? [], positions: portfolio.positions,
    registry: registryQ.registry, year, today, usdCzk: portfolio.usdCzk, settings }),
  [txsQ.data, portfolio.positions, registryQ.registry, year, today, portfolio.usdCzk, settings]);
  const loading = txsQ.isLoading || portfolio.loading || registryQ.loading;
  const error = txsQ.error || registryQ.error || portfolio.error || null;
  // Missing query data cannot confirm an exemption. Keep partial rows and warnings,
  // using the engine's existing incomplete-data path for all dependent totals.
  const report = loading || error ? summarizeSalesYear(year, model.report.rows, model.report.unmatched,
    settings, model.report.missingFx, true) : model.report;
  return { ...model, report, loading, error,
    overLimit: limitStateOf(report.securities) === 'over' || limitStateOf(report.crypto) === 'over',
    limitState: limitStateOf(report.securities),
    cryptoLimitState: report.crypto.limitApplies ? limitStateOf(report.crypto) : 'none' as const,
    overallState: overallTaxState(report) };
}

export function useDividendModel() {
  const { data: divs = [] } = useDividends();
  const { positions } = useComputedPortfolio();
  const today = todayPrague();
  return useMemo(() => computeDividendModel({ dividends: divs, positions, today }), [divs, positions, today]);
}

export const MOVE_THRESHOLD_PCT = 7;
export const EARNINGS_DAYS_AHEAD = 3;

export function useAlerts() {
  const p = useComputedPortfolio();
  const live = useLivePrices();
  const { data: watch = [] } = useWatchlist();
  const { data: earnings = [] } = useEarnings();
  const tax = useTaxModel();
  const { caps } = useJurisdiction();
  const today = tax.today;
  return useMemo(() => {
    const prices = live.data?.prices ?? {};
    const held = new Set(p.positions.filter((x) => x.ticker !== "CASH").map((x) => x.ticker));
    const monthAgo = addDays(today, -30);
    return deriveAlerts({
      today,
      positions: p.positions.filter((x) => x.ticker !== "CASH").map((x) => ({
        ticker: x.ticker, name: x.name, dailyChangePct: x.dailyChangePct, dailyChangeUsd: x.dailyChangeUsd,
        allocation: x.allocation, hasPrevClose: !!prices[x.ticker]?.prevClose,
      })),
      moveThresholdPct: MOVE_THRESHOLD_PCT,
      watch,
      priceOf: (t) => prices[t]?.price ?? null,
      tax: { year: tax.report.year, overLimit: tax.overLimit, complete: tax.report.complete, proceedsCzk: tax.report.proceedsCzk, estTaxCzk: tax.report.estTaxCzk },
      earnings,
      earningsDaysAhead: EARNINGS_DAYS_AHEAD,
      held,
      newlyExempt: tax.lots.filter((l) => l.exempt && l.exemptFrom > monthAgo).map((l) => ({ ticker: l.ticker, exemptFrom: l.exemptFrom, valueUsd: l.valueUsd })),
      pricesStale: !!p.stale,
      pricesError: p.error ? String((p.error as { message?: string })?.message ?? p.error) : null,
      caps,
    });
  }, [p.positions, p.stale, p.error, live.data, watch, earnings, tax, today, caps]);
}
