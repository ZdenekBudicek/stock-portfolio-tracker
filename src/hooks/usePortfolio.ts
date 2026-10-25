import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBrokerSummary, useDividends, useDeposits } from "@/hooks/useExtras";
import { useAuth } from "@/contexts/AuthContext";
import { useLocalFxOptional } from "@/contexts/CurrencyContext";
import { computePortfolio } from "@/lib/portfolioModel";
import { toDisplaySnapshots } from "@/lib/snapshotFx";
import type { DbPosition, DbTransaction, DbSnapshot, RawSnapshot, LivePrices } from "@/lib/portfolioTypes";
export type { DbPosition, DbTransaction, DbSnapshot, LivePrices, LivePosition } from "@/lib/portfolioTypes";
export { computeHoldingCostFifo, computeTradeFlows, isCashPosition, summarizeHoldings } from "@/lib/portfolioModel";

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchLivePrices(): Promise<LivePrices> {
  const { data, error } = await supabase.functions.invoke("get-live-prices", { method: "POST" });
  if (error) throw error;
  return data as LivePrices;
}

export function useLivePrices() {
  // Prices are scoped to the signed-in user (their positions + watchlist), so the cache is
  // keyed by user and nothing is fetched before sign-in — an anonymous answer is empty and
  // would otherwise be served to the dashboard for the next five minutes.
  const { user } = useAuth();
  return useQuery({
    queryKey: ["live-prices", user?.id ?? null],
    enabled: !!user,
    queryFn: fetchLivePrices,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: REFRESH_MS - 1000,
  });
}
type DbTransactionRow = Omit<DbTransaction, "side"> & { side: string };
type DbSnapshotRow = DbSnapshot;

export function usePositions() {
  return useQuery({
    queryKey: ["positions"],
    queryFn: async (): Promise<DbPosition[]> => {
      const { data, error } = await supabase.from("positions").select("*").order("ticker");
      if (error) throw error;
      return (data ?? []).map((p) => ({
        id: p.id,
        ticker: p.ticker,
        name: p.name,
        type: p.type,
        sector: p.sector,
        shares: Number(p.shares),
        avg_cost_usd: Number(p.avg_cost_usd),
        holding_start_date: p.holding_start_date ?? null,
      }));
    },
  });
}

export function useTransactions() {
  return useQuery({
    queryKey: ["transactions"],
    queryFn: async (): Promise<DbTransaction[]> => {
      const data = await fetchAllRows<DbTransactionRow>((from, to) =>
        supabase
          .from("transactions")
          .select("*")
          .order("executed_at", { ascending: false })
          // Tie-breaker: without a unique sort key, rows sharing a timestamp (all T212
          // statement trades sit at 12:00:00Z) can repeat or vanish across page boundaries.
          .order("id", { ascending: true })
          .range(from, to),
      );
      return data.map((t) => ({
        ...t,
        side: t.side === "SELL" ? "SELL" : "BUY",
        shares: Number(t.shares),
        price_usd: Number(t.price_usd),
        fee_usd: Number(t.fee_usd),
      }));
    },
  });
}

/**
 * Daily snapshots with their koruna fields (value_czk, profit_czk, fx_rate) expressed in the
 * LOCAL display currency — each day converted at the ČNB rate of that same day, so every
 * history, chart and month comparison follows the chosen currency (CZK: unchanged).
 */
export function useDailySnapshots() {
  const fx = useLocalFxOptional();
  const select = useCallback((rows: RawSnapshot[]) => toDisplaySnapshots(rows, fx), [fx]);
  return useQuery({
    select,
    queryKey: ["daily-snapshots"],
    queryFn: async (): Promise<RawSnapshot[]> => {
      const data = await fetchAllRows<DbSnapshotRow>((from, to) =>
        supabase
          .from("daily_snapshots")
          .select("snapshot_date,value_usd,value_czk,profit_usd,profit_pct,profit_czk,fx_rate,cash_usd")
          .order("snapshot_date", { ascending: true })
          .range(from, to),
      );
      return data.map((s) => ({
        ...s,
        fxBasis: "raw-czk",
        value_usd: Number(s.value_usd),
        value_czk: Number(s.value_czk),
        profit_usd: Number(s.profit_usd),
        profit_pct: Number(s.profit_pct),
        profit_czk: Number(s.profit_czk),
        fx_rate: s.fx_rate != null ? Number(s.fx_rate) : null,
        cash_usd: s.cash_usd != null ? Number(s.cash_usd) : null,
      }));
    },
  });
}

export function useComputedPortfolio() {
  const positionsQ = usePositions();
  const pricesQ = useLivePrices();
  const txsQ = useTransactions();
  const snapsQ = useDailySnapshots();
  const summaryQ = useBrokerSummary("T212");
  const divsQ = useDividends();
  const depositsQ = useDeposits();

  // Every figure below needs all of these: the trades for the cost basis and Vloženo, the
  // snapshots for the purchase-day FX, the broker summary for T212's deposits. Reporting
  // "ready" on positions + prices alone let the header show a number and then jump.
  const loading = positionsQ.isLoading || pricesQ.isLoading || txsQ.isLoading || snapsQ.isLoading || summaryQ.isLoading || divsQ.isLoading || depositsQ.isLoading;

  const fx = useLocalFxOptional();
  const computed = computePortfolio({
    positions: positionsQ.data || [], prices: pricesQ.data?.prices || {}, transactions: txsQ.data || [],
    snapshots: snapsQ.data || [], t212Summary: summaryQ.data ?? null, dividends: divsQ.data || [],
    deposits: depositsQ.data ?? [], usdCzk: pricesQ.data?.usdCzk > 0 ? pricesQ.data.usdCzk : NaN, fx,
  });
  return {
    ...computed,
    loading,
    stale: !!(pricesQ.data?.stale || pricesQ.error || pricesQ.data?.error),
    fetchedAt: pricesQ.data?.fetchedAt,
    error: positionsQ.error || txsQ.error || snapsQ.error || summaryQ.error || divsQ.error || depositsQ.error || (!loading && !(pricesQ.data?.usdCzk > 0) ? new Error("USD/CZK unavailable") : null),
  };
}
