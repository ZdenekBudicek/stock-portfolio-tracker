// Shared derived models for the V2 screens. Each one is computed once per data change and
// reused by every card that shows it, so the same number never differs between screens.
import { useMemo } from "react";
import { useComputedPortfolio, useLivePrices, useTransactions } from "@/hooks/usePortfolio";
import { useDividends, useEarnings, useWatchlist } from "@/hooks/useExtras";
import { isRealTradeTx, runFifo } from "@/lib/fifo";
import { usdCzkFor } from "@/lib/cnbRates";
import { addDays, buildSalesReport, DEFAULT_TAX_SETTINGS, limitStateOf, overallTaxState, pragueDate, type TaxSettings } from "@/lib/czTax";
import { exemptionCalendar, exemptSummary, lotStatuses } from "@/lib/taxLots";
import { annualByTicker, dividendForecast, receivedLast12m, remainingThisMonth } from "@/lib/dividendAnalytics";
import { deriveAlerts } from "@/lib/alerts";
import { useJurisdiction } from "@/hooks/useTaxResidence";
import { useAssetKindResolver } from "@/hooks/useAssetKinds";

export const todayPrague = () => pragueDate(new Date().toISOString());

export { limitStateOf, overallTaxState, type LimitState, type OverallTaxState } from "@/lib/czTax";

export function useTaxModel(year = Number(todayPrague().slice(0, 4)), settings: TaxSettings = DEFAULT_TAX_SETTINGS) {
  const { data: txs = [] } = useTransactions();
  const { positions, usdCzk } = useComputedPortfolio();
  const today = todayPrague();
  const fifo = useMemo(() => runFifo(txs.filter(isRealTradeTx) as any), [txs]);
  // Crypto has its own rules; the kind comes from the whole instrument registry (sold
  // positions included), the same resolver the full tax report uses.
  const kindOf = useAssetKindResolver();
  const report = useMemo(
    () => buildSalesReport(fifo.disposals, year, settings, fifo.warnings, kindOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fifo, year, settings.fxMethod, settings.limitIncludesExempt, kindOf],
  );
  const priceKey = positions.map((p) => `${p.ticker}:${p.currentPrice}`).join("|");
  const lots = useMemo(() => {
    const price = new Map(positions.map((p) => [p.ticker, p.currentPrice]));
    return lotStatuses(fifo.openLots, (t) => price.get(t) ?? null, today, { rate: usdCzk, fxAt: (d) => usdCzkFor(d, settings.fxMethod)?.rate ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fifo, priceKey, today, usdCzk, settings.fxMethod]);
  // Lots of tickers no longer held (no live position, e.g. a sale at an unimported broker)
  // stay in the FIFO for the tax report, but are not shown as "your" exempt holdings.
  const heldLots = useMemo(() => lots.filter((l) => l.valueUsd != null), [lots]);
  const calendar = useMemo(() => exemptionCalendar(heldLots), [heldLots]);
  const summary = useMemo(() => exemptSummary(heldLots), [heldLots]);
  return { fifo, report, kindOf, lots: heldLots, allLots: lots, calendar, summary, today, settings,
    /** Securities or crypto proceeds over their own 100 000 Kč limit. */
    overLimit: limitStateOf(report.securities) === 'over' || limitStateOf(report.crypto) === 'over',
    /** Securities limit: over / confirmed under / cannot tell (incomplete data under the limit). */
    limitState: limitStateOf(report.securities),
    /** Crypto's own limit; 'none' when crypto has no exemption that year (or no sales). */
    cryptoLimitState: report.crypto.limitApplies ? limitStateOf(report.crypto) : 'none' as const,
    /** Every kind together — what a summary card shows. */
    overallState: overallTaxState(report) };
}

export function useDividendModel() {
  const { data: divs = [] } = useDividends();
  const { positions } = useComputedPortfolio();
  const today = todayPrague();
  const held = useMemo(() => new Set(positions.filter((p) => p.ticker !== "CASH").map((p) => p.ticker.toUpperCase().split(".")[0])), [positions]);
  return useMemo(() => {
    const forecast = dividendForecast(divs, today, held);
    const rest = remainingThisMonth(divs, today, held);
    const annual = annualByTicker(forecast, rest);
    const annualTotal = [...annual.values()].reduce((s, v) => s + v, 0);
    const received = receivedLast12m(divs, today);
    const next = [...rest, ...forecast.flatMap((m) => m.items)][0] ?? null;
    return { forecast, rest, annual, annualTotal, received, next, today };
  }, [divs, today, held]);
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
      pricesError: p.error ? String((p.error as any)?.message ?? p.error) : null,
      caps,
    });
  }, [p.positions, p.stale, p.error, live.data, watch, earnings, tax, today, caps]);
}
