// Neutral realized-gains model (users whose tax rules the app does not implement).
import { useMemo } from "react";
import { useTransactions } from "@/hooks/usePortfolio";
import { useDividends } from "@/hooks/useExtras";
import { useTaxResidence } from "@/hooks/useTaxResidence";
import { computeRealized } from "@/lib/realizedModel";

export function useRealizedModel(year = new Date().getFullYear()) {
  const txsQ = useTransactions();
  const divsQ = useDividends();
  const { baseCurrency } = useTaxResidence();
  const today = new Date().toISOString().slice(0, 10);
  const model = useMemo(() => computeRealized({ transactions: txsQ.data ?? [], dividends: divsQ.data ?? [],
    year, currency: baseCurrency, today }), [txsQ.data, divsQ.data, year, baseCurrency, today]);
  const loading = txsQ.isLoading || divsQ.isLoading;
  const error = txsQ.error || divsQ.error || null;
  const report = loading || error ? { ...model.report, complete: false } : model.report;
  return { ...model, report, loading, error };
}
