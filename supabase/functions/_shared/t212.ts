import type { T212Client, T212Summary, T212CashItem, T212Deposit, T212Fill, T212OrderItem } from "./t212-types.ts";

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
export async function syncCashFromApi(svc: T212Client, userId: string, summary: T212Summary): Promise<void> {
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
 * Last published rate on or before the date, at most six days old. Never use future FX.
 */
export function rateNear(series: { date: string; close: number }[], date: string): number | null {
  let best: number | null = null;
  let ref = "";
  for (const r of series) {
    if (!(r.close > 0) || !Number.isFinite(r.close)) continue;
    if (r.date <= date) { best = r.close; ref = r.date; }
    else break;
  }
  return ref && Date.parse(date) - Date.parse(ref) <= 6 * 86400000 ? best : null;
}

export interface T212CashPageState {
  cutoff: string;
  path: string | null;
  items: T212CashItem[];
}

/** Staged pages never become a watermark until the entire overlapping range is read. */
export async function collectT212CashPages(fetchPage: (path: string) => Promise<Response>, state: T212CashPageState, maxPages = 12): Promise<T212CashPageState> {
  let { path } = state;
  const items = [...state.items];
  for (let n = 0; n < maxPages && path; n++) {
    const response = await fetchPage(path);
    if (!response.ok) throw Object.assign(new Error(`Cash history HTTP ${response.status}; retry required`), { progress: { cutoff: state.cutoff, path, items } });
    const page = await response.json();
    if (!Array.isArray(page.items)) throw new Error("Invalid cash history page");
    items.push(...page.items);
    const crossed = page.items.some((x: T212CashItem) => String(x.dateTime ?? "").slice(0, 10) < state.cutoff);
    path = crossed ? null : t212NextPage(page.nextPagePath, "/equity/history/transactions");
  }
  return { cutoff: state.cutoff, path, items };
}

export function t212CashId(account: string, item: { reference?: string | number; id?: string | number }): string {
  const id = item.reference ?? item.id;
  if (id == null || id === "") throw new Error("Cash flow has no stable external id; review required");
  return `t212:cashtx:${account}:${id}`;
}

export function t212ExternalCashFlows(items: T212CashItem[], currency: string, cutoff: string): T212CashItem[] {
  // Conversions use DEPOSIT/WITHDRAW too. Inspect every leg (including fees) before
  // filtering to the account currency, across the complete staged page range.
  const currenciesAt = new Map<string, Set<string>>();
  for (const x of items) {
    // An incomplete conversion leg must not turn its counterpart into an external flow.
    if (!x.dateTime || !x.currency) throw new Error("Cash history item missing dateTime or currency; retry required");
    if (!currenciesAt.has(x.dateTime)) currenciesAt.set(x.dateTime, new Set());
    currenciesAt.get(x.dateTime)!.add(x.currency);
  }
  return items.filter((x) => {
    if (!x.dateTime) return false;
    const day = String(x.dateTime ?? "").slice(0, 10);
    return day && day >= cutoff && x.currency === currency && (x.type === "DEPOSIT" || x.type === "WITHDRAW")
      && currenciesAt.get(x.dateTime)!.size <= 1;
  });
}

/** Consume statement matches by multiplicity; two equal deposits are still two flows. */
export function matchT212CashStatements(rows: T212Deposit[], stored: T212Deposit[], account: string): { fresh: T212Deposit[]; links: { id: string; api_reference: string }[] } {
  const seen = new Set(stored.flatMap((r) => [r.ext_id, r.api_reference]).filter(Boolean));
  const available = stored.filter((r) => r.source === "statement" && r.broker_account === account && !r.api_reference);
  const fresh: T212Deposit[] = [], links: { id: string; api_reference: string }[] = [];
  for (const row of rows) {
    if (seen.has(row.ext_id)) continue;
    seen.add(row.ext_id);
    const i = available.findIndex((s) => s.flow_date === row.flow_date && (
      s.original_currency === row.original_currency && s.original_amount != null
        ? Math.abs(Number(s.original_amount) - Number(row.original_amount)) < 0.005
        : Math.abs(Number(s.amount_usd) - Number(row.amount_usd)) < 0.005));
    if (i < 0) fresh.push(row);
    else {
      const match = available.splice(i, 1)[0];
      if (!match.id) throw new Error("Matched cash statement has no row id; review required");
      links.push({ id: match.id, api_reference: row.ext_id });
    }
  }
  return { fresh, links };
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
  svc: T212Client, userId: string, account: string, hjson: T212PortfolioHolding[],
): Promise<{ ticker: string; qty: number; avg: number | null }[]> {
  const { data: pcRows, error: pcErr } = await svc.from("price_cache").select("symbol,price");
  if (pcErr) throw new Error(`price_cache read failed: ${pcErr.message}`);
  const pxMap = new Map<string, number>((pcRows ?? []).map((r) => [r.symbol, Number(r.price)]));
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
    const aliasError = a.error ?? c.error;
    if (aliasError) throw new Error(`ticker_alias read failed: ${aliasError.message}`);
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
    const cost = new Map<string, number>((pos ?? []).map((p) => [p.ticker, Number(p.avg_cost_usd)]));
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

export function normalizeOrder(o: { quantity?: number; filledQuantity?: number; id?: string | number; ticker: string; fillPrice?: number; price?: number; fee?: number; dateExecuted?: string; dateModified?: string; dateCreated?: string }, map: Record<string, string>): NormalizedOrder {
  const executedAt = o.dateExecuted ?? o.dateModified ?? o.dateCreated;
  if (!executedAt) throw new Error("Order missing execution time; review required");
  const qty = Number(o.quantity ?? o.filledQuantity ?? 0);
  const side: Side = qty < 0 ? "SELL" : "BUY";
  return {
    t212_id: String(o.id),
    ticker: mapT212Ticker(o.ticker, map),
    side,
    shares: Math.abs(qty),
    price_usd: Number(o.fillPrice ?? o.price ?? 0),
    fee_usd: Number(o.fee ?? 0),
    executed_at: executedAt,
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
  side?: Side;
  walletFee?: number;
  walletNetValue: number | null; // absolute, wallet (account) currency, fees included
}

/**
 * USD execution price: native USD price or the dated settlement with fees separated.
 * Unsupported/missing FX requires review; market closes cannot establish execution costs.
 */
export function t212FillPriceUsd(
  f: T212FillMoney,
  usdCzkOn: (date: string) => number | null,
  _closeUsdOn: () => number | null,
  date: string,
): number | null {
  if (f.instrumentCurrency?.toUpperCase() === "USD" && Number.isFinite(f.price) && f.price > 0) return f.price;
  const qty = Math.abs(f.quantity);
  const net = f.walletNetValue != null ? Math.abs(f.walletNetValue) + (f.side === "SELL" ? 1 : -1) * (f.walletFee ?? 0) : null;
  if (qty > 0 && net != null && net > 0) {
    const wallet = (f.walletCurrency ?? "").toUpperCase();
    if (wallet === "USD") return net / qty;
    if (wallet === "CZK") {
      const fx = usdCzkOn(date);
      if (fx && fx > 0) return net / qty / fx;
    }
  }
  return null; // An execution cost cannot be inferred from a market close.

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

// ── Order fills from /equity/history/orders (shared by sync-broker and auto-sync) ──────────

export const T212_RENAME: Record<string, string> = { IPOE: "SOFI", VACQ: "RKLB", FB: "META", FBA: "META" };
export const stripT212 = (t: string) => t.replace(/_US_EQ$/, "").replace(/_EQ$/, "").toUpperCase();

/** One FILLED order of the history, before ticker mapping and USD pricing. */
export interface T212RawFill {
  base: string;
  isin: string | null;
  name: string | null;
  side: Side;
  shares: number;
  /** fill.price — in the INSTRUMENT currency (see t212FillPriceUsd). */
  price_usd: number;
  fee_usd: number;
  inst_ccy: string | null;
  wallet_ccy: string | null;
  wallet_net: number | null;
  fees?: { amount: number; currency: string | null }[];
  executed_at: string;
  ext_id: string;
}

export function parseT212Fees(fill: T212Fill): { amount: number; currency: string | null }[] {
  const wallet = fill.walletImpact;
  const fees = [...(wallet?.taxes ?? []), ...(wallet?.fees ?? fill.fees ?? [])];
  if (fill.fee != null) fees.push(typeof fill.fee === "object" ? fill.fee : { amount: fill.fee, currency: wallet?.currency });
  return fees.map((fee) => ({ amount: Math.abs(Number(fee.amount ?? fee.quantity)), currency: fee.currency ?? wallet?.currency ?? null }));
}

/** A history item → its fill, or null when it is not a filled order. */
export function parseT212OrderItem(it: T212OrderItem): T212RawFill | null {
  if (it?.order?.status !== "FILLED" || !it.fill) return null;
  const ticker = it.order.ticker;
  const executedAt = t212ItemTime(it);
  if (!ticker || !executedAt) throw new Error("Filled order missing ticker or execution time; retry required");
  const q = Number(it.fill.quantity);
  return {
    base: stripT212(ticker), isin: it.order.instrument?.isin ?? null, name: it.order.instrument?.name ?? null,
    side: q < 0 || it.order.side === "SELL" ? "SELL" : "BUY",
    shares: Math.abs(q), price_usd: Number(it.fill.price), fee_usd: 0,
    inst_ccy: it.order.instrument?.currency ?? it.order.currency ?? (String(it.order.ticker).endsWith("_US_EQ") ? "USD" : null),
    fees: parseT212Fees(it.fill),
    wallet_ccy: it.fill.walletImpact?.currency ?? null,
    wallet_net: it.fill.walletImpact?.netValue != null ? Number(it.fill.walletImpact.netValue) : null,
    executed_at: executedAt,
    ext_id: `t212:ord:${it.fill.id}`,
  };
}

/** Time of a history item (fill time first), for the rows and the paging stop. */
export const t212ItemTime = (it: T212OrderItem): string | null => it?.fill?.filledAt ?? it?.order?.dateModified ?? it?.order?.createdAt ?? null;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolve broker base tickers -> current price-provider tickers, using the
// permanent ISIN via OpenFIGI (free, no key). Results are cached globally in
// ticker_alias so every instrument is resolved once and reused by all users.
export async function resolveT212Aliases(
  pairs: { base: string; isin: string | null; name?: string | null }[],
  svc: T212Client,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const bases = [...new Set(pairs.map((p) => p.base))];
  if (!bases.length) return map;
  const { data: cached } = await svc.from("ticker_alias").select("alias,canonical").in("alias", bases);
  for (const r of (cached ?? [])) map.set(r.alias, r.canonical);

  const jobs: { base: string; isin: string; name?: string | null }[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (map.has(p.base) || !p.isin || seen.has(p.base)) continue;
    seen.add(p.base); jobs.push({ base: p.base, isin: p.isin, name: p.name });
  }
  for (let i = 0; i < jobs.length; i += 10) { // OpenFIGI no-key: 10 jobs/req, 25 req/min
    const chunk = jobs.slice(i, i + 10);
    try {
      const r = await fetch("https://api.openfigi.com/v3/mapping", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((j) => ({ idType: "ID_ISIN", idValue: j.isin, exchCode: "US" }))),
      });
      if (r.ok) {
        const arr = await r.json();
        const rows: { alias: string; canonical: string; isin: string; name: string | null; source: string }[] = [];
        chunk.forEach((j, idx) => {
          const d = arr?.[idx]?.data?.[0];
          const canonical = d?.ticker ? String(d.ticker).toUpperCase() : j.base;
          map.set(j.base, canonical);
          rows.push({ alias: j.base, canonical, isin: j.isin, name: j.name ?? null, source: "openfigi" });
        });
        if (rows.length) await svc.from("ticker_alias").upsert(rows, { onConflict: "alias" });
      } else {
        chunk.forEach((j) => { if (!map.has(j.base)) map.set(j.base, j.base); });
      }
    } catch (_e) {
      chunk.forEach((j) => { if (!map.has(j.base)) map.set(j.base, j.base); });
    }
    if (i + 10 < jobs.length) await pause(2500);
  }
  for (const p of pairs) if (!map.has(p.base)) map.set(p.base, T212_RENAME[p.base] ?? p.base);
  return map;
}

export interface T212PricedFill { ticker: string; side: Side; shares: number; price_usd: number; fee_usd: number; executed_at: string; ext_id: string; note: null }
export interface T212UnpricedFill { label: string; executed_at: string; ext_id: string }

/**
 * Raw fills → rows for import_broker_transactions: current ticker via the ISIN alias cache,
 * price in USD (t212FillPriceUsd). A fill no USD price can be found for is returned in
 * `unpriced` — never stored with a native-currency number. THROWS on a failed USD/CZK read.
 */
export async function priceT212Fills(svc: T212Client, raw: T212RawFill[]): Promise<{ rows: T212PricedFill[]; unpriced: T212UnpricedFill[] }> {
  const aliasMap = await resolveT212Aliases(raw.map((x) => ({ base: x.base, isin: x.isin, name: x.name })), svc);
  // fill.price is in the INSTRUMENT currency; only USD instruments can take it as USD.
  // Everything else is priced from walletImpact (account currency) — see t212FillPriceUsd.
  const nonUsd = raw.filter((x) => x.inst_ccy !== "USD" || x.fees?.some((f) => f.currency !== "USD"));
  let usdCzkOn: (d: string) => number | null = () => null;
  if (nonUsd.length) {
    const from = nonUsd.map((x) => String(x.executed_at).slice(0, 10)).sort()[0];
    const fromWithMargin = new Date(Date.parse(from) - 14 * 86400000).toISOString().slice(0, 10);
    const fx: { date: string; close: number }[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await svc.from("price_history").select("date,close").eq("symbol", "USDCZK")
        .gte("date", fromWithMargin).order("date", { ascending: true }).range(f, f + 999);
      if (error) throw new Error(`USDCZK read failed: ${error.message}`);
      fx.push(...((data ?? [])).map((r) => ({ date: r.date, close: Number(r.close) })));
      if ((data ?? []).length < 1000) break;
    }
    usdCzkOn = (d: string) => rateNear(fx, d);
  }
  const rows: T212PricedFill[] = [];
  const unpriced: T212UnpricedFill[] = [];
  for (const x of raw) {
    const ticker = aliasMap.get(x.base) ?? T212_RENAME[x.base] ?? x.base;
    const day = String(x.executed_at).slice(0, 10);
    let feeUsd = x.fee_usd;
    let walletFee = 0;
    let feesKnown = true;
    for (const fee of x.fees ?? []) {
      const rate = fee.currency === "USD" ? 1 : fee.currency === "CZK" ? usdCzkOn(day) : null;
      if (!rate || !Number.isFinite(fee.amount)) { feesKnown = false; break; }
      feeUsd += fee.amount / rate;
      if (fee.currency === x.wallet_ccy) walletFee += fee.amount;
      else if (x.wallet_ccy === "USD") walletFee += fee.amount / rate;
      else if (x.wallet_ccy === "CZK" && usdCzkOn(day)) walletFee += fee.amount / rate * usdCzkOn(day)!;
      else feesKnown = false;
    }
    const priceUsd = t212FillPriceUsd(
      { instrumentCurrency: x.inst_ccy, price: x.price_usd, quantity: x.shares, walletCurrency: x.wallet_ccy, walletNetValue: x.wallet_net, side: x.side, walletFee },
      usdCzkOn, () => null, day,
    );
    if (!feesKnown || priceUsd == null || !Number.isFinite(priceUsd)) { unpriced.push({ label: `${ticker} ${day} (${x.inst_ccy})`, executed_at: x.executed_at, ext_id: x.ext_id }); continue; }
    rows.push({ ticker, side: x.side, shares: x.shares, price_usd: priceUsd, fee_usd: feeUsd, executed_at: x.executed_at, ext_id: x.ext_id, note: null });
  }
  return { rows, unpriced };
}

// Every non-cash row of this account that the history model needs (ext_id decides its kind,
// the rest is the content key of the statement-duplicate guard). PAGED: PostgREST caps a
// plain select at 1000 rows and a statement import alone can write ~2000.
//
// THROWS on a failed read. An empty result would look like a pure-API account, and the
// first batch of a pure-API sync REPLACES the account's whole t212:* history — including
// the statement rows a failed read did not see.
export async function loadT212AccountTrades(svc: T212Client, userId: string, account: string): Promise<T212StoredTrade[]> {
  const out: T212StoredTrade[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("transactions")
      .select("id,ticker,side,shares,price_usd,executed_at,ext_id")
      .eq("user_id", userId).eq("broker", "T212").eq("broker_account", account).neq("ticker", "CASH")
      .order("executed_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Nepodařilo se načíst uložené obchody: ${error.message}`);
    const page = (data ?? []) as T212StoredTrade[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// ── Background append (auto-sync) ───────────────────────────────────────────────────────────
//
// The nightly job used to reconcile share COUNTS only: a sale and a re-buy of the same shares
// on one day left the count unchanged, so nothing was written and the sale was missing from
// realized P&L and the tax report until the user pressed "Synchronizovat". It now APPENDS the
// fills newer than what the account already has — never a replace, never a delete.
//
// It pages the newest-first history down to the newest stored trade and writes only when it
// got there: an append that stopped short would leave a hole below the newly stored fills,
// and the next run (and the manual sync) would page only down to those and never fill it.

export interface T212AppendPlan {
  /** Why nothing is appended for this account (left to the manual sync), or null. */
  skip: string | null;
  /** Newest stored trade (statement, manual or API fill): paging stops at or below it. */
  stopAt: string | null;
  history: T212HistoryPlan;
}

export function planT212Append(stored: T212StoredTrade[], opts: { resuming: boolean }): T212AppendPlan {
  const history = planT212History(stored, { resuming: false });
  // A manual sync is between batches: its cursor is mid-history, don't interleave.
  if (opts.resuming) return { skip: "manual sync in progress", stopAt: null, history };
  const stopAt = latest(stored.filter((r) => t212RowKind(r.ext_id) !== "adjustment"));
  // No trade at all yet: the first import is the manual sync's job (it may be thousands of orders).
  if (!stopAt) return { skip: "no stored trades yet", stopAt: null, history };
  return { skip: null, stopAt, history };
}

/** True once a newest-first page reaches the newest stored trade. */
export function reachedAppendStop(executedAts: (string | null | undefined)[], stopAt: string): boolean {
  const stop = at(stopAt);
  return executedAts.some((t) => !!t && at(t) <= stop);
}

/** Fills to append: what the history model lets in, minus fills already stored. */
export function selectT212Appends<R extends T212StoredTrade>(fetched: R[], stored: T212StoredTrade[], plan: T212AppendPlan): R[] {
  const storedExt = new Set(stored.map((t) => t.ext_id).filter(Boolean));
  return selectT212OrdersToInsert(fetched, stored, plan.history).filter((r) => !storedExt.has(r.ext_id));
}
