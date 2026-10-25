import type { LocalCurrency } from "./displayCurrency";

export interface LivePrices {
  prices: Record<string, { price: number; changePct: number; prevClose: number | null }>;
  usdCzk: number;
  /** Today's CZK per 1 EUR / GBP / PLN (display currencies), when the price job has them. */
  fxCzk?: Partial<Record<"EUR" | "GBP" | "PLN", number>>;
  fetchedAt: string;
  stale: boolean;
  error: string | null;
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

export type RawSnapshot = DbSnapshot & { readonly fxBasis: "raw-czk" };
export type DisplaySnapshot = DbSnapshot & { readonly fxBasis: "display"; readonly displayCurrency: LocalCurrency };
