import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  fetchFinnhub, fetchTwelveData,
  fetchCoinGecko, fetchBinance, fetchFxCzk, fetchFxUsdCzk, type Quote,
  fetchAllRows, fetchRowsBySymbols, latestCloses,
} from "../_shared/price-providers.ts";
import { cryptoBase, CRYPTO_TO_GECKO } from "../_shared/crypto.js";
import { isSchedulerToken } from "../_shared/auth.ts";

// Scheduler-only: pg_cron calls this every 10 minutes with the service-role key from Vault.
// config.toml has verify_jwt=false for it, so this check is the ONLY gate — without it
// anybody could call it in a loop and burn the Finnhub / Twelve Data / CoinGecko quotas the
// whole app shares.
Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!isSchedulerToken(req.headers.get("Authorization"), [serviceKey, Deno.env.get("CRON_SECRET")])) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
  );
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY") ?? "";
  const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";

  const started = Date.now();
  // Every user's positions and watchlist, fully paged (PostgREST caps a select at 1000 rows —
  // tickers past the cap were silently never refreshed). A failed read throws (500).
  const [positions, watch] = await Promise.all([
    fetchAllRows("positions", (f, t) => supabase.from("positions").select("ticker").neq("type", "Cash").order("id", { ascending: true }).range(f, t)),
    fetchAllRows("watchlist", (f, t) => supabase.from("watchlist").select("ticker").order("id", { ascending: true }).range(f, t)),
  ]);
  const all = Array.from(new Set([
    ...positions.map((p: any) => p.ticker),
    ...watch.map((w: any) => w.ticker),
  ])).filter((t: string) => t && t.toUpperCase() !== "CASH");

  const cryptoTickers = all.filter((t) => cryptoBase(t));
  // Stalest cache row first (never cached = oldest): Finnhub's free tier allows 60 calls/min,
  // so a large set is refreshed over consecutive runs (every 10 min) in rotation.
  const cachedRows = await fetchRowsBySymbols(all, (chunk, f, t) => supabase.from("price_cache").select("symbol,fetched_at")
    .in("symbol", chunk).order("symbol", { ascending: true }).range(f, t), "price_cache");
  const cachedAt = new Map<string, number>(cachedRows.map((r: any) => [r.symbol, new Date(r.fetched_at).getTime() || 0]));
  // Rotation by run, not by fetched_at: a ticker that never prices keeps an old fetched_at
  // and would take the front of the queue every run. Each 10-minute run starts ~55 symbols
  // further along a stable order, so every symbol is tried every ceil(n/55) runs.
  const stocksSorted = all.filter((t) => !cryptoBase(t)).sort();
  const PER_RUN = 55;
  const offset = stocksSorted.length > PER_RUN ? (Math.floor(started / 600_000) * PER_RUN) % stocksSorted.length : 0;
  const stockTickers = [...stocksSorted.slice(offset), ...stocksSorted.slice(0, offset)];

  const collected = new Map<string, Quote>();
  // Symbols Finnhub did not reach this run (pacing / 429 / time) keep their cached price for
  // the next run; only those it tried and failed, or that have no cached price at all, go to
  // the fallbacks — a day-old history close must not overwrite a fresher cached quote.
  const finnhubTried = new Set<string>();
  const missing = () => stockTickers.filter((t) => !collected.has(t) && (finnhubTried.has(t) || !cachedAt.has(t) || !finnhubKey));
  const merge = (m: Map<string, Quote>) => m.forEach((v, k) => collected.set(k, v));
  const providersUsed: Record<string, number> = {};
  const run = async (name: string, fn: () => Promise<Map<string, Quote>>) => {
    const before = collected.size;
    merge(await fn());
    providersUsed[name] = collected.size - before;
  };

  // Stocks: chain of fallbacks, each only fills what's still missing.
  // Finnhub (60/min, reliable from cloud) is primary; Twelve Data (8/min) backfills.
  // Yahoo (401) and Stooq (404) are blocked from the edge IP, so they're left out of the chain.
  // Paced to ~55 calls/min, at most 55 calls and ~70 s per run, stopping on HTTP 429.
  if (finnhubKey) await run("finnhub", () => fetchFinnhub(stockTickers, finnhubKey, {
    maxCalls: PER_RUN, minIntervalMs: 1100, deadline: started + 70_000, attempted: finnhubTried,
  }));
  if (missing().length && twelveKey) await run("twelvedata", () => fetchTwelveData(missing(), twelveKey));

  // Foreign/UCITS tickers (BARC, VUSA, CSPX, CSG, SMSN…) can't be fetched by the live
  // providers from the edge. The GitHub-Actions history worker prices them DAILY (Yahoo +
  // currency→USD) into price_history — copy its latest close into the cache for whatever is
  // still missing, so those holdings track the market (a day stale) instead of freezing at
  // whatever was last written manually.
  if (missing().length) {
    // Latest close PER SYMBOL (a global newest-first select capped at 1000 rows dropped
    // symbols whose last close was older than the others').
    let fromHistory = 0;
    try {
      const hist = await latestCloses(supabase, missing());
      for (const [symbol, r] of hist) {
        if (collected.has(symbol)) continue;
        collected.set(symbol, { price: r.close, prev: r.close, pct: 0 });
        fromHistory++;
      }
    } catch (e) {
      console.error("price_history fallback failed", (e as Error).message);
    }
    providersUsed["history"] = fromHistory;
  }

  // Crypto: CoinGecko then Binance for the rest.
  if (cryptoTickers.length) {
    const idMap: Record<string, string> = {};
    for (const t of cryptoTickers) idMap[t] = CRYPTO_TO_GECKO[cryptoBase(t)!];
    merge(await fetchCoinGecko(idMap));
    const cryptoMissing = cryptoTickers.filter((t) => !collected.has(t));
    if (cryptoMissing.length) merge(await fetchBinance(cryptoMissing.map((t) => cryptoBase(t)!)));
    // map base-symbol results back onto the app's ticker (e.g. ETHUSD)
    for (const t of cryptoTickers) {
      const base = cryptoBase(t)!;
      if (!collected.has(t) && collected.has(base)) collected.set(t, collected.get(base)!);
    }
  }

  const now = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = Array.from(collected.entries())
    .filter(([symbol]) => all.includes(symbol)) // don't store helper base symbols not actually held
    .map(([symbol, q]) => ({ symbol, price: q.price, prev_close: q.prev, change_pct: q.pct, fetched_at: now }));

  const fx = await fetchFxUsdCzk();
  if (fx) rows.push({ symbol: "USDCZK", price: fx, prev_close: null, change_pct: null, fetched_at: now });
  // CZK per euro / pound / złoty: today's rate of the app's other display currencies.
  for (const c of ["EUR", "GBP", "PLN"] as const) {
    const v = await fetchFxCzk(c);
    if (v) rows.push({ symbol: `${c}CZK`, price: v, prev_close: null, change_pct: null, fetched_at: now });
  }

  if (rows.length) await supabase.from("price_cache").upsert(rows, { onConflict: "symbol" });

  // Also append today's close to the shared price_history (keeps history current for charts, free).
  const today = now.slice(0, 10);
  const histRows = rows.filter((r: any) => Number.isFinite(Number(r.price)) && Number(r.price) > 0)
    .map((r: any) => ({ symbol: r.symbol, date: today, close: r.price }));
  if (histRows.length) await supabase.from("price_history").upsert(histRows, { onConflict: "symbol,date" });

  // "deferred" = not reached by Finnhub this run, cached price kept; refreshed on a later run.
  const deferred = stockTickers.filter((t) => !collected.has(t) && !missing().includes(t));
  const missingFinal = all.filter((t) => !collected.has(t) && !deferred.includes(t));
  return new Response(
    JSON.stringify({
      refreshed: rows.length, stocks: stockTickers.length, crypto: cryptoTickers.length,
      providersUsed, missing: missingFinal, deferred: deferred.length,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
