import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBrokerSummary, useDividends } from "@/hooks/useExtras";
import { useAuth } from "@/contexts/AuthContext";
import { computeNetDeposits } from "@/lib/netDeposits";
import { runFifo, realizedUsd, isRealTradeTx } from "@/lib/fifo";
import { useLocalFxOptional } from "@/contexts/CurrencyContext";

export interface LivePrices {
  prices: Record<string, { price: number; changePct: number; prevClose: number | null }>;
  usdCzk: number;
  /** Today's CZK per 1 EUR / GBP / PLN (display currencies), when the price job has them. */
  fxCzk?: Partial<Record<"EUR" | "GBP" | "PLN", number>>;
  fetchedAt: string;
  stale: boolean;
  error: string | null;
}

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

export interface DbPosition {
  id: string;
  ticker: string;
  name: string;
  type: string;
  shares: number;
  avg_cost_usd: number;
  sector: string | null;
  holding_start_date: string | null;
}

export interface DbTransaction {
  id: string;
  ticker: string;
  side: "BUY" | "SELL";
  shares: number;
  price_usd: number;
  fee_usd: number;
  executed_at: string;
  note: string | null;
  /** Present on every imported row; `:adj:`/`:pos:` mark synthetic (non-trade) rows. */
  ext_id?: string | null;
  broker?: string | null;
  broker_account?: string | null;
}

export interface DbSnapshot {
  snapshot_date: string;
  value_usd: number;
  value_czk: number;
  profit_usd: number;
  profit_pct: number;
  profit_czk: number;
  /** USD/CZK of that day — value_czk = value_usd × fx_rate. */
  fx_rate?: number | null;
  /** Recorded cash balance; null on days before cash tracking began. */
  cash_usd?: number | null;
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
  const select = useCallback((rows: DbSnapshot[]): DbSnapshot[] => {
    if (fx.code === "CZK") return rows;
    return rows.map((s) => {
      const k = fx.perCzkAt(s.snapshot_date);
      return { ...s, value_czk: s.value_czk * k, profit_czk: s.profit_czk * k, fx_rate: s.fx_rate != null ? s.fx_rate * k : null };
    });
  }, [fx]);
  return useQuery({
    select,
    queryKey: ["daily-snapshots"],
    queryFn: async (): Promise<DbSnapshot[]> => {
      const data = await fetchAllRows<DbSnapshotRow>((from, to) =>
        supabase
          .from("daily_snapshots")
          .select("snapshot_date,value_usd,value_czk,profit_usd,profit_pct,profit_czk,fx_rate,cash_usd")
          .order("snapshot_date", { ascending: true })
          .range(from, to),
      );
      return data.map((s) => ({
        ...s,
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

/**
 * Total realized profit/loss across all sells — the shared FIFO (src/lib/fifo.ts) over real
 * trades, so the header, the closed positions and the tax report report the same number.
 * Shares sold without a matching lot are left out (their cost is unknown), not counted as
 * pure profit.
 */
function computeRealizedFifo(txs: DbTransaction[]): number {
  return realizedUsd(runFifo(txs.filter(isRealTradeTx)));
}

/**
 * FIFO cost basis of the shares STILL HELD per ticker (sells consume the oldest lots,
 * so what remains is the most recent buys). This is the correct cost of the current
 * holding — a plain weighted average over all buys is wrong once some have been sold,
 * and it also lets us ignore synthetic :adj:/:pos: reconcile rows (which carry $0 cost
 * and would otherwise dilute the average and inflate profit%). Returns remaining
 * shares + their total cost per ticker.
 */
export function computeHoldingCostFifo(
  txs: DbTransaction[],
  fxAt?: (date: string) => number,
): Map<string, { shares: number; cost: number; costCzk: number }> {
  // The shared FIFO keeps lots per ticker AND broker ACCOUNT: each account's sells consume
  // only that account's lots. The same ticker held at two brokers — or at two accounts of
  // one broker — has independent cost bases (matching what each broker's own app shows);
  // they're summed for the combined holding.
  //
  // Reconciliation rows (:adj:) are INCLUDED. They are genuine share corrections priced at
  // the broker's own average, and `positions.shares` counts them — excluding them computed
  // the cost basis over a DIFFERENT set of shares than the quantity shown beside it, so
  // "investováno" and profit % came out wrong for every reconciled ticker.
  const out = new Map<string, { shares: number; cost: number; costCzk: number }>();
  for (const lot of runFifo(txs).openLots) {
    const cost = lot.shares * (lot.priceUsd + lot.feePerShareUsd);
    const cur = out.get(lot.ticker) ?? { shares: 0, cost: 0, costCzk: 0 };
    cur.shares += lot.shares;
    cur.cost += cost;
    cur.costCzk += cost * (fxAt ? fxAt(lot.acquiredAt.slice(0, 10)) : 1);
    out.set(lot.ticker, cur);
  }
  return out;
}

/**
 * Money moved INTO the positions per date, in USD: a BUY adds, a SELL takes out, both at
 * the trade price. Synthetic rows (`:adj:` reconciliations, `:pos:` holdings snapshots) and
 * CASH movements are excluded — they are not purchases.
 *
 * This is the baseline the portfolio chart measures against. It is derived purely from the
 * trade ledger, so unlike the deposits table it is complete for every broker, and because a
 * sale lowers both the holdings value and this baseline by the same amount, selling a
 * position can never look like a loss.
 */
export function computeTradeFlows(txs: DbTransaction[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of txs) {
    if (t.ticker === "CASH") continue;
    const ext = String(t.ext_id ?? "");
    if (ext.includes(":adj:") || ext.includes(":pos:")) continue;
    const day = t.executed_at.slice(0, 10);
    // Merger cash: a 0-share SELL with the amount in price_usd (see lib/fifo).
    const qtyValue = ext.includes(":mergercash:") ? Math.abs(t.price_usd) * (t.shares > 0 ? t.shares : 1) : t.shares * t.price_usd;
    const usd = (t.side === "BUY" ? 1 : -1) * qtyValue;
    if (!Number.isFinite(usd)) continue;
    m.set(day, (m.get(day) ?? 0) + usd);
  }
  return m;
}

/** Computed live position derived from DB position + live price */
export interface LivePosition {
  ticker: string;
  name: string;
  type: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  invested: number;
  value: number;
  profitUsd: number;
  profitPct: number;          // USD return (matches USD-account brokers, e.g. Revolut)
  // The same position in CZK: cost at the USD/CZK of each purchase, value at today's rate.
  // The CZK return therefore includes the currency move — what a CZK-account broker (T212)
  // shows. Amount, % and colour in CZK mode must all come from these, never USD × today.
  avgPriceCzk: number;
  investedCzk: number;
  valueCzk: number;
  profitCzk: number;
  profitPctCzk: number;
  dailyChangeUsd: number;
  dailyChangePct: number;
  allocation: number;
}

export const isCashPosition = (p: { ticker: string; type?: string }) => p.ticker === "CASH" || p.type === "Cash";

/**
 * Totals of the open positions, cash EXCLUDED. Cash has no cost and no return; counting it
 * as "invested" diluted the unrealized % (45,84 % instead of 47,31 % in the demo) and made
 * "Investováno" differ between the tabs by the cash balance.
 */
export function summarizeHoldings(positions: LivePosition[]) {
  let value = 0, invested = 0, valueCzk = 0, investedCzk = 0;
  for (const p of positions) {
    if (isCashPosition(p)) continue;
    value += p.value; invested += p.invested;
    valueCzk += p.valueCzk; investedCzk += p.investedCzk;
  }
  const profit = value - invested, profitCzk = valueCzk - investedCzk;
  return {
    value, invested, profit, profitPct: invested > 0 ? (profit / invested) * 100 : 0,
    valueCzk, investedCzk, profitCzk, profitPctCzk: investedCzk > 0 ? (profitCzk / investedCzk) * 100 : 0,
  };
}

export function useComputedPortfolio() {
  const positionsQ = usePositions();
  const pricesQ = useLivePrices();
  const txsQ = useTransactions();
  const snapsQ = useDailySnapshots();
  const summaryQ = useBrokerSummary("T212");
  const divsQ = useDividends();

  // Every figure below needs all of these: the trades for the cost basis and Vloženo, the
  // snapshots for the purchase-day FX, the broker summary for T212's deposits. Reporting
  // "ready" on positions + prices alone let the header show a number and then jump.
  const loading = positionsQ.isLoading || pricesQ.isLoading || txsQ.isLoading || snapsQ.isLoading || summaryQ.isLoading || divsQ.isLoading;

  // The …Czk figures below are in the LOCAL display currency (koruny unless another one is
  // chosen): `rate` is today's USD→local, and the snapshots already carry each day's USD→local.
  const fx = useLocalFxOptional();
  const usdCzk = pricesQ.data?.usdCzk ?? 23;
  const rate = usdCzk * fx.perCzkToday;
  // USD->local by date from snapshot fx_rate, for the purchase-time local cost basis.
  const fxByDate = new Map<string, number>();
  for (const s of snapsQ.data ?? []) if (s.fx_rate) fxByDate.set(s.snapshot_date, Number(s.fx_rate));
  const fxDates = [...fxByDate.keys()].sort();
  const fxAt = (date: string): number => {
    if (fxByDate.has(date)) return fxByDate.get(date)!;
    // No snapshot that day: the nearest earlier day's USD/CZK (else today's), but the koruna →
    // local leg at the rate of the purchase day itself — as the koruna figure would be.
    let czk = usdCzk;
    for (const d of fxDates) { if (d <= date) czk = fxByDate.get(d)! / fx.perCzkAt(d); else break; }
    return czk * fx.perCzkAt(date);
  };

  // A position worth less than this (USD) is treated as closed: hidden and not counted.
  // Kills tiny "dust" residuals left by approximate broker imports.
  const DUST_USD = 10;

  // Correct per-holding cost basis via FIFO from real trades (handles same ticker across
  // brokers + ignores $0 reconcile rows). Falls back to the stored avg if no trade data.
  const fifoCost = computeHoldingCostFifo(txsQ.data || [], fxAt);

  const positions: LivePosition[] = (positionsQ.data || [])
    .map((p) => {
    const live = pricesQ.data?.prices[p.ticker];
    const currentPrice = live?.price ?? p.avg_cost_usd;
    const dailyPct = live?.changePct ?? 0;
    const value = p.shares * currentPrice;
    const f = fifoCost.get(p.ticker);
    const avgCost = f && f.shares > 1e-6 ? f.cost / f.shares : p.avg_cost_usd;
    const invested = p.shares * avgCost;
    const avgCostCzk = f && f.shares > 1e-6 ? f.costCzk / f.shares : p.avg_cost_usd * rate;
    const investedCzk = p.shares * avgCostCzk;
    const valueCzk = value * rate;
    const dailyChangeUsd = live?.prevClose ? p.shares * (currentPrice - live.prevClose) : 0;
    return {
      ticker: p.ticker,
      name: p.name,
      type: p.type,
      shares: p.shares,
      avgPrice: avgCost,
      currentPrice,
      invested,
      value,
      profitUsd: value - invested,
      profitPct: invested > 0 ? ((value - invested) / invested) * 100 : 0,
      avgPriceCzk: avgCostCzk,
      investedCzk,
      valueCzk,
      profitCzk: valueCzk - investedCzk,
      profitPctCzk: investedCzk > 0 ? ((valueCzk - investedCzk) / investedCzk) * 100 : 0,
      dailyChangeUsd,
      dailyChangePct: dailyPct,
      allocation: 0,
    };
  })
    .filter((p) => p.ticker === "CASH" || p.value >= DUST_USD);

  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  for (const p of positions) p.allocation = totalValue > 0 ? Math.round((p.value / totalValue) * 1000) / 10 : 0;

  const holdings = summarizeHoldings(positions);
  const totalInvested = holdings.invested;
  const unrealizedProfit = holdings.profit;
  const dailyReturn = positions.reduce((s, p) => s + p.dailyChangeUsd, 0);

  // Realized profit via the shared FIFO incl. fees — the same lots as the Tax report.
  const realizedProfit = computeRealizedFifo(txsQ.data || []);

  // Net money put in, measured on the same basis as Hodnota (see lib/netDeposits): the
  // honest base for total return, profit = current value − net deposits, which inherently
  // includes gains already locked in from sold positions.
  const summary = summaryQ.data;
  const deposits = computeNetDeposits({ txs: txsQ.data || [], t212: summary, usdCzk, localPerCzk: fx.perCzkToday, fxAt, dividends: (divsQ.data || []) as any });
  const hasDeposits = deposits.usd > 0;
  const totalProfit = hasDeposits ? totalValue - deposits.usd : unrealizedProfit + realizedProfit;
  const totalReturnPct = hasDeposits
    ? (totalProfit / deposits.usd) * 100
    : (totalInvested > 0 ? ((unrealizedProfit + realizedProfit) / totalInvested) * 100 : 0);
  // In CZK: today's value against the koruny actually put in (each flow at its own day's
  // rate; a CZK T212 account's own figure exactly), so the result includes the currency move.
  const totalValueCzk = totalValue * rate;
  const totalProfitCzk = hasDeposits ? totalValueCzk - deposits.czk : totalProfit * rate;
  const totalReturnPctCzk = hasDeposits && deposits.czk > 0 ? (totalProfitCzk / deposits.czk) * 100 : totalReturnPct;

  return {
    loading,
    positions,
    totalValue,
    totalInvested,
    totalInvestedCzk: holdings.investedCzk,
    unrealizedProfit,
    unrealizedProfitCzk: holdings.profitCzk,
    realizedProfit,
    dailyReturn,
    netDepositsUsd: hasDeposits ? deposits.usd : null,
    netDepositsCzk: hasDeposits ? deposits.czk : null,
    totalProfit,
    totalProfitCzk,
    totalReturnPct,
    totalReturnPctCzk,
    totalProfitPct: holdings.profitPct,
    totalProfitPctCzk: holdings.profitPctCzk,
    /** Today's real USD/CZK (taxes, ČNB notes) — not the display currency. */
    usdCzk,
    /** Today's USD → local display currency (the rate of every …Czk figure). */
    usdLocal: rate,
    stale: pricesQ.data?.stale ?? false,
    fetchedAt: pricesQ.data?.fetchedAt,
    error: pricesQ.error || pricesQ.data?.error || null,
  };
}
