// Neutral realized-gains model (users whose tax rules the app does not implement).
import { useMemo } from "react";
import { useTransactions } from "@/hooks/usePortfolio";
import { useDividends } from "@/hooks/useExtras";
import { useTaxResidence } from "@/hooks/useTaxResidence";
import { isRealTradeTx, runFifo } from "@/lib/fifo";
import { buildRealizedReport, realizedYears } from "@/lib/tax/realized";

export function useRealizedModel(year = new Date().getFullYear()) {
  const { data: txs = [] } = useTransactions();
  const { data: divs = [] } = useDividends();
  const { baseCurrency } = useTaxResidence();
  const fifo = useMemo(() => runFifo(txs.filter(isRealTradeTx) as any), [txs]);
  const report = useMemo(() => buildRealizedReport(fifo.disposals, fifo.warnings, divs as any, year, baseCurrency), [fifo, divs, year, baseCurrency]);
  const years = useMemo(() => realizedYears(fifo.disposals, divs as any), [fifo, divs]);
  return { fifo, report, years, currency: baseCurrency };
}
