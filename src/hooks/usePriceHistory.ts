import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/hooks/usePortfolio";

export interface PricePoint { date: string; close: number; }

/** Daily closes (USD, split-adjusted) of one symbol from the shared price_history table. */
export function usePriceHistory(symbol: string) {
  return useQuery({
    queryKey: ["price-history", symbol],
    enabled: !!symbol,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<PricePoint[]> => {
      const rows = await fetchAllRows<any>((from, to) =>
        (supabase as any).from("price_history").select("date,close").eq("symbol", symbol).order("date", { ascending: true }).range(from, to),
      );
      return rows.map((r) => ({ date: String(r.date).slice(0, 10), close: Number(r.close) })).filter((r) => r.close > 0);
    },
  });
}
