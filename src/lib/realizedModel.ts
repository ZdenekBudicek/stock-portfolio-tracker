import { isRealTradeTx, runFifo } from "@/lib/fifo";
import { buildRealizedReport, realizedYears, type RealizedYear } from "@/lib/tax/realized";
import type { DbTransaction } from "@/lib/portfolioTypes";
import type { DividendRecord } from "@/lib/dividendTax";
import type { BaseCurrency } from "@/lib/tax/jurisdictions";
import type { CalculationCache } from "./calculationCache";

export interface RealizedInput {
  transactions: DbTransaction[];
  dividends: DividendRecord[];
  year: number;
  currency: BaseCurrency;
  today: string;
}

export interface RealizedModel {
  fifo: ReturnType<typeof runFifo>;
  report: RealizedYear;
  years: number[];
  currency: BaseCurrency;
}

export function computeRealized(input: RealizedInput, cache?: CalculationCache): RealizedModel {
  const { transactions, dividends, year, currency, today } = input;
  const fifo = cache ? cache.fifo(transactions, 'real') : runFifo(transactions.filter(isRealTradeTx));
  const report = buildRealizedReport(fifo.disposals, fifo.warnings, dividends, year, currency, today);
  const years = realizedYears(fifo.disposals, dividends, today);
  return { fifo, report, years, currency };
}
