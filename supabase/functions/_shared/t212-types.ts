import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type T212Client = Pick<SupabaseClient, "from" | "rpc">;
export interface T212Summary { free?: number; currency?: string | null }
export interface T212Key { api_key: string; environment: string; last_sync_cursor: string | null }
export interface T212CashItem { dateTime?: string; currency?: string; type?: string; amount?: number | string; reference?: string | number; id?: string | number }
export interface T212Deposit {
  id?: string; user_id?: string; broker?: string; ext_id: string; api_reference?: string | null; source?: string; broker_account?: string;
  flow_date: string; amount_usd: number; original_currency?: string; original_amount?: number;
}
export interface T212Fee { name?: string; amount?: number | string; quantity?: number | string; currency?: string }
export interface T212Fill {
  id?: number | string; quantity?: number | string; price?: number | string; filledAt?: string;
  fees?: T212Fee[]; fee?: T212Fee | number;
  walletImpact?: { currency?: string; netValue?: number; taxes?: T212Fee[]; fees?: T212Fee[] };
}
export interface T212OrderItem {
  order?: { status?: string; ticker?: string; side?: string; currency?: string; dateModified?: string; createdAt?: string;
    instrument?: { isin?: string; name?: string; currency?: string } };
  fill?: T212Fill;
}
export interface T212Holding { ticker: string; quantity: number; averagePrice: number; currentPrice: number }
export interface T212Dividend { ref: string; ticker: string; paidOn?: string; amount?: number; quantity?: number; grossAmountPerShare?: number }
