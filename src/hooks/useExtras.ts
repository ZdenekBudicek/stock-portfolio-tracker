import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const PAGE_SIZE = 1000;

async function fetchAllRows<T>(buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
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

/* ───────── Splits ───────── */
export interface DbSplit {
  id: string;
  ticker: string;
  split_date: string;
  ratio: number;
  status: "pending" | "applied" | "dismissed";
  source: string;
  detected_price: number | null;
  prev_close: number | null;
  applied_at: string | null;
}

export function useSplits(status?: DbSplit["status"]) {
  return useQuery({
    queryKey: ["splits", status ?? "all"],
    queryFn: async () => {
      let q = supabase.from("splits").select("*").order("split_date", { ascending: false });
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data as any[]).map((s) => ({ ...s, ratio: Number(s.ratio) })) as DbSplit[];
    },
  });
}

export function useApplySplit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("apply_split" as any, { split_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["splits"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}

export function useDismissSplit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("dismiss_split" as any, { split_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["splits"] }),
  });
}

export function useAddSplitManual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ticker: string; split_date: string; ratio: number }) => {
      const { data, error } = await supabase
        .from("splits")
        .insert({ ...input, status: "pending", source: "manual" })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["splits"] }),
  });
}

/* ───────── Watchlist ───────── */
export interface DbWatch {
  id: string;
  ticker: string;
  name: string;
  target_price_usd: number | null;
  note: string | null;
}

export function useWatchlist() {
  return useQuery({
    queryKey: ["watchlist"],
    queryFn: async () => {
      const { data, error } = await supabase.from("watchlist").select("*").order("ticker");
      if (error) throw error;
      return (data as any[]).map((w) => ({
        ...w,
        target_price_usd: w.target_price_usd != null ? Number(w.target_price_usd) : null,
      })) as DbWatch[];
    },
  });
}

export function useAddWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ticker: string; name: string; target_price_usd?: number | null; note?: string | null }) => {
      const { error } = await supabase.from("watchlist").insert(input);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
  });
}

export function useRemoveWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("watchlist").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
  });
}

/* ───────── Goals ───────── */
export interface DbGoal {
  id: string;
  name: string;
  target_amount_usd: number;
  target_date: string | null;
  is_active: boolean;
}

export function useGoals() {
  return useQuery({
    queryKey: ["goals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("portfolio_goals")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as any[]).map((g) => ({ ...g, target_amount_usd: Number(g.target_amount_usd) })) as DbGoal[];
    },
  });
}

export function useUpsertGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (g: { id?: string; name: string; target_amount_usd: number; target_date: string | null }) => {
      if (g.id) {
        const { error } = await supabase
          .from("portfolio_goals")
          .update({ name: g.name, target_amount_usd: g.target_amount_usd, target_date: g.target_date })
          .eq("id", g.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("portfolio_goals").insert({
          name: g.name,
          target_amount_usd: g.target_amount_usd,
          target_date: g.target_date,
          is_active: true,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goals"] }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("portfolio_goals").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goals"] }),
  });
}

/* ───────── Dividends ───────── */
export interface DbDividend {
  id: string;
  ticker: string;
  ex_date: string;
  pay_date: string | null;
  amount_per_share: number;
  shares_held: number | null;
  total_amount_usd: number | null;
  status: "upcoming" | "paid";
}

export function useDividends() {
  return useQuery({
    queryKey: ["dividends"],
    queryFn: async () => {
      const { data, error } = await supabase.from("dividends").select("*").order("ex_date", { ascending: false });
      if (error) throw error;
      return (data as any[]).map((d) => ({
        ...d,
        amount_per_share: Number(d.amount_per_share),
        shares_held: d.shares_held != null ? Number(d.shares_held) : null,
        total_amount_usd: d.total_amount_usd != null ? Number(d.total_amount_usd) : null,
      })) as DbDividend[];
    },
  });
}

export function useUpsertDividend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (d: Omit<DbDividend, "id"> & { id?: string }) => {
      if (d.id) {
        const { error } = await supabase.from("dividends").update(d).eq("id", d.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("dividends").insert(d);
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dividends"] }),
  });
}

export function useDeleteDividend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("dividends").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dividends"] }),
  });
}

/* ───────── Earnings ───────── */
export interface DbEarning {
  id: string;
  ticker: string;
  earnings_date: string;
  time_of_day: string | null;
  eps_estimate: number | null;
  eps_actual: number | null;
}

export function useEarnings() {
  return useQuery({
    queryKey: ["earnings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("earnings_calendar")
        .select("*")
        .gte("earnings_date", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
        .order("earnings_date", { ascending: true });
      if (error) throw error;
      return data as DbEarning[];
    },
  });
}

/* ───────── Benchmark history ───────── */
export interface DbBench {
  symbol: string;
  date: string;
  close_value: number;
}

export function useBenchmark(symbol = "SPX") {
  return useQuery({
    queryKey: ["benchmark", symbol],
    queryFn: async () => {
      const data = await fetchAllRows<any>((from, to) =>
        supabase
          .from("benchmark_history")
          .select("symbol,date,close_value")
          .eq("symbol", symbol)
          .order("date", { ascending: true })
          .range(from, to),
      );
      return (data as any[]).map((r) => ({ ...r, close_value: Number(r.close_value) })) as DbBench[];
    },
  });
}

/* ───────── Broker account summary (authoritative value/P&L/deposits) ───────── */
export interface BrokerSummary {
  currency: string | null;
  total: number;     // total account value (account currency)
  free: number;      // free cash
  invested: number;  // cost basis of open positions
  ppl: number;       // unrealised P&L on open positions
  result: number;    // lifetime realised P&L
  netDepositsUsd: number | null; // combined net deposits across all brokers, in USD (if known)
}

export function useBrokerSummary(broker = "T212") {
  return useQuery({
    queryKey: ["broker-summary", broker],
    queryFn: async (): Promise<BrokerSummary | null> => {
      // Read via the security-definer RPC (broker_connections has RLS with no direct
      // select policy, and we must never expose the encrypted API key to the client).
      const { data, error } = await supabase.rpc("get_broker_connection_status" as any);
      if (error) throw error;
      // EXACT broker match only. Falling back to the first connection handed one broker's
      // account summary out under another broker's name — and the caller then swapped that
      // broker's net-invested capital in for a proxy that was never counted, double-counting
      // it in the net-deposits total.
      const row = (data as any[])?.find((r) => r.broker === broker);
      const s = row?.account_summary;
      if (!s) return null;
      return {
        currency: s.currency ?? null,
        total: Number(s.total) || 0,
        free: Number(s.free) || 0,
        invested: Number(s.invested) || 0,
        ppl: Number(s.ppl) || 0,
        result: Number(s.result) || 0,
        netDepositsUsd: s.total_net_deposits_usd != null ? Number(s.total_net_deposits_usd) : null,
      };
    },
  });
}

/* ───────── Stock news (Yahoo headlines, translated to Czech) ───────── */
export interface StockNewsItem { en: string; cs: string; sumEn?: string; sumCs?: string; publisher: string; url: string; ts: number | null; }
export function useStockNews(symbol: string) {
  return useQuery({
    queryKey: ["stock-news", symbol],
    enabled: !!symbol,
    queryFn: async (): Promise<{ items: StockNewsItem[]; fetchedAt: string } | null> => {
      const { data, error } = await (supabase as any)
        .from("stock_news").select("items,fetched_at").eq("symbol", symbol).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { items: (data.items as StockNewsItem[]) ?? [], fetchedAt: data.fetched_at };
    },
    staleTime: 30 * 60 * 1000,
  });
}

/* ───────── Deposits (dated external cash flows per broker) ───────── */
export interface DbDeposit {
  broker: string | null;
  flow_date: string;
  amount_usd: number;
  source: string | null;
}

export function useDeposits() {
  return useQuery({
    queryKey: ["deposits"],
    queryFn: async (): Promise<DbDeposit[]> => {
      const { data, error } = await supabase.from("deposits").select("broker,flow_date,amount_usd,source");
      if (error) throw error;
      return (data as any[]).map((d) => ({ ...d, amount_usd: Number(d.amount_usd) }));
    },
  });
}

/* ───────── Quick Buy/Sell ───────── */
export function useAddTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      ticker: string;
      side: "BUY" | "SELL";
      shares: number;
      price_usd: number;
      fee_usd?: number;
      executed_at: string;
      note?: string | null;
      // For new positions we may need to create the position row first
      name?: string;
      type?: string;
      sector?: string | null;
    }) => {
      const ticker = input.ticker.toUpperCase().trim();

      // If a custom name/sector is provided for a brand new ticker, pre-create the position
      // so the DB trigger can fill the rest. Otherwise the trigger creates a default row.
      if (ticker !== "CASH" && (input.name || input.sector || input.type)) {
        const { data: existing } = await supabase
          .from("positions")
          .select("id")
          .eq("ticker", ticker)
          .maybeSingle();
        if (!existing && input.side === "BUY") {
          const { data: userData } = await supabase.auth.getUser();
          const uid = userData.user?.id;
          if (uid) {
            await supabase.from("positions").insert({
              ticker,
              name: input.name || ticker,
              type: input.type || "Stock",
              sector: input.sector ?? null,
              shares: 0,
              avg_cost_usd: 0,
              user_id: uid,
            });
          }
        }
      }


      // Insert the transaction. DB triggers will:
      //   1) update the CASH balance (trg_update_cash_on_transaction)
      //   2) update the position shares & weighted avg cost (trg_update_position_on_transaction)
      const { error } = await supabase.from("transactions").insert({
        ticker,
        side: input.side,
        shares: input.shares,
        price_usd: input.price_usd,
        fee_usd: input.fee_usd ?? 0,
        executed_at: input.executed_at,
        note: input.note ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["live-prices"] });
    },
  });
}
