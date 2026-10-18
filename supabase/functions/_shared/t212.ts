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

// ── History model of ONE connected T212 account (used by sync-broker) ──────────────────────
//
// An account whose history came from its broker statement (t212:act:*) or was entered by
// hand is authoritative up to its latest such trade; the orders API only APPENDS what came
// after. Reconcile adjustments (t212:adj:*) are neither: they are stamped with now() and
// exist on every account after its first reconcile — counting them as "statement" switched
// pure-API accounts into statement mode, and counting API fills (t212:ord:*) into the cutoff
// made a manual sync delete every order an earlier sync had pulled, then never pull it again.
export type T212RowKind = "adjustment" | "api" | "statement";

export function t212RowKind(extId: string | null | undefined): T212RowKind {
  const ext = String(extId ?? "");
  if (ext.startsWith("t212:adj:")) return "adjustment";
  if (ext.startsWith("t212:ord:")) return "api";
  return "statement"; // t212:act:* (statement import) or a manual entry (no ext_id)
}

export interface T212StoredTrade {
  ext_id: string | null;
  executed_at: string;
  ticker?: string;
  side?: string;
  shares?: number | string;
  price_usd?: number | string;
}

export interface T212HistoryPlan {
  /** The account has statement/manual history, so the API only appends after it. */
  statementMode: boolean;
  /**
   * Latest statement/manual trade. API fills at or before it are covered by the statement:
   * they are deleted on the first batch and never inserted. Never taken from API fills or
   * adjustments.
   */
  statementCutoff: string | null;
  /**
   * Where paging the newest-first order history may stop: the newest stored non-adjustment
   * row, API fills included, because those are already stored. Only a paging bound — it
   * never decides what is deleted or inserted. While an earlier run is unfinished it falls
   * back to the statement cutoff: that run stored the NEWEST pages and stopped in the middle,
   * so its newest order proves nothing about the orders before it.
   */
  pageStop: string | null;
}

const at = (s: string) => new Date(s).getTime();
const latest = (rows: T212StoredTrade[]) =>
  rows.reduce<string | null>((m, r) => (m === null || at(r.executed_at) > at(m) ? r.executed_at : m), null);

export function planT212History(stored: T212StoredTrade[], opts: { resuming: boolean }): T212HistoryPlan {
  const statement = stored.filter((r) => t212RowKind(r.ext_id) === "statement");
  if (!statement.length) return { statementMode: false, statementCutoff: null, pageStop: null };
  const statementCutoff = latest(statement);
  const pageStop = opts.resuming ? statementCutoff : latest(stored.filter((r) => t212RowKind(r.ext_id) !== "adjustment"));
  return { statementMode: true, statementCutoff, pageStop };
}

/** Statement mode: true once a newest-first page of orders reaches what is already stored. */
export function reachedPageStop(executedAts: (string | null | undefined)[], plan: T212HistoryPlan): boolean {
  if (!plan.statementMode || !plan.pageStop) return false;
  const stop = at(plan.pageStop);
  return executedAts.some((t) => !!t && at(t) <= stop);
}

/**
 * The fetched orders to write. In statement mode: only orders after the statement cutoff,
 * minus any the statement (or a manual entry) already records under a different id. The
 * statement and the orders API describe the SAME fill with different ids and timestamps
 * (statement day at noon vs the real fill time), so a same-day trade slips past the cutoff
 * and would double-import (seen: a NU buy counted twice, +910 shares, masked by a reconcile
 * adjustment). Only statement/manual rows block: API fills are deduped by ext_id in the
 * import RPC, and an adjustment is not a trade. Orders already stored are returned too —
 * the RPC skips their ext_id, which is what refills any gap after the cutoff.
 */
export function selectT212OrdersToInsert<R extends T212StoredTrade>(fetched: R[], stored: T212StoredTrade[], plan: T212HistoryPlan): R[] {
  if (!plan.statementMode) return fetched;
  const cut = plan.statementCutoff ? at(plan.statementCutoff) : -Infinity;
  const key = (t: T212StoredTrade) =>
    `${t.ticker}|${String(t.executed_at).slice(0, 10)}|${t.side}|${Number(t.shares).toFixed(4)}|${Number(t.price_usd).toFixed(2)}`;
  const statementKeys = new Set(stored.filter((t) => t212RowKind(t.ext_id) === "statement").map(key));
  return fetched.filter((r) => at(r.executed_at) > cut && !statementKeys.has(key(r)));
}

/** What a fill needs to be priced in USD. */
export interface T212FillMoney {
  instrumentCurrency: string | null;
  price: number;            // per share, instrument currency (GBX = pence)
  quantity: number;         // absolute
  walletCurrency: string | null;
  walletNetValue: number | null; // absolute, wallet (account) currency, fees included
}

/**
 * USD price per share of an API fill. `fill.price` is in the INSTRUMENT currency, so it is
 * only USD for USD instruments; a GBX fill of 395.5 is 395.5 pence, not $395.5. For other
 * instruments the authoritative amount is walletImpact.netValue in the account currency:
 * USD accounts use it as is, CZK accounts convert it at that day's USD/CZK. Anything else
 * (EUR/GBP wallets) falls back to the market close in USD, or null when nothing is known —
 * the caller must not store a native-currency number as USD.
 */
export function t212FillPriceUsd(
  f: T212FillMoney,
  usdCzkOn: (date: string) => number | null,
  closeUsdOn: () => number | null,
  date: string,
): number | null {
  if ((f.instrumentCurrency ?? "USD").toUpperCase() === "USD") return f.price;
  const qty = Math.abs(f.quantity);
  const net = f.walletNetValue != null ? Math.abs(f.walletNetValue) : null;
  if (qty > 0 && net != null && net > 0) {
    const wallet = (f.walletCurrency ?? "").toUpperCase();
    if (wallet === "USD") return net / qty;
    if (wallet === "CZK") {
      const fx = usdCzkOn(date);
      if (fx && fx > 0) return net / qty / fx;
    }
  }
  // Fallback: the day's USD close. price_history is split-ADJUSTED while the fill keeps
  // its as-traded quantity, so before a split the close would be off by the ratio. Accept
  // it only when it agrees with the native fill price at a plausible FX rate; otherwise
  // skip rather than store a wrong cost.
  const close = closeUsdOn();
  if (!(close && close > 0)) return null;
  const usdPerUnit: Record<string, [number, number]> = { GBX: [0.009, 0.018], GBP: [0.9, 1.8], EUR: [0.8, 1.4], CHF: [0.8, 1.4] };
  const band = usdPerUnit[(f.instrumentCurrency ?? "").toUpperCase()];
  if (!band || !(f.price > 0)) return null;
  const implied = close / f.price;
  return implied >= band[0] && implied <= band[1] ? close : null;
}

/**
 * Unpriced API fills that must stop the sync: only those that would actually be stored. A
 * fill at or before the statement cutoff is covered by the statement; one already stored
 * survives — unless this batch REPLACES the account's history, which deletes stored rows
 * first (then every unpriced fill would be lost and blocks).
 */
export function blockingUnpricedFills<U extends { executed_at: string; ext_id: string }>(
  unpriced: U[], stored: { ext_id?: string | null }[], plan: { statementMode: boolean; statementCutoff: string | null }, replacing: boolean,
): U[] {
  const storedExt = new Set(replacing ? [] : stored.map((t) => t.ext_id));
  const cutoffMs = plan.statementMode && plan.statementCutoff ? Date.parse(plan.statementCutoff) : -Infinity;
  return unpriced.filter((u) => Date.parse(u.executed_at) > cutoffMs && !storedExt.has(u.ext_id));
}
