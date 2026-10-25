import type { T212Client, T212Summary, T212Key, T212Holding, T212Dividend, T212Deposit, T212OrderItem } from "../_shared/t212-types.ts";
// Trading 212 sync — RESUMABLE full order-history import that works for any volume.
// Each call pulls orders for ~100s, appends them (fast bulk insert, recalc deferred),
// and saves a cursor. The client calls repeatedly until {done:true}; the final call
// pulls /equity/portfolio and reconciles so positions are exact. Handles new users with
// hundreds/thousands of orders despite T212 throttling the server IP + the 150s limit.
import { t212AccountGuard } from "../_shared/t212-account.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { collectT212CashPages, t212CashId, t212ExternalCashFlows, matchT212CashStatements, syncCashFromApi, planT212History, reachedPageStop, selectT212OrdersToInsert, blockingUnpricedFills, t212NextPage, rateNear, prepareReconcileHoldings, parseT212OrderItem, t212ItemTime, priceT212Fills, loadT212AccountTrades, T212_RENAME as RENAME, stripT212, type T212RawFill, type T212PortfolioHolding } from "../_shared/t212.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME_BUDGET_MS = 100_000;

// resolveT212Aliases, priceT212Fills and loadT212AccountTrades live in ../_shared/t212.ts:
// the background sync (auto-sync) appends new fills with the same code.

// syncCashFromApi now lives in ../_shared/t212.ts so this function and auto-sync share one
// implementation (and one currency-safety guard) — see there for the rationale.

// External cash flows use broker types and exclude multi-currency conversion instants,
// never an amount threshold.
// Paging is staged until the entire overlapping range is complete.
// USD/<ccy> closes from `fromDay` on (ascending, paged), for converting each historical flow
// at ITS day's rate (rateNear) instead of today's. THROWS on a failed read.
async function loadUsdFx(svc: T212Client, ccy: string, fromDay: string): Promise<{ date: string; close: number }[]> {
  const from = new Date(Date.parse(fromDay) - 14 * 86400000).toISOString().slice(0, 10);
  const out: { date: string; close: number }[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await svc.from("price_history").select("date,close").eq("symbol", "USD" + ccy)
      .gte("date", from).order("date", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`USD${ccy} read failed: ${error.message}`);
    out.push(...((data ?? [])).map((r) => ({ date: r.date, close: Number(r.close) })));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// T212 documents this endpoint as /equity/history/transactions; the code used to call the
// undocumented /history/transactions. Try the documented path first and fall back to the old
// one only when it is not found, so an account that worked before keeps working.
async function fetchTransactionsPage(t212: (p: string) => Promise<Response>, path: string): Promise<Response> {
  const r = await t212(path);
  if (r.status !== 404 || !path.startsWith("/equity/history/transactions")) return r;
  return t212(path.replace("/equity/history/transactions", "/history/transactions"));
}

async function syncDepositsFromApi(svc: T212Client, userId: string, account: string, t212: (p: string) => Promise<Response>, summary: T212Summary) {
  const acctCcy = summary?.currency;
  if (acctCcy !== "USD" && acctCcy !== "CZK") return 0;
  const { data: connection, error: stateError } = await svc.from("broker_connections").select("cash_sync_state").eq("user_id", userId).eq("broker", "T212").single();
  if (stateError) throw stateError;
  const saved = connection?.cash_sync_state;
  const state = saved?.account === account ? saved : null;
  const cutoff = state?.cutoff ?? "2000-01-01";
  const saveState = async (next: import("../_shared/t212.ts").T212CashPageState) => {
    const { error } = await svc.from("broker_connections").update({ cash_sync_state: { ...next, account } }).eq("user_id", userId).eq("broker", "T212");
    if (error) throw error;
  };
  let page;
  try {
    page = await collectT212CashPages((path) => fetchTransactionsPage(t212, path), {
      cutoff, path: state?.path ?? "/equity/history/transactions?limit=50", items: state?.items ?? [],
    });
  } catch (error) {
    const progress = (error as { progress?: import("../_shared/t212.ts").T212CashPageState }).progress;
    if (progress) await saveState(progress);
    throw error;
  }
  if (page.path) { await saveState(page); throw new Error("Cash history incomplete; sync again to continue"); }
  const items = page.items;
  const finish = () => saveState({ cutoff: items.reduce((day: string, x) => String(x.dateTime ?? "").slice(0, 10) > day ? String(x.dateTime).slice(0, 10) : day, cutoff), path: null, items: [] });
  const flows = t212ExternalCashFlows(items, acctCcy, cutoff);
  if (!flows.length) { await finish(); return 0; }
  const fx = acctCcy === "USD" ? [] : await loadUsdFx(svc, acctCcy, flows.map((x) => String(x.dateTime).slice(0, 10)).sort()[0]);
  const rows: T212Deposit[] = [];
  for (const x of flows) {
    const day = String(x.dateTime).slice(0, 10);
    const rate = acctCcy === "USD" ? 1 : rateNear(fx, day);
    if (!rate) throw new Error("Missing dated FX for deposit " + day + "; review required");
    const usd = Number(x.amount) / rate;
    if (!isFinite(usd)) throw new Error("Invalid deposit amount");
    if (usd === 0) continue;
    rows.push({ user_id: userId, broker: "T212", broker_account: account, flow_date: day, amount_usd: x.type === "WITHDRAW" ? -Math.abs(usd) : Math.abs(usd), original_currency: acctCcy, original_amount: x.type === "WITHDRAW" ? -Math.abs(Number(x.amount)) : Math.abs(Number(x.amount)), source: "api", ext_id: t212CashId(account, x) });
  }
  if (!rows.length) { await finish(); return 0; }
  const stored: T212Deposit[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("deposits").select("id,ext_id,api_reference,source,broker_account,flow_date,amount_usd,original_currency,original_amount").eq("user_id", userId).eq("broker", "T212").order("id").range(from, from + 999);
    if (error) throw error;
    stored.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const { fresh, links } = matchT212CashStatements(rows, stored, account);
  for (const link of links) {
    const { data, error } = await svc.from("deposits").update({ api_reference: link.api_reference }).eq("user_id", userId).eq("id", link.id).is("api_reference", null).select("id");
    if (error) throw error;
    if (data?.length !== 1) throw new Error("Cash flow changed during sync; retry required");
  }
  if (fresh.length) {
    const { error } = await svc.from("deposits").insert(fresh);
    if (error) throw new Error(`deposits insert failed: ${error.message}`);
  }
  await finish();
  return fresh.length;
}

// Import the user's real dividend history from the T212 API into the dividends table.
// Amounts come in the account currency (CZK) → converted to USD. Newest-first, so we stop
// once a page is fully already-imported. The import RPC runs under app.bulk_import so the
// dividend cash-trigger doesn't re-credit cash (the API cash balance already includes it).
async function syncDividendsFromApi(svc: T212Client, userId: string, account: string, t212: (p: string) => Promise<Response>, summary: T212Summary) {
  // `amount` is in the account's primary currency (T212 HistoryDividendItem).
  const acctCcy = summary?.currency || "CZK";
  if (acctCcy !== "USD" && acctCcy !== "CZK") return 0;
  const { data: existing, error: exErr } = await svc.from("dividends").select("ext_id").eq("user_id", userId).eq("broker", "T212").not("ext_id", "is", null);
  if (exErr) throw new Error(`dividends read failed: ${exErr.message}`);
  const seen = new Set((existing ?? []).map((d) => d.ext_id));
  const { data: aliasRows, error: aErr } = await svc.from("ticker_alias").select("alias,canonical");
  if (aErr) throw new Error(`ticker_alias read failed: ${aErr.message}`);
  const alias = new Map((aliasRows ?? []).map((a) => [a.alias, a.canonical]));
  const fresh: T212Dividend[] = [];
  const endpoint = "/equity/history/dividends";
  let path: string | null = `${endpoint}?limit=50`;
  for (let g = 0; g < 25 && path; g++) {
    const r = await t212(path);
    if (!r.ok) { console.warn(`sync-broker: dividends HTTP ${r.status} - dividends import stopped`); break; }
    const j = await r.json();
    const items = j.items ?? [];
    if (!items.length) break;
    let allSeen = true;
    for (const it of items) {
      const ref = `t212:div:${account}:${it.reference}`;
      if (seen.has(ref)) continue;
      allSeen = false;
      fresh.push({ ...it, ref });
    }
    if (allSeen) break; // reached the already-imported region (API is newest-first)
    path = t212NextPage(j.nextPagePath, endpoint);
  }
  // Each dividend at ITS payment day's USD rate, not today's.
  const days = fresh.map((it) => String(it.paidOn ?? "").slice(0, 10)).filter(Boolean).sort();
  const fx = acctCcy === "USD" || !days.length ? [] : await loadUsdFx(svc, acctCcy, days[0]);
  const rows: { ticker: string; ex_date: string; pay_date: string; amount_per_share: number; shares_held: number; total_amount_usd: number; ext_id: string }[] = [];
  const queued = new Set<string>();
  for (const it of fresh) {
    if (queued.has(it.ref)) continue; // the same item on two pages would fail the unique index
    const base = stripT212(it.ticker);
    const ticker = alias.get(base) ?? RENAME[base] ?? base;
    const day = String(it.paidOn ?? "").slice(0, 10);
    if (!day) continue;
    const rate = acctCcy === "USD" ? 1 : rateNear(fx, day);
    if (!rate) { console.warn(`sync-broker: no USD${acctCcy} rate for ${day} - dividend skipped`); continue; }
    const total = Number(it.amount) / rate;
    const qty = Number(it.quantity) || 0;
    if (!isFinite(total)) continue;
    queued.add(it.ref);
    rows.push({ ticker, ex_date: day, pay_date: day, amount_per_share: qty > 0 ? total / qty : (Number(it.grossAmountPerShare) || 0), shares_held: qty, total_amount_usd: total, ext_id: it.ref });
  }
  if (rows.length) {
    const { error } = await svc.rpc("import_broker_dividends", { p_user_id: userId, p_broker: "T212", p_rows: rows });
    if (error) throw new Error(`import_broker_dividends: ${error.message}`);
  }
  return rows.length;
}

// Fetch the broker's live portfolio as [{ticker, qty, avg}] (tickers mapped via the ISIN
// alias cache, like the order import). This is the truth for what's CURRENTLY held.
//
// THROWS when T212 does not answer with a portfolio. A failed call (429, 5xx) is not an
// empty portfolio: reconciling against [] sells every position of the account to zero and
// deletes it. Callers skip the reconcile instead, exactly like auto-sync does.
async function fetchPortfolioHjson(svc: T212Client, t212: (p: string) => Promise<Response>) {
  const pr = await t212("/equity/portfolio");
  if (!pr.ok) throw new Error(`Trading 212 /equity/portfolio HTTP ${pr.status}`);
  const holdings: T212Holding[] = await pr.json();
  if (!Array.isArray(holdings)) throw new Error("Trading 212 /equity/portfolio: neočekávaná odpověď");
  const pBases = [...new Set(holdings.map((h) => stripT212(h.ticker)))];
  const { data: pAlias } = pBases.length ? await svc.from("ticker_alias").select("alias,canonical").in("alias", pBases) : { data: [] };
  const pMap = new Map<string, string>();
  for (const r of (pAlias ?? [])) pMap.set(r.alias, r.canonical);
  return holdings.filter((h) => Number(h.quantity) > 0).map((h): T212PortfolioHolding => {
    const b = stripT212(h.ticker);
    return { ticker: pMap.get(b) ?? RENAME[b] ?? b, qty: Number(h.quantity), avg: Number(h.averagePrice), cur: Number(h.currentPrice), usdQuoted: /_US_EQ$/.test(String(h.ticker)) };
  });
}

// Reconcile the CONNECTED T212 account to its live portfolio. Statement imports can carry
// artifacts the broker no longer holds — pie-migration phantom buys (a huge buy with no
// matching sell), or tiny GB/pie positions whose closing sells aren't in the statement.
// The broker's portfolio is the truth for what that ACCOUNT currently holds, so we add a
// per-ticker correction (t212:adj:<account>:*) = brokerQty − that account's net.
//
// Everything is scoped to (broker='T212', broker_account=<connected account>). That scope
// is the whole point: the user may hold a SECOND T212 account whose history was imported
// from statements, plus Revolut/XTB/manual buys of the same tickers. Reconciling against
// the connected account's portfolio while counting all of them zeroed every ticker the
// other account held and subtracted its shares from the shared ones.
async function reconcileT212Holdings(svc: T212Client, userId: string, account: string, hjson: T212PortfolioHolding[]) {
  // USD average cost (never a native GBX/EUR number as USD) + the ticker-rename guard (only
  // between tickers linked by alias/ISIN, never by equal quantity alone) - shared with
  // auto-sync, see prepareReconcileHoldings in _shared/t212.ts.
  const holdings = await prepareReconcileHoldings(svc, userId, account, hjson);
  const { error } = await svc.rpc("reconcile_broker_account", {
    p_user_id: userId, p_broker: "T212", p_account: account,
    p_holdings: holdings, p_note: "Dorovnání podle Trading 212",
  });
  if (error) throw new Error(`reconcile_broker_account: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const started = Date.now();
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: userData } = await userClient.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return json({ error: "Not authenticated" }, 401);

    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: keyRows } = await svc.rpc("get_broker_key", { p_user_id: userId, p_broker: "T212" });
    const conn = (keyRows as T212Key[])?.[0];
    if (!conn?.api_key) return json({ error: "Trading 212 není připojeno" }, 400);

    if (conn.environment !== "live") return json({ error: "practice_account", code: "practice_account" });
    const base = "https://live.trading212.com/api/v0";
    const basic = "Basic " + btoa(conn.api_key);
    const t212 = async (path: string) => {
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${base}${path}`, { headers: { Authorization: basic, Accept: "application/json" } });
        if (r.status === 429) { await sleep(2000); continue; }
        await sleep(300);
        return r;
      }
      return new Response("", { status: 429 });
    };
    // Non-retrying variant for the big paginated history pulls (dividends, transactions):
    // on a 429 it returns immediately so the caller stops and keeps what it has, instead of
    // burning 6×2s per rate-limited page (which made the whole sync time out).
    // Every request of the cash-flow imports must fit the 150 s function limit: past 135 s it
    // throws instead (the import then stores nothing; the next sync starts it again).
    const t212Once = (path: string) => {
      if (Date.now() - started > 135_000) return Promise.reject(new Error("time budget spent"));
      return fetch(`${base}${path}`, { headers: { Authorization: basic, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    };

    const body = await req.json().catch(() => ({}));
    const cashR = await t212("/equity/account/cash");
    if (!cashR.ok) return json({ error: `Trading 212 odmítlo klíč (HTTP ${cashR.status}). Zapni API v Settings → API a použij secret klíč.` });
    const cashJson = await cashR.json();

    // Store the authoritative account summary (true value/P&L/deposits source) and, crucially,
    // WHICH T212 account this key belongs to. Everything below is scoped to that account, so
    // a second T212 account imported from statements is never touched by this sync.
    const infoR = await t212("/equity/account/info");
    const info = infoR.ok ? await infoR.json() : null;
    // Fall back to the last known currency/account when /account/info is throttled (429), so
    // a rate-limited call can't drop the currency to null. The shared syncCashFromApi refuses
    // to guess USD, so a null currency would otherwise silently skip the cash mirror.
    const { data: prevConn, error: prevError } = await svc.from("broker_connections").select("account_summary, account_id, environment").eq("user_id", userId).eq("broker", "T212").maybeSingle();
    if (prevError) throw prevError;
    if (!prevConn || prevConn.environment !== conn.environment) return json({ error: "Connection changed; retry" }, 409);
    // On first sync, the key prefix identifies the account even if info is throttled.
    // A stored id takes precedence over that fallback; a returned id still goes through the switch guard.
    const account = String(info?.id ?? prevConn.account_id ?? /^\d+/.exec(conn.api_key)?.[0] ?? "") || null;
    const currency = info?.currencyCode ?? (account === prevConn.account_id ? prevConn.account_summary?.currency : null) ?? null;
    const guard = t212AccountGuard(conn.environment, prevConn.account_id, account, body?.confirmAccount);
    if (guard) return json({ error: guard, code: guard, account });
    const switched = prevConn.account_id !== account;
    if (switched) {
      // The trigger clears the previous account's state before storing this account's summary.
      const update = svc.from("broker_connections").update({ account_id: account }).eq("user_id", userId).eq("broker", "T212");
      const { data: changed, error: switchError } = await (prevConn.account_id == null
        ? update.is("account_id", null) : update.eq("account_id", prevConn.account_id)).select("id");
      if (switchError) throw switchError;
      if (changed?.length !== 1) return json({ error: "Connection changed; retry" }, 409);
      conn.last_sync_cursor = null;
    }
    const summary = { ...cashJson, currency, account, at: new Date().toISOString() };
    const { error: summaryError } = await svc.from("broker_connections").update({ account_summary: summary, account_id: account }).eq("user_id", userId).eq("broker", "T212");
    if (summaryError) throw summaryError;
    if (!account) return json({ error: "Nepodařilo se zjistit číslo účtu Trading 212 — synchronizace zastavena, aby nepřepsala data jiného účtu." });

    if (body?.test) return json({ ok: true, test: true, cash: cashJson, account });

    // Resume point: client sends restart=true for a fresh full import.
    const restart = !!body?.restart;
    let cursor: string | null = restart ? null : (conn.last_sync_cursor ?? null);
    const isFirstBatch = restart || !conn.last_sync_cursor;

    // Adopt legacy rows written before per-account scoping existed. They are only safe to
    // claim for THIS account when no other T212 account is present in the data — otherwise
    // we cannot tell whose they are, and guessing is what corrupted the portfolio before.
    const { data: acctRows } = await svc.from("transactions")
      .select("broker_account").eq("user_id", userId).eq("broker", "T212").neq("ticker", "CASH");
    const foreign = new Set((acctRows ?? []).map((r) => r.broker_account).filter((a) => a && a !== account));
    const hasUntagged = (acctRows ?? []).some((r) => !r.broker_account);
    if (hasUntagged && foreign.size === 0) {
      await svc.from("transactions").update({ broker_account: account })
        .eq("user_id", userId).eq("broker", "T212").is("broker_account", null);
    } else if (hasUntagged) {
      // Ambiguous: rows of another T212 account exist alongside untagged ones. Refuse rather
      // than reconcile — a wrong guess deletes real holdings.
      await svc.from("broker_connections").update({ status: "nutný re-import výpisů (neznámý účet)" }).eq("user_id", userId).eq("broker", "T212");
      return json({ error: `V datech jsou T212 transakce bez určeného účtu i transakce jiného účtu (${[...foreign].join(", ")}). Naimportuj výpisy znovu, ať je jasné, kam patří — synchronizace se zastavila, aby nic nepřepsala.` });
    }

    // History model (planT212History in _shared/t212.ts). If this ACCOUNT has T212 trades
    // from its broker statement (t212:act:*) or entered manually, that is the authoritative
    // history and the API only APPENDS orders executed after its latest trade. Users with no
    // such trades fall back to the full API import. API fills (t212:ord:*) and reconcile
    // adjustments (t212:adj:*) never switch the mode and never move the deletion cutoff —
    // they did, and a manual sync then deleted every order an earlier sync had pulled.
    const stored = await loadT212AccountTrades(svc, userId, account);
    const plan = planT212History(stored, { resuming: !!conn.last_sync_cursor });
    const statementMode = plan.statementMode;
    // Defensive: drop API orders the statement covers (left by an older full sync, or by a
    // statement imported after them) — keeping them would double-count.
    // Only within the statement's own period: fills before its first trade are not covered.
    if (statementMode && isFirstBatch && plan.statementCutoff && plan.statementStart) {
      const { error: delErr } = await svc.from("transactions").delete()
        .eq("user_id", userId).eq("broker", "T212").eq("broker_account", account)
        .like("ext_id", "t212:ord:%").gte("executed_at", plan.statementStart).lte("executed_at", plan.statementCutoff);
      if (delErr) return json({ error: `Nepodařilo se uklidit obchody pokryté výpisem: ${delErr.message}` });
    }

    // Pull a batch of order pages within the time budget.
    const raw: T212RawFill[] = [];
    let firstOfThisCall = true;
    let done = false;
    while (Date.now() - started < TIME_BUDGET_MS) {
      const r = await t212(`/equity/history/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : `?limit=50`}`);
      if (!r.ok) { if (firstOfThisCall) return json({ error: `T212 orders HTTP ${r.status}` }); break; }
      firstOfThisCall = false;
      const j = await r.json();
      for (const it of (j.items ?? [])) {
        const fill = parseT212OrderItem(it);
        if (fill) raw.push(fill);
      }
      // Statement mode: the order history is newest-first, so once a page reaches an
      // order we already have, everything beyond is a duplicate — stop paging instead of
      // pulling the whole (rate-limited) history.
      const pageTimes = (j.items ?? []).map(t212ItemTime);
      if (reachedPageStop(pageTimes, plan)) { done = true; break; }
      cursor = j.nextPagePath ? new URL(j.nextPagePath, base).searchParams.get("cursor") : null;
      if (!cursor) { done = true; break; }
    }

    // Current ticker via ISIN (cached globally) and the USD price of every fill.
    const { rows, unpriced } = await priceT212Fills(svc, raw);
    // A fill that cannot be priced in USD must STOP the sync rather than be skipped: once newer
    // orders are stored, the next run pages only down to them and the skipped trade would be
    // missing from FIFO and taxes for good. Nothing of this batch has been written yet.
    // Only fills that would actually be stored block (see blockingUnpricedFills).
    const blocking = blockingUnpricedFills(unpriced, stored, plan, isFirstBatch && !statementMode);
    if (blocking.length) {
      return json({ error: `Nelze určit cenu v USD u ${blocking.length} obchod(ů): ${blocking.slice(0, 5).map((u) => u.label).join(", ")}. Doplň ticker_alias.yahoo_symbol a zkus to znovu — synchronizace nic nezapsala.` });
    }

    // In statement mode only orders after the statement cutoff, minus any the statement
    // already records under a different id (see selectT212OrdersToInsert). Orders already
    // stored are passed on too: the RPC skips their ext_id (ON CONFLICT DO NOTHING).
    const toInsert = selectT212OrdersToInsert(rows, stored, plan);

    // Append this batch (full-replace only for pure-API users on the first batch, and even
    // then only this account's rows). Recalc deferred to the end.
    const { error: impErr } = await svc.rpc("import_broker_transactions", { p_user_id: userId, p_broker: "T212", p_rows: toInsert, p_replace: isFirstBatch && !statementMode, p_recalc: false, p_account: account });
    if (impErr) return json({ error: `Uložení obchodů selhalo: ${impErr.message}` });

    if (!done) {
      await svc.from("broker_connections").update({ last_sync_cursor: cursor, status: "importuji…" }).eq("user_id", userId).eq("broker", "T212");
      return json({ ok: true, done: false, batch: rows.length });
    }

    // Finished. In statement mode the statement is the source of truth for positions;
    // just recalc the tickers we appended to (empty rows + p_recalc just runs recalc).
    if (statementMode) {
      await svc.rpc("import_broker_transactions", { p_user_id: userId, p_broker: "T212", p_rows: [], p_replace: false, p_recalc: true, p_account: account });
      // Reconcile THIS ACCOUNT's positions to the live broker portfolio (removes statement
      // artifacts like pie phantoms the broker no longer holds). Best-effort: when T212 does
      // not return the portfolio the previous adjustments stay as they are.
      let reconciled = false;
      try { await reconcileT212Holdings(svc, userId, account, await fetchPortfolioHjson(svc, t212)); reconciled = true; } catch (e) { console.warn("sync-broker: reconcile skipped —", (e as Error).message); }
      // Cash + deposit sync are best-effort: a failure here must not break the core sync.
      let newDeps = 0, newDivs = 0;
      try { await syncCashFromApi(svc, userId, summary); } catch (e) { console.warn("sync-broker: cash mirror failed -", (e as Error).message); }
      try { newDeps = await syncDepositsFromApi(svc, userId, account, t212Once, summary); } catch (e) { console.warn("sync-broker: deposits import failed -", (e as Error).message); }
      try { newDivs = await syncDividendsFromApi(svc, userId, account, t212Once, summary); } catch (e) { console.warn("sync-broker: dividends import failed -", (e as Error).message); }
      const status = reconciled ? "synchronizováno (výpis + API)" : "synchronizováno (výpis + API), pozice nedorovnány";
      await svc.from("broker_connections").update({ last_sync_cursor: null, last_sync_at: new Date().toISOString(), status }).eq("user_id", userId).eq("broker", "T212");
      return json({ ok: true, done: true, mode: "statement-append", appended: toInsert.length, deposits: newDeps, dividends: newDivs, reconciled });
    }

    // Pure-API user: reconcile this account to its live portfolio, clear cursor.
    let hjson: Awaited<ReturnType<typeof fetchPortfolioHjson>>;
    try {
      hjson = await fetchPortfolioHjson(svc, t212);
      await reconcileT212Holdings(svc, userId, account, hjson);
    } catch (e) {
      // The orders are stored; only the reconcile is missing. Recalc the positions from the
      // orders (the reconcile would have done it) and say so, instead of reconciling
      // against nothing and zeroing the account.
      await svc.rpc("import_broker_transactions", { p_user_id: userId, p_broker: "T212", p_rows: [], p_replace: false, p_recalc: true, p_account: account });
      await svc.from("broker_connections").update({ last_sync_cursor: null, status: "obchody staženy, pozice nedorovnány" }).eq("user_id", userId).eq("broker", "T212");
      return json({ error: `Obchody jsou stažené, ale dorovnání pozic se nepovedlo (${(e as Error).message}). Zkus synchronizaci za pár minut znovu.` });
    }
    // Cash, deposits and dividends: best-effort as in statement mode - and run here too.
    // They used to run only in statement mode, so an API-only account never got its
    // dividends or deposits (net deposits / total return were wrong for it).
    let newDeps = 0, newDivs = 0;
    try { await syncCashFromApi(svc, userId, summary); } catch (e) { console.warn("sync-broker: cash mirror failed -", (e as Error).message); }
    // This branch may follow a full 100 s order batch; stay clear of the 150 s function limit
    // (the next sync picks them up — both imports only add what is not stored yet).
    if (Date.now() - started < 115_000) {
      try { newDeps = await syncDepositsFromApi(svc, userId, account, t212Once, summary); } catch (e) { console.warn("sync-broker: deposits import failed -", (e as Error).message); }
      try { newDivs = await syncDividendsFromApi(svc, userId, account, t212Once, summary); } catch (e) { console.warn("sync-broker: dividends import failed -", (e as Error).message); }
    }
    await svc.from("broker_connections").update({ last_sync_cursor: null, last_sync_at: new Date().toISOString(), status: `${hjson.length} pozic` }).eq("user_id", userId).eq("broker", "T212");
    return json({ ok: true, done: true, positions: hjson.length, deposits: newDeps, dividends: newDivs });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
