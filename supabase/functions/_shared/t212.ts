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
//
// CONCURRENCY — the read-base / apply-delta / write-base step must be atomic. The cron
// (auto-sync) and a manual sync (sync-broker) can run at the same moment for the same user;
// done as three separate PostgREST calls both read the same base and both applied the same
// delta, double-counting the change in cash. The step therefore runs in ONE locked SQL call,
// public.sync_t212_cash (migration 20261024100010). Until that migration is deployed the old
// unlocked path is used as a fallback, now with every error checked.
//
// THROWS on any failed read/write: a silently ignored error used to leave cash and the stored
// base out of step (e.g. a missing cash_base_free_usd column read as "no base" and re-adopted
// the API value on every run). Callers log the error and keep going.
export async function syncCashFromApi(svc: any, userId: string, summary: any): Promise<void> {
  const free = Number(summary?.free);
  if (!isFinite(free)) return;
  const ccy = summary?.currency;
  let freeUsd: number;
  if (ccy === "USD") {
    freeUsd = free;
  } else if (ccy === "CZK") {
    const { data: fx, error: fxErr } = await svc.from("price_history").select("close").eq("symbol", "USDCZK").order("date", { ascending: false }).limit(1);
    if (fxErr) throw new Error(`syncCashFromApi: USDCZK read failed: ${fxErr.message}`);
    const rate = Number(fx?.[0]?.close);
    if (!isFinite(rate) || rate <= 0) return;
    freeUsd = free / rate;
  } else {
    return; // unknown/unsupported currency — never assume USD, never touch cash
  }

  const { error: rpcErr } = await svc.rpc("sync_t212_cash", { p_user_id: userId, p_free_usd: freeUsd });
  if (!rpcErr) return;
  if (!isMissingRpc(rpcErr)) throw new Error(`sync_t212_cash: ${rpcErr.message}`);
  console.warn("syncCashFromApi: sync_t212_cash is not deployed — using the unlocked fallback (a concurrent sync can double-count)");

  const { data: bc, error: bcErr } = await svc.from("broker_connections").select("cash_base_free_usd").eq("user_id", userId).eq("broker", "T212").maybeSingle();
  if (bcErr) throw new Error(`syncCashFromApi: cash base read failed: ${bcErr.message}`);
  const base = bc?.cash_base_free_usd != null ? Number(bc.cash_base_free_usd) : null;
  let delta: number;
  if (base == null) {
    const { data: c, error: cErr } = await svc.from("positions").select("shares").eq("user_id", userId).eq("ticker", "CASH").maybeSingle();
    if (cErr) throw new Error(`syncCashFromApi: CASH read failed: ${cErr.message}`);
    delta = freeUsd - (c ? Number(c.shares) : 0); // first sync: adopt the API value
  } else {
    delta = freeUsd - base; // later syncs: accrue only the change since last sync
  }
  if (Math.abs(delta) > 0.005) {
    const { error: dErr } = await svc.rpc("apply_cash_delta", { p_user_id: userId, p_delta: delta });
    // Not applied → do NOT move the base either, so the next run applies this change.
    if (dErr) throw new Error(`syncCashFromApi: apply_cash_delta failed: ${dErr.message}`);
  }
  const { error: uErr } = await svc.from("broker_connections").update({ cash_base_free_usd: freeUsd }).eq("user_id", userId).eq("broker", "T212");
  if (uErr) throw new Error(`syncCashFromApi: cash applied (${delta.toFixed(2)} USD) but base not stored — next run may re-apply it: ${uErr.message}`);
}

/** PostgREST error for an RPC that does not exist (yet) in the database. */
export function isMissingRpc(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "PGRST202" || err.code === "42883" || /could not find the function/i.test(String(err.message ?? ""));
}

// ── Paging of the T212 history endpoints ────────────────────────────────────────────────
//
// nextPagePath is a path WITH the /api/v0 prefix and its own query string, e.g.
// "/api/v0/equity/history/dividends?limit=50&cursor=1760346100000" (docs.trading212.com,
// Pagination). Our fetch helpers already prepend ".../api/v0", so the next request is the
// path minus that prefix. Appending it to "<endpoint>?" (as before) only worked by accident:
// the cursor survived as a stray query parameter, the limit fell back to the default 20.
export function t212NextPage(nextPagePath: string | null | undefined, endpoint: string): string | null {
  if (!nextPagePath) return null;
  const s = String(nextPagePath).trim();
  if (!s) return null;
  if (s.startsWith("/api/v0/")) return s.slice("/api/v0".length);
  if (s.startsWith("/")) return s;
  return `${endpoint}?${s.replace(/^\?/, "")}`; // a bare query string
}

// ── Historical FX ─────────────────────────────────────────────────────────────────────────
/**
 * Rate for `date` from an ascending {date, close} series: the latest on or before it, else
 * the earliest after it (history that starts later than the oldest flow). Null when the series
 * has no usable rate — the caller must skip, never guess.
 */
export function rateNear(series: { date: string; close: number }[], date: string): number | null {
  let best: number | null = null;
  for (const r of series) {
    if (!(r.close > 0)) continue;
    if (r.date <= date) best = r.close;
    else return best ?? r.close;
  }
  return best;
}

// ── Reconcile input (shared by sync-broker and auto-sync) ─────────────────────────────────
export interface T212PortfolioHolding { ticker: string; qty: number; avg: number; cur?: number; usdQuoted?: boolean }

/**
 * USD average cost for a reconcile adjustment. T212's averagePrice is in the instrument's
 * native currency (GBX/EUR/…), so it is scaled by avg/current onto our USD price. Without a
 * USD price the native number is only usable for US instruments (_US_EQ, quoted in USD);
 * otherwise null — 400 GBX is not $400.
 */
export function reconcileAvgUsd(h: T212PortfolioHolding, usdPrice: number | null | undefined): number | null {
  if (h.cur && h.cur > 0 && usdPrice && usdPrice > 0 && isFinite(h.avg)) return Math.round(usdPrice * (h.avg / h.cur) * 1e6) / 1e6;
  if (h.usdQuoted && isFinite(h.avg) && h.avg > 0) return h.avg;
  return null;
}

export interface AliasLinkRow { alias: string; canonical: string; isin?: string | null }

/**
 * Do two tickers name the same instrument? Either the same ticker, the T212 LSE form of it
 * ("BARCl_EQ" → BARCL vs BARC), a ticker_alias row linking them, or a shared ISIN.
 */
export function tickersLinked(a: string, b: string, rows: AliasLinkRow[]): boolean {
  if (a === b) return true;
  if (a === `${b}L` || b === `${a}L`) return true;
  if (rows.some((r) => (r.alias === a && r.canonical === b) || (r.alias === b && r.canonical === a))) return true;
  const isins = (t: string) => new Set(rows.filter((r) => r.alias === t || r.canonical === t).map((r) => String(r.isin ?? "").toUpperCase()).filter(Boolean));
  const ia = isins(a);
  for (const i of isins(b)) if (ia.has(i)) return true;
  return false;
}

/**
 * Ticker-rename guard. The portfolio can label an instrument differently from the order
 * history (Barclays "BARCL" vs "BARC", Grab "AGC" vs "GRAB"); reconciling as-is would zero
 * the real position and create a phantom one. A broker-only ticker is relabelled to a
 * trades-only ticker ONLY when both carry the same quantity AND are linked (tickersLinked).
 * Equal quantity alone is not enough: sell 10 AAPL + buy 10 MSFT before the orders are
 * stored made MSFT show up as AAPL (auto-sync never imports orders, so it stayed that way).
 */
export function applyRenameGuard<H extends { ticker: string; qty: number }>(
  holdings: H[], net: Map<string, number>, linked: (holdingTicker: string, tradeTicker: string) => boolean,
): H[] {
  const reported = new Set(holdings.map((h) => h.ticker));
  const orphanTrades = [...net].filter(([tk, q]) => q > 1e-4 && !reported.has(tk));
  const taken = new Set<string>();
  return holdings.map((h) => {
    if (net.has(h.ticker)) return h;
    const m = orphanTrades.find(([tk, q]) => !taken.has(tk) && Math.abs(q - h.qty) < 1e-4 && linked(h.ticker, tk));
    if (!m) return h;
    taken.add(m[0]);
    return { ...h, ticker: m[0] };
  });
}

/**
 * Holdings for public.reconcile_broker_account of ONE T212 account: USD average cost +
 * rename guard. Shared so the manual sync and the background sync stay interchangeable.
 * THROWS on a failed read (the callers then skip the reconcile instead of guessing).
 */
export async function prepareReconcileHoldings(
  svc: any, userId: string, account: string, hjson: T212PortfolioHolding[],
): Promise<{ ticker: string; qty: number; avg: number | null }[]> {
  const { data: pcRows, error: pcErr } = await svc.from("price_cache").select("symbol,price");
  if (pcErr) throw new Error(`price_cache read failed: ${pcErr.message}`);
  const pxMap = new Map<string, number>((pcRows ?? []).map((r: any) => [r.symbol, Number(r.price)]));
  const live = hjson.filter((h) => h.qty > 0).map((h) => ({ ...h, brokerTicker: h.ticker }));

  const net = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data: txs, error } = await svc.from("transactions")
      .select("ticker,side,shares").eq("user_id", userId).eq("broker", "T212")
      .eq("broker_account", account).neq("ticker", "CASH")
      .not("ext_id", "like", "t212:adj:%") // last run's corrections aren't part of the net
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`transactions read failed: ${error.message}`);
    if (!txs || txs.length === 0) break;
    for (const t of txs) net.set(t.ticker, (net.get(t.ticker) ?? 0) + (t.side === "BUY" ? 1 : -1) * Number(t.shares));
    if (txs.length < 1000) break;
  }
  const reported = new Set(live.map((h) => h.ticker));
  const involved = [...new Set([
    ...live.filter((h) => !net.has(h.ticker)).map((h) => h.ticker),
    ...[...net].filter(([tk, q]) => q > 1e-4 && !reported.has(tk)).map(([tk]) => tk),
  ])];
  let aliasRows: AliasLinkRow[] = [];
  if (involved.length) {
    const [a, c] = await Promise.all([
      svc.from("ticker_alias").select("alias,canonical,isin").in("alias", involved),
      svc.from("ticker_alias").select("alias,canonical,isin").in("canonical", involved),
    ]);
    if (a.error || c.error) throw new Error(`ticker_alias read failed: ${(a.error ?? c.error).message}`);
    aliasRows = [...(a.data ?? []), ...(c.data ?? [])];
  }
  // Guard first, then price: a relabelled holding is quoted under the ticker it now carries.
  let holdings = applyRenameGuard(live, net, (h, t) => tickersLinked(h, t, aliasRows)).map((h) => ({
    ticker: h.ticker, qty: h.qty, avg: reconcileAvgUsd(h, pxMap.get(h.ticker) ?? pxMap.get(h.brokerTicker)),
  }));

  // No USD cost for a non-US instrument without a USD quote: keep the cost the position
  // already carries rather than store a native-currency number as USD.
  const missing = holdings.filter((h) => h.avg == null).map((h) => h.ticker);
  if (missing.length) {
    const { data: pos, error } = await svc.from("positions").select("ticker,avg_cost_usd").eq("user_id", userId).in("ticker", missing);
    if (error) throw new Error(`positions read failed: ${error.message}`);
    const cost = new Map<string, number>((pos ?? []).map((p: any) => [p.ticker, Number(p.avg_cost_usd)]));
    holdings = holdings.map((h) => (h.avg == null && (cost.get(h.ticker) ?? 0) > 0 ? { ...h, avg: cost.get(h.ticker)! } : h));
    const still = holdings.filter((h) => h.avg == null).map((h) => h.ticker);
    if (still.length) console.warn(`reconcile: no USD cost for ${still.join(", ")} — an adjustment for them is stored at 0`);
  }
  return holdings;
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
   * Earliest statement/manual trade. A statement covers only its own period: API fills
   * before it (e.g. January fills when only a June statement was imported) are NOT covered
   * and must never be deleted.
   */
  statementStart: string | null;
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
  if (!statement.length) return { statementMode: false, statementCutoff: null, statementStart: null, pageStop: null };
  const statementCutoff = latest(statement);
  const first = statement.reduce<string | null>((m, r) => (m === null || at(r.executed_at) < at(m) ? r.executed_at : m), null);
  // From the start of that UTC day: statement rows are stamped at noon, the API fill of the
  // same trade may be earlier that morning and is covered too.
  const statementStart = first ? `${new Date(first).toISOString().slice(0, 10)}T00:00:00.000Z` : null;
  const pageStop = opts.resuming ? statementCutoff : latest(stored.filter((r) => t212RowKind(r.ext_id) !== "adjustment"));
  return { statementMode: true, statementCutoff, statementStart, pageStop };
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
