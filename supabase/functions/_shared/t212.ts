export type Side = "BUY" | "SELL";

// Reflect a Trading 212 account's live free cash into the app's CASH position. Delta model:
// only the CHANGE in the broker's free cash since the last sync is applied, so a manual cash
// override on the web and later deposits accumulate instead of being overwritten.
//
// CRITICAL — the account currency must be KNOWN. When T212 throttles /equity/account/info the
// currencyCode comes back null; an earlier version then fell through to `freeUsd = free` and
// treated a CZK balance as USD, multiplying cash ~21x (7 CZK read as $7) on that run and
// snapping back on the next good run. If the currency can't be resolved we leave cash exactly
// as it is rather than guess. Lives here (shared) so sync-broker and auto-sync can never drift.
export async function syncCashFromApi(svc: any, userId: string, summary: any): Promise<void> {
  const free = Number(summary?.free);
  if (!isFinite(free)) return;
  const ccy = summary?.currency;
  let freeUsd: number;
  if (ccy === "USD") {
    freeUsd = free;
  } else if (ccy === "CZK") {
    const { data: fx } = await svc.from("price_history").select("close").eq("symbol", "USDCZK").order("date", { ascending: false }).limit(1);
    const rate = Number(fx?.[0]?.close);
    if (!isFinite(rate) || rate <= 0) return;
    freeUsd = free / rate;
  } else {
    return; // unknown/unsupported currency — never assume USD, never touch cash
  }
  const { data: bc } = await svc.from("broker_connections").select("cash_base_free_usd").eq("user_id", userId).eq("broker", "T212").maybeSingle();
  const base = bc?.cash_base_free_usd != null ? Number(bc.cash_base_free_usd) : null;
  let delta: number;
  if (base == null) {
    const { data: c } = await svc.from("positions").select("shares").eq("user_id", userId).eq("ticker", "CASH").maybeSingle();
    delta = freeUsd - (c ? Number(c.shares) : 0); // first sync: adopt the API value
  } else {
    delta = freeUsd - base; // later syncs: accrue only the change since last sync
  }
  if (Math.abs(delta) > 0.005) await svc.rpc("apply_cash_delta", { p_user_id: userId, p_delta: delta });
  await svc.from("broker_connections").update({ cash_base_free_usd: freeUsd }).eq("user_id", userId).eq("broker", "T212");
}

export interface NormalizedOrder {
  t212_id: string;
  ticker: string;
  side: Side;
  shares: number;
  price_usd: number;
  fee_usd: number;
  executed_at: string;
}

export interface MatchableTx {
  id: string;
  ticker: string;
  side: string;
  shares: number;
  executed_at: string;
  broker: string;
  t212_id: string | null;
}

export function mapT212Ticker(t212: string, map: Record<string, string>): string {
  if (map[t212]) return map[t212];
  return t212.replace(/_US_EQ$/, "").replace(/_EQ$/, "");
}

export function normalizeOrder(o: any, map: Record<string, string>): NormalizedOrder {
  const qty = Number(o.quantity ?? o.filledQuantity ?? 0);
  const side: Side = qty < 0 ? "SELL" : "BUY";
  return {
    t212_id: String(o.id),
    ticker: mapT212Ticker(o.ticker, map),
    side,
    shares: Math.abs(qty),
    price_usd: Number(o.fillPrice ?? o.price ?? 0),
    fee_usd: Number(o.fee ?? 0),
    executed_at: o.dateExecuted ?? o.dateModified ?? o.dateCreated,
  };
}

const DAY = 86_400_000;

export function matchManual(
  cand: { ticker: string; side: Side; shares: number; executed_at: string },
  txs: MatchableTx[],
  opts: { sharesTolPct?: number; daysWindow?: number } = {},
): MatchableTx | null {
  const tol = opts.sharesTolPct ?? 0.005;
  const win = (opts.daysWindow ?? 3) * DAY;
  const ct = new Date(cand.executed_at).getTime();
  for (const t of txs) {
    if (t.broker !== "manual" || t.t212_id) continue;
    if (t.ticker !== cand.ticker || t.side !== cand.side) continue;
    const shareOk = Math.abs(t.shares - cand.shares) <= Math.max(1e-6, cand.shares * tol);
    const dateOk = Math.abs(new Date(t.executed_at).getTime() - ct) <= win;
    if (shareOk && dateOk) return t;
  }
  return null;
}
