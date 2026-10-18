// Trading 212 sync — RESUMABLE full order-history import that works for any volume.
// Each call pulls orders for ~100s, appends them (fast bulk insert, recalc deferred),
// and saves a cursor. The client calls repeatedly until {done:true}; the final call
// pulls /equity/portfolio and reconciles so positions are exact. Handles new users with
// hundreds/thousands of orders despite T212 throttling the server IP + the 150s limit.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { syncCashFromApi, planT212History, reachedPageStop, selectT212OrdersToInsert, t212FillPriceUsd, blockingUnpricedFills, type T212StoredTrade } from "../_shared/t212.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const RENAME: Record<string, string> = { IPOE: "SOFI", VACQ: "RKLB", FB: "META", FBA: "META" };
const stripT212 = (t: string) => t.replace(/_US_EQ$/, "").replace(/_EQ$/, "").toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME_BUDGET_MS = 100_000;

// Resolve broker base tickers -> current price-provider tickers, using the
// permanent ISIN via OpenFIGI (free, no key). Results are cached globally in
// ticker_alias so every instrument is resolved once and reused by all users.
async function resolveAliases(
  pairs: { base: string; isin: string | null; name?: string | null }[],
  svc: any,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const bases = [...new Set(pairs.map((p) => p.base))];
  if (!bases.length) return map;
  const { data: cached } = await svc.from("ticker_alias").select("alias,canonical").in("alias", bases);
  for (const r of (cached ?? []) as any[]) map.set(r.alias, r.canonical);

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
        const rows: any[] = [];
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
    if (i + 10 < jobs.length) await sleep(2500);
  }
  for (const p of pairs) if (!map.has(p.base)) map.set(p.base, RENAME[p.base] ?? p.base);
  return map;
}

// syncCashFromApi now lives in ../_shared/t212.ts so this function and auto-sync share one
// implementation (and one currency-safety guard) — see there for the rationale.

// Append real external deposits/withdrawals from the T212 API into the deposits table,
// so total-return (value − net deposits) stays correct between statement imports. T212's
// /history/transactions conflates three things under generic types, so we classify:
//   • currency conversions — a same-instant set of legs in >1 currency (CZK out + USD in,
//     often with a FEE leg). Net external flow = 0 → skipped.
//   • interest — tiny daily credits (< ~$2) → skipped.
//   • real deposits/withdrawals — an account-currency leg, alone at its timestamp, above
//     the interest threshold → recorded.
// Only flows AFTER the latest deposit we already have are added (the statement is
// authoritative up to its date; a later statement re-import wipes & replaces these).
async function syncDepositsFromApi(svc: any, userId: string, account: string, t212: (p: string) => Promise<Response>, summary: any) {
  const acctCcy = summary?.currency || "CZK";
  const { data: lastDep } = await svc.from("deposits").select("flow_date").eq("user_id", userId).eq("broker", "T212").eq("broker_account", account).order("flow_date", { ascending: false }).limit(1);
  const cutoff = lastDep?.[0]?.flow_date ?? "2000-01-01";
  let fx = 1;
  if (acctCcy !== "USD") {
    const { data } = await svc.from("price_history").select("close").eq("symbol", "USD" + acctCcy).order("date", { ascending: false }).limit(1);
    fx = Number(data?.[0]?.close) || 21;
  }
  const items: any[] = [];
  let path = "limit=50";
  for (let guard = 0; guard < 12; guard++) {
    const r = await t212("/history/transactions?" + path);
    if (!r.ok) break;
    const j = await r.json();
    const its = j.items ?? [];
    items.push(...its);
    if (its.some((x: any) => (x.dateTime ?? "").slice(0, 10) <= cutoff)) break;
    if (!j.nextPagePath) break;
    path = j.nextPagePath;
  }
  // Currencies present at each exact timestamp (a multi-currency instant = conversion).
  const tsCcy = new Map<string, Set<string>>();
  for (const x of items) { if (!tsCcy.has(x.dateTime)) tsCcy.set(x.dateTime, new Set()); tsCcy.get(x.dateTime)!.add(x.currency); }
  const rows: any[] = [];
  for (const x of items) {
    const day = (x.dateTime ?? "").slice(0, 10);
    if (day <= cutoff) continue;
    if (x.currency !== acctCcy) continue;
    if (x.type !== "DEPOSIT" && x.type !== "WITHDRAW") continue;
    if ((tsCcy.get(x.dateTime)?.size ?? 1) > 1) continue; // currency conversion leg
    const usd = x.amount / (acctCcy === "USD" ? 1 : fx);
    if (Math.abs(usd) < 2) continue; // interest / dust
    rows.push({ user_id: userId, broker: "T212", broker_account: account, flow_date: day, amount_usd: usd, source: "api", ext_id: `t212:cashtx:${account}:${x.reference}` });
  }
  if (!rows.length) return 0;
  const { data: existing } = await svc.from("deposits").select("ext_id").eq("user_id", userId).eq("broker", "T212").not("ext_id", "is", null);
  const seen = new Set((existing ?? []).map((d: any) => d.ext_id));
  const fresh = rows.filter((r) => !seen.has(r.ext_id));
  if (fresh.length) await svc.from("deposits").insert(fresh);
  return fresh.length;
}

// Import the user's real dividend history from the T212 API into the dividends table.
// Amounts come in the account currency (CZK) → converted to USD. Newest-first, so we stop
// once a page is fully already-imported. The import RPC runs under app.bulk_import so the
// dividend cash-trigger doesn't re-credit cash (the API cash balance already includes it).
async function syncDividendsFromApi(svc: any, userId: string, account: string, t212: (p: string) => Promise<Response>, summary: any) {
  const acctCcy = summary?.currency || "CZK";
  let fx = 1;
  if (acctCcy !== "USD") {
    if (acctCcy !== "CZK") return 0;
    const { data } = await svc.from("price_history").select("close").eq("symbol", "USD" + acctCcy).order("date", { ascending: false }).limit(1);
    fx = Number(data?.[0]?.close) || 21;
  }
  const { data: existing } = await svc.from("dividends").select("ext_id").eq("user_id", userId).eq("broker", "T212").not("ext_id", "is", null);
  const seen = new Set((existing ?? []).map((d: any) => d.ext_id));
  const { data: aliasRows } = await svc.from("ticker_alias").select("alias,canonical");
  const alias = new Map((aliasRows ?? []).map((a: any) => [a.alias, a.canonical]));
  const rows: any[] = [];
  let path = "limit=50";
  for (let g = 0; g < 25; g++) {
    const r = await t212("/equity/history/dividends?" + path);
    if (!r.ok) break;
    const j = await r.json();
    const items = j.items ?? [];
    if (!items.length) break;
    let allSeen = true;
    for (const it of items) {
      const ref = `t212:div:${account}:${it.reference}`;
      if (seen.has(ref)) continue;
      allSeen = false;
      const base = stripT212(it.ticker);
      const ticker = alias.get(base) ?? RENAME[base] ?? base;
      const day = (it.paidOn ?? "").slice(0, 10);
      const total = Number(it.amount) / (acctCcy === "USD" ? 1 : fx);
      const qty = Number(it.quantity) || 0;
      if (!day || !isFinite(total)) continue;
      rows.push({ ticker, ex_date: day, pay_date: day, amount_per_share: qty > 0 ? total / qty : (Number(it.grossAmountPerShare) || 0), shares_held: qty, total_amount_usd: total, ext_id: ref });
    }
    if (allSeen) break; // reached the already-imported region (API is newest-first)
    if (!j.nextPagePath) break;
    path = j.nextPagePath;
  }
  if (rows.length) await svc.rpc("import_broker_dividends", { p_user_id: userId, p_broker: "T212", p_rows: rows });
  return rows.length;
}

// Fetch the broker's live portfolio as [{ticker, qty, avg}] (tickers mapped via the ISIN
// alias cache, like the order import). This is the truth for what's CURRENTLY held.
//
// THROWS when T212 does not answer with a portfolio. A failed call (429, 5xx) is not an
// empty portfolio: reconciling against [] sells every position of the account to zero and
// deletes it. Callers skip the reconcile instead, exactly like auto-sync does.
async function fetchPortfolioHjson(svc: any, t212: (p: string) => Promise<Response>) {
  const pr = await t212("/equity/portfolio");
  if (!pr.ok) throw new Error(`Trading 212 /equity/portfolio HTTP ${pr.status}`);
  const holdings: any[] = await pr.json();
  if (!Array.isArray(holdings)) throw new Error("Trading 212 /equity/portfolio: neočekávaná odpověď");
  const pBases = [...new Set(holdings.map((h) => stripT212(h.ticker)))];
  const { data: pAlias } = pBases.length ? await svc.from("ticker_alias").select("alias,canonical").in("alias", pBases) : { data: [] };
  const pMap = new Map<string, string>();
  for (const r of (pAlias ?? []) as any[]) pMap.set(r.alias, r.canonical);
  return holdings.filter((h) => Number(h.quantity) > 0).map((h) => {
    const b = stripT212(h.ticker);
    return { ticker: pMap.get(b) ?? RENAME[b] ?? b, qty: Number(h.quantity), avg: Number(h.averagePrice), cur: Number(h.currentPrice) };
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
async function reconcileT212Holdings(
  svc: any, userId: string, account: string,
  hjson: { ticker: string; qty: number; avg: number; cur?: number }[],
) {
  const { data: pcRows } = await svc.from("price_cache").select("symbol,price");
  const pxMap = new Map<string, number>((pcRows ?? []).map((r: any) => [r.symbol, Number(r.price)]));
  // The broker's averagePrice is in the instrument's native currency (GBp/EUR/CZK…).
  // Scale it by the avg/current RATIO (currency-free) onto our USD price so the adjustment
  // carries a sane USD cost: avg_usd = ourUsdPrice × (broker.avg / broker.current).
  let holdings = hjson.filter((h) => h.qty > 0).map((h) => {
    const usd = pxMap.get(h.ticker);
    const avgUsd = h.cur && h.cur > 0 && usd && usd > 0 ? Math.round(usd * (h.avg / h.cur) * 1e6) / 1e6 : h.avg;
    return { ticker: h.ticker, qty: h.qty, avg: avgUsd };
  });

  // Ticker-rename guard. The portfolio endpoint can label an instrument with a different
  // symbol than the order history does (Barclays "BARCL" vs "BARC", Grab "AGC" vs "GRAB"),
  // which would zero the real position AND create a phantom one under the other symbol.
  // When a broker-only ticker and a trades-only ticker carry the SAME quantity they are the
  // same instrument: relabel the snapshot to the ticker the trades already use.
  const net = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data: txs } = await svc.from("transactions")
      .select("ticker,side,shares").eq("user_id", userId).eq("broker", "T212")
      .eq("broker_account", account).neq("ticker", "CASH")
      .not("ext_id", "like", "t212:adj:%") // last run's corrections aren't part of the net
      .range(from, from + 999);
    if (!txs || txs.length === 0) break;
    for (const t of txs) net.set(t.ticker, (net.get(t.ticker) ?? 0) + (t.side === "BUY" ? 1 : -1) * Number(t.shares));
    if (txs.length < 1000) break;
  }
  const reported = new Set(holdings.map((h) => h.ticker));
  const orphanTrades = [...net].filter(([tk, q]) => q > 1e-4 && !reported.has(tk));
  const taken = new Set<string>();
  holdings = holdings.map((h) => {
    if (net.has(h.ticker)) return h;
    const m = orphanTrades.find(([tk, q]) => !taken.has(tk) && Math.abs(q - h.qty) < 1e-4);
    if (!m) return h;
    taken.add(m[0]);
    return { ...h, ticker: m[0] };
  });

  const { error } = await svc.rpc("reconcile_broker_account", {
    p_user_id: userId, p_broker: "T212", p_account: account,
    p_holdings: holdings, p_note: "Dorovnání podle Trading 212",
  });
  if (error) throw new Error(`reconcile_broker_account: ${error.message}`);
}

// Every non-cash row of this account that the history model needs (ext_id decides its kind,
// the rest is the content key of the statement-duplicate guard). PAGED: PostgREST caps a
// plain select at 1000 rows and a statement import alone can write ~2000.
//
// THROWS on a failed read. An empty result would look like a pure-API account, and the
// first batch of a pure-API sync REPLACES the account's whole t212:* history — including
// the statement rows a failed read did not see.
async function loadAccountTrades(svc: any, userId: string, account: string): Promise<T212StoredTrade[]> {
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
    const conn = (keyRows as any[])?.[0];
    if (!conn?.api_key) return json({ error: "Trading 212 není připojeno" }, 400);

    const base = conn.environment === "demo" ? "https://demo.trading212.com/api/v0" : "https://live.trading212.com/api/v0";
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
    const t212Once = (path: string) => fetch(`${base}${path}`, { headers: { Authorization: basic, Accept: "application/json" } });

    const body = await req.json().catch(() => ({}));
    const cashR = await t212("/equity/account/cash");
    if (!cashR.ok) return json({ error: `Trading 212 odmítlo klíč (HTTP ${cashR.status}). Zapni API v Settings → API a použij secret klíč.` });
    const cashJson = await cashR.json();

    // Store the authoritative account summary (true value/P&L/deposits source) and, crucially,
    // WHICH T212 account this key belongs to. Everything below is scoped to that account, so
    // a second T212 account imported from statements is never touched by this sync. The key
    // itself is "<accountId><secret>", which is the fallback when /account/info is throttled.
    const infoR = await t212("/equity/account/info");
    const info = infoR.ok ? await infoR.json() : null;
    // Fall back to the last known currency/account when /account/info is throttled (429), so
    // a rate-limited call can't drop the currency to null. The shared syncCashFromApi refuses
    // to guess USD, so a null currency would otherwise silently skip the cash mirror.
    const { data: prevConn } = await svc.from("broker_connections").select("account_summary, account_id").eq("user_id", userId).eq("broker", "T212").maybeSingle();
    const currency = info?.currencyCode ?? prevConn?.account_summary?.currency ?? null;
    const account = String(info?.id ?? prevConn?.account_id ?? (/^\d+/.exec(conn.api_key)?.[0] ?? "")) || null;
    const summary = { ...cashJson, currency, account, at: new Date().toISOString() };
    await svc.from("broker_connections").update({ account_summary: summary, account_id: account }).eq("user_id", userId).eq("broker", "T212");
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
    const foreign = new Set((acctRows ?? []).map((r: any) => r.broker_account).filter((a: any) => a && a !== account));
    const hasUntagged = (acctRows ?? []).some((r: any) => !r.broker_account);
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
    const stored = await loadAccountTrades(svc, userId, account);
    const plan = planT212History(stored, { resuming: !!conn.last_sync_cursor });
    const statementMode = plan.statementMode;
    // Defensive: drop API orders the statement covers (left by an older full sync, or by a
    // statement imported after them) — keeping them would double-count.
    if (statementMode && isFirstBatch && plan.statementCutoff) {
      const { error: delErr } = await svc.from("transactions").delete()
        .eq("user_id", userId).eq("broker", "T212").eq("broker_account", account)
        .like("ext_id", "t212:ord:%").lte("executed_at", plan.statementCutoff);
      if (delErr) return json({ error: `Nepodařilo se uklidit obchody pokryté výpisem: ${delErr.message}` });
    }

    // Pull a batch of order pages within the time budget.
    const raw: any[] = [];
    let firstOfThisCall = true;
    let done = false;
    while (Date.now() - started < TIME_BUDGET_MS) {
      const r = await t212(`/equity/history/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : `?limit=50`}`);
      if (!r.ok) { if (firstOfThisCall) return json({ error: `T212 orders HTTP ${r.status}` }); break; }
      firstOfThisCall = false;
      const j = await r.json();
      for (const it of (j.items ?? [])) {
        if (it.order?.status !== "FILLED" || !it.fill) continue;
        const q = Number(it.fill.quantity);
        raw.push({
          base: stripT212(it.order.ticker), isin: it.order.instrument?.isin ?? null, name: it.order.instrument?.name ?? null,
          side: q < 0 || it.order.side === "SELL" ? "SELL" : "BUY",
          shares: Math.abs(q), price_usd: Number(it.fill.price), fee_usd: 0,
          inst_ccy: it.order.instrument?.currency ?? it.order.currency ?? null,
          wallet_ccy: it.fill.walletImpact?.currency ?? null,
          wallet_net: it.fill.walletImpact?.netValue != null ? Number(it.fill.walletImpact.netValue) : null,
          executed_at: it.fill.filledAt ?? it.order.dateModified ?? it.order.createdAt,
          ext_id: `t212:ord:${it.fill.id}`,
        });
      }
      // Statement mode: the order history is newest-first, so once a page reaches an
      // order we already have, everything beyond is a duplicate — stop paging instead of
      // pulling the whole (rate-limited) history.
      const pageTimes = (j.items ?? []).map((it: any) => it.fill?.filledAt ?? it.order?.dateModified ?? it.order?.createdAt);
      if (reachedPageStop(pageTimes, plan)) { done = true; break; }
      cursor = j.nextPagePath ? new URL(j.nextPagePath, base).searchParams.get("cursor") : null;
      if (!cursor) { done = true; break; }
    }

    // Resolve every instrument's current ticker via ISIN (cached globally), then build rows.
    const aliasMap = await resolveAliases(raw.map((x) => ({ base: x.base, isin: x.isin, name: x.name })), svc);
    // fill.price is in the INSTRUMENT currency; only USD instruments can take it as USD.
    // Everything else is priced from walletImpact (account currency) — see t212FillPriceUsd.
    const nonUsd = raw.filter((x) => String(x.inst_ccy ?? "USD").toUpperCase() !== "USD");
    let usdCzkOn: (d: string) => number | null = () => null;
    if (nonUsd.length) {
      const from = nonUsd.map((x) => String(x.executed_at).slice(0, 10)).sort()[0];
      const fromWithMargin = new Date(Date.parse(from) - 14 * 86400000).toISOString().slice(0, 10);
      const fx: { date: string; close: number }[] = [];
      for (let f = 0; ; f += 1000) {
        const { data, error } = await svc.from("price_history").select("date,close").eq("symbol", "USDCZK")
          .gte("date", fromWithMargin).order("date", { ascending: true }).range(f, f + 999);
        if (error) throw new Error(`USDCZK read failed: ${error.message}`);
        fx.push(...((data ?? []) as any[]).map((r) => ({ date: r.date, close: Number(r.close) })));
        if ((data ?? []).length < 1000) break;
      }
      usdCzkOn = (d: string) => { let best: number | null = null; for (const r of fx) { if (r.date <= d) best = r.close; else break; } return best; };
    }
    const rows: any[] = [];
    const unpriced: { label: string; executed_at: string; ext_id: string }[] = [];
    for (const x of raw) {
      const ticker = aliasMap.get(x.base) ?? RENAME[x.base] ?? x.base;
      const day = String(x.executed_at).slice(0, 10);
      let close: number | null | undefined;
      const closeUsdOn = () => close ?? null;
      // Every non-USD fill gets the day's USD close as a fallback — also CZK/USD wallets,
      // whose primary path can still miss (no netValue, no USD/CZK rate for that day).
      if (String(x.inst_ccy ?? "USD").toUpperCase() !== "USD") {
        const { data } = await svc.from("price_history").select("close").eq("symbol", ticker).lte("date", day).gt("close", 0).order("date", { ascending: false }).limit(1);
        close = data?.[0]?.close != null ? Number(data[0].close) : null;
      }
      const priceUsd = t212FillPriceUsd(
        { instrumentCurrency: x.inst_ccy, price: x.price_usd, quantity: x.shares, walletCurrency: x.wallet_ccy, walletNetValue: x.wallet_net },
        usdCzkOn, closeUsdOn, day,
      );
      if (priceUsd == null) { unpriced.push({ label: `${ticker} ${day} (${x.inst_ccy})`, executed_at: x.executed_at, ext_id: x.ext_id }); continue; }
      rows.push({ ticker, side: x.side, shares: x.shares, price_usd: priceUsd, fee_usd: x.fee_usd, executed_at: x.executed_at, ext_id: x.ext_id, note: null });
    }
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
      try { await syncCashFromApi(svc, userId, summary); } catch (_e) { /* keep going */ }
      try { newDeps = await syncDepositsFromApi(svc, userId, account, t212Once, summary); } catch (_e) { /* keep going */ }
      try { newDivs = await syncDividendsFromApi(svc, userId, account, t212Once, summary); } catch (_e) { /* keep going */ }
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
    try { await syncCashFromApi(svc, userId, summary); } catch (_e) { /* best-effort */ }
    await svc.from("broker_connections").update({ last_sync_cursor: null, last_sync_at: new Date().toISOString(), status: `${hjson.length} pozic` }).eq("user_id", userId).eq("broker", "T212");
    return json({ ok: true, done: true, positions: hjson.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
