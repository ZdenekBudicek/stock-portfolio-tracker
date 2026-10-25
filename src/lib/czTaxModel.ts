import { isRealTradeTx, runFifo } from "@/lib/fifo";
import { usdCzkFor } from "@/lib/cnbRates";
import { buildSalesReport, limitStateOf, overallTaxState } from "@/lib/czTax";
import type { AssetKindResolver, TaxSettings, SalesYearReport, LimitState, OverallTaxState } from "@/lib/czTax";
import { exemptionCalendar, exemptSummary, lotStatuses } from "@/lib/taxLots";
import { createKindResolver, type InstrumentRegistry } from "@/lib/instrumentRegistry";
import type { DbTransaction, LivePosition } from "@/lib/portfolioTypes";
import type { CalculationCache } from "./calculationCache";

export interface CzTaxInput {
  transactions: DbTransaction[];
  positions: LivePosition[];
  registry: InstrumentRegistry;
  year: number;
  today: string;
  usdCzk: number;
  settings: TaxSettings;
}

export interface CzTaxModel {
  fifo: ReturnType<typeof runFifo>;
  report: SalesYearReport;
  kindOf: AssetKindResolver;
  lots: ReturnType<typeof lotStatuses>;
  allLots: ReturnType<typeof lotStatuses>;
  calendar: ReturnType<typeof exemptionCalendar>;
  summary: ReturnType<typeof exemptSummary>;
  today: string;
  settings: TaxSettings;
  overLimit: boolean;
  limitState: LimitState;
  cryptoLimitState: LimitState | 'none';
  overallState: OverallTaxState;
}

export function computeCzTaxModel(input: CzTaxInput, cache?: CalculationCache): CzTaxModel {
  const { transactions, positions, registry, year, today, usdCzk, settings } = input;
  const fifo = cache ? cache.fifo(transactions, 'real') : runFifo(transactions.filter(isRealTradeTx));
  const kindOf = createKindResolver(registry);
  const report = buildSalesReport(fifo.disposals, year, settings, fifo.warnings, kindOf);
  const price = new Map(positions.map(p => [p.ticker, p.currentPrice]));
  const allLots = lotStatuses(fifo.openLots, t => price.get(t) ?? null, today,
    { rate: usdCzk, fxAt: d => usdCzkFor(d, settings.fxMethod)?.rate ?? null });
  // Unheld or unpriceable lots remain in FIFO, but not in the holdings summary.
  const lots = allLots.filter(l => l.valueUsd != null);
  const calendar = exemptionCalendar(lots);
  const summary = exemptSummary(lots);
  return { fifo, report, kindOf, lots, allLots, calendar, summary, today, settings,
    overLimit: limitStateOf(report.securities) === 'over' || limitStateOf(report.crypto) === 'over',
    limitState: limitStateOf(report.securities),
    cryptoLimitState: report.crypto.limitApplies ? limitStateOf(report.crypto) : 'none',
    overallState: overallTaxState(report) };
}
