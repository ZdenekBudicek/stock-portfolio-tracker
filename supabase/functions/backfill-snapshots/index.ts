// Resumable, automated portfolio-history backfill — works server-side & free.
// 1) Fill the SHARED price_history table from Twelve Data (works from the edge IP,
//    unlike Yahoo). Each ticker fetched once globally, then reused by every user.
// 2) When all of the user's tickers are covered, reconstruct their daily_snapshots
//    = shares-held-that-day x close-that-day (no external calls -> fast & free).
// The client calls repeatedly until {done:true}; first run is slow, later runs are
// cheap because price_history is already populated (shared) + only new days are added.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { applySplitAdjustment, createHoldingsTimeline, isSyntheticRow } from "../_shared/history.js";
import { isCryptoHolding, twelveCryptoSymbol } from "../_shared/crypto.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dstr = (d: Date) => d.toISOString().slice(0, 10);
const TIME_BUDGET = 90_000;

// Every page of a select, in a deterministic order (PostgREST caps one select at 1000 rows and
// paging without ORDER BY can skip or repeat rows). A failed read THROWS — treating it as "no
// rows" rebuilt an empty history and then deleted the user's stored one.
async function fetchAll(label: string, page: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await page(f, f + 999);
    if (error) throw new Error(`čtení ${label} selhalo: ${error.message ?? error}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// Twelve Data symbol, or null for crypto that has no entry in the shared map. Never the
// bare ticker: Twelve Data covers US equities, so "LINK" is Interlink Electronics and
// "ATOM" is Atomera — a bare-ticker fallback writes a company's closes into the shared
// price_history table as that coin's history.
const tdSymbol = (ticker: string, type?: string | null): string | null =>
  isCryptoHolding(ticker, type) ? twelveCryptoSymbol(ticker) : ticker;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const started = Date.now();
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: ud } = await userClient.auth.getUser();
    const userId = ud.user?.id;
    if (!userId) return json({ error: "Not authenticated" }, 401);
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tdKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";

    // PostgREST caps a single select at 1000 rows; heavy accounts have far more transactions
    // (this one ~1950), so page through — otherwise tickers whose trades fall past row 1000 are
    // dropped and the reconstructed value is undercounted (the chart's spike/dip at "today").
    const txRows = await fetchAll("transactions", (f, t) => svc.from("transactions").select("ticker,side,shares,price_usd,executed_at,ext_id")
      .eq("user_id", userId).order("executed_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
    const ledger = txRows.filter((t: any) => t.ticker !== "CASH");
    const trades = ledger.filter((t: any) => !isSyntheticRow(t.ext_id));

    // Current broker-truth shares per ticker (positions table = reconciled to the broker).
    // The reconstruction is ANCHORED to these — see _shared/history.js for why.
    const posRows = await fetchAll("positions", (f, t) => svc.from("positions").select("ticker,shares,type,holding_start_date")
      .eq("user_id", userId).order("id", { ascending: true }).range(f, t));
    const positions = ((posRows ?? []) as any[]).filter((p) => p.ticker !== "CASH" && String(p.type ?? "") !== "Cash");
    if (!trades.length && !positions.length) return json({ ok: true, done: true, message: "no trades" });
    const truth = new Map<string, number>();
    for (const p of positions) truth.set(p.ticker, (truth.get(p.ticker) ?? 0) + Number(p.shares));
    // Earliest day each ticker may appear: its first ledger row of any kind, or the
    // position's own start date (holdings imported as a snapshot carry no trades).
    const firstByTicker = new Map<string, string>();
    const note = (tk: string, d: string) => { const cur = firstByTicker.get(tk); if (!cur || d < cur) firstByTicker.set(tk, d); };
    for (const t of ledger) note(t.ticker, t.executed_at.slice(0, 10));
    for (const p of positions) if (p.holding_start_date) note(p.ticker, String(p.holding_start_date).slice(0, 10));
    // Price every ticker that appears anywhere, not just the traded ones.
    const tickers = [...new Set([...firstByTicker.keys(), ...truth.keys()])];
    const globalFirst = [...firstByTicker.values()].sort()[0] ?? dstr(new Date());

    const needSymbols = [...tickers, "USDCZK"];
    // earliest stored date per symbol via aggregate RPC (a plain REST select caps at
    // 1000 rows, which mis-reported covered tickers as missing -> endless re-download).
    const { data: cov, error: covErr } = await svc.rpc("price_history_coverage", { p_symbols: needSymbols });
    if (covErr) throw new Error(`čtení pokrytí cen selhalo: ${covErr.message}`);
    const earliest = new Map<string, string>();
    for (const r of (cov ?? []) as any[]) earliest.set(r.symbol, r.earliest);
    const needsFetch = (sym: string, fromDate: string) => { const e = earliest.get(sym); return !e || e > fromDate; };

    const toFetch: string[] = [];
    for (const tk of tickers) if (needsFetch(tk, firstByTicker.get(tk) ?? globalFirst)) toFetch.push(tk);
    if (needsFetch("USDCZK", globalFirst)) toFetch.push("USDCZK");

    // A curated equity alias (ticker_alias.yahoo_symbol that is not a coin pair) pins a
    // coin-named ticker to the security — the same escape hatch the nightly worker honours,
    // e.g. ATOM held as Atomera stock.
    const { data: aliasRows, error: aliasErr } = toFetch.length
      ? await svc.from("ticker_alias").select("alias,yahoo_symbol").in("alias", toFetch)
      : { data: [] as any[], error: null };
    if (aliasErr) throw new Error(`čtení ticker_alias selhalo: ${aliasErr.message}`);
    const pinnedEquity = new Set(((aliasRows ?? []) as any[]).filter((a) => a.yahoo_symbol && !/-USD$/i.test(String(a.yahoo_symbol))).map((a) => a.alias));
    let fetched = 0; let remaining = 0;
    const skipped: string[] = [];
    for (const sym of toFetch) {
      if (Date.now() - started > TIME_BUDGET) { remaining++; continue; }
      const tdSym = sym === "USDCZK" ? "USD/CZK" : pinnedEquity.has(sym) ? sym : tdSymbol(sym, positions.find((p: any) => p.ticker === sym)?.type);
      // Known crypto with no Twelve Data symbol: skip, and deliberately do NOT write the
      // tombstone below. A tombstone makes needsFetch() permanently false, so the holding
      // would contribute 0 to every future snapshot and undercount the portfolio for good.
      if (!tdSym) { skipped.push(sym); continue; }
      try {
        const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=1day&outputsize=5000&apikey=${tdKey}`);
        const j = await r.json();
        const vals: any[] = j?.values ?? [];
        if (vals.length) {
          const rows = vals.map((v) => ({ symbol: sym, date: v.datetime, close: Number(v.close) })).filter((x) => Number.isFinite(x.close));
          let stored = true;
          for (let i = 0; i < rows.length && stored; i += 1000) {
            const { error } = await svc.from("price_history").upsert(rows.slice(i, i + 1000), { onConflict: "symbol,date" });
            if (error) stored = false;
          }
          if (stored) fetched++; else skipped.push(sym); // not stored — retry on the next run
        } else if (j?.status === "error" && /symbol|not found|invalid/i.test(String(j?.message ?? ""))) {
          // Twelve Data says it does not know this symbol (delisted/SPAC) -> mark attempted so
          // we don't retry forever. ONLY then: a tombstone makes needsFetch() false for good,
          // so writing it on a rate limit, a missing key or an empty answer would leave the
          // holding at 0 in every future snapshot.
          await svc.from("price_history").upsert([{ symbol: sym, date: "1900-01-01", close: 0 }], { onConflict: "symbol,date" });
        } else {
          skipped.push(sym); // transient (429 / outage / empty) — retry on the next run
        }
      } catch (_e) {
        skipped.push(sym); // network error — retry on the next run, never tombstone
      }
      await sleep(8000); // Twelve Data free tier: 8 credits/min
    }

    if (remaining > 0) {
      return json({ ok: true, done: false, fetched, remaining, skipped });
    }

    // all covered -> reconstruct daily_snapshots from price_history (no external calls)
    const priceRows = await fetchAll("price_history", (f, t) => svc.from("price_history").select("symbol,date,close")
      .in("symbol", needSymbols).order("symbol", { ascending: true }).order("date", { ascending: true }).range(f, t));
    const series = new Map<string, Map<string, number>>();
    for (const r of priceRows) { if (!series.has(r.symbol)) series.set(r.symbol, new Map()); series.get(r.symbol)!.set(r.date, Number(r.close)); }
    const fxSeries = series.get("USDCZK") ?? new Map();

    // Share counts come from the SHARED reconstruction, identical to the nightly worker:
    //   1) as-traded quantities converted to today's split-adjusted terms (price_history is
    //      adjusted, the ledger is not — without this every pre-split holding is undervalued
    //      by the split ratio: 20× for GOOGL, 10× for NFLX);
    //   2) today's broker-truth position walked backwards through the real dated trades.
    // Never a per-ticker scale factor — that turned a tiny correction on a mostly-sold
    // position into a huge phantom holding in the past.
    const closeAt = (tk: string, day: string) => {
      // SAME-DAY close only: the split factor is tradePrice / close, so a close from days
      // earlier turns an ordinary price move (-50 %) into a fake 1-for-2 split.
      const s = series.get(tk);
      if (!s) return null;
      for (let i = 0, ms = Date.parse(day); i < 1; i++, ms -= 86400000) {
        const c = s.get(dstr(new Date(ms)));
        if (c) return c;
      }
      return null;
    };
    const { trades: tradeEvents, adjusted, unverified } = applySplitAdjustment(
      trades.map((t: any) => ({
        ticker: t.ticker,
        day: t.executed_at.slice(0, 10),
        signed: t.side === "BUY" ? Number(t.shares) : -Number(t.shares),
        price: Number(t.price_usd),
      })),
      closeAt, truth,
    );
    const timeline = createHoldingsTimeline(tradeEvents, truth, firstByTicker);
    const lastClose = new Map<string, number>();

    // The daily cash balance is RECORDED, never recomputed — carry it across the rebuild, and
    // keep a row for a cash-only day (everything sold), or the cleanup below deletes its cash.
    const prevCash = await fetchAll("daily_snapshots", (f, t) => svc.from("daily_snapshots").select("snapshot_date,cash_usd")
      .eq("user_id", userId).not("cash_usd", "is", null).order("snapshot_date", { ascending: true }).range(f, t));
    const cashByDay = new Map<string, number>();
    for (const r of prevCash) { const c = Number(r.cash_usd); if (Number.isFinite(c)) cashByDay.set(String(r.snapshot_date).slice(0, 10), c); }
    const firstCash = [...cashByDay.keys()].sort()[0];
    const loopFirst = firstCash && firstCash < globalFirst ? firstCash : globalFirst;

    let lastFx = 23;
    const snaps: any[] = [];
    const todayMs = Date.now();
    // Iterate in UTC milliseconds — stepping a local Date by one day skips/repeats a day
    // across a DST boundary.
    for (let ms = Date.parse(loopFirst); ms <= todayMs; ms += 86400000) {
      const day = dstr(new Date(ms));
      const held = timeline.advanceTo(day);
      if (fxSeries.has(day)) lastFx = fxSeries.get(day)!;
      let val = 0;
      for (const [tk, qty] of held) {
        if (qty <= 1e-9) continue;
        const sc = series.get(tk);
        if (sc?.has(day)) lastClose.set(tk, sc.get(day)!);
        const c = lastClose.get(tk);
        if (c) val += qty * c;
      }
      // HOLDINGS value only — cash is NOT added here. The chart shows the value of the
      // positions over time and states the cash balance separately; inventing a cash history
      // (a flat constant, or one scaled by deposits) puts money in the past that was never
      // there. `daily-snapshot-cron` stores the same holdings-only figure.
      // cash_usd on EVERY row (null where not tracked) — PostgREST rejects a bulk insert whose
      // objects do not all carry the same keys, which truncates the rebuild mid-way.
      const cash = cashByDay.get(day) ?? null;
      if (val > 0 || cash != null) snaps.push({ user_id: userId, snapshot_date: day, value_usd: Math.round(val * 100) / 100, value_czk: Math.round(val * lastFx * 100) / 100, cash_usd: cash, profit_usd: 0, profit_pct: 0, profit_czk: 0, fx_rate: lastFx });
    }
    // Never replace a stored history with an empty one.
    if (!snaps.length) return json({ error: "Z dostupných dat nevyšel žádný den historie — uložená historie zůstává beze změny." }, 500);

    // Overwrite day by day (upsert) instead of delete-then-insert: a failed batch leaves the
    // previous history in place, not a truncated one. Days the rebuild no longer produces are
    // deleted only after every batch was written.
    let written = 0;
    for (let i = 0; i < snaps.length; i += 500) {
      const chunk = snaps.slice(i, i + 500);
      const { error } = await svc.from("daily_snapshots").upsert(chunk, { onConflict: "user_id,snapshot_date" });
      if (error) return json({ error: `Historie se zapsala jen zčásti (${written} z ${snaps.length} dní, starší data ponechána): ${error.message}` }, 500);
      written += chunk.length;
    }
    const keep = new Set(snaps.map((s) => s.snapshot_date));
    const existing = await fetchAll("daily_snapshots", (f, t) => svc.from("daily_snapshots").select("snapshot_date")
      .eq("user_id", userId).order("snapshot_date", { ascending: true }).range(f, t));
    const gone = existing.map((r) => String(r.snapshot_date).slice(0, 10)).filter((d) => !keep.has(d));
    for (let i = 0; i < gone.length; i += 100) {
      const { error } = await svc.from("daily_snapshots").delete().eq("user_id", userId).in("snapshot_date", gone.slice(i, i + 100));
      if (error) return json({ error: `Historie zapsána, ale úklid starých dní selhal: ${error.message}` }, 500);
    }
    return json({
      ok: true, done: true, snapshots: snaps.length,
      splitsApplied: adjusted,
      // Crypto with no Twelve Data symbol — priced at 0 in this reconstruction rather
      // than silently tombstoned. Fix the map in _shared/crypto.js and re-run.
      skipped,
      // Tickers whose ledger cannot be reconciled with the broker's share count — the chart
      // is anchored so TODAY is still right, but their past is only as good as the ledger.
      unverified,
      clampedShares: Math.round(timeline.clamped * 1e4) / 1e4,
      undatedHoldings: timeline.unknownStart,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
