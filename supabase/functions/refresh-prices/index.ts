import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  fetchFinnhub, fetchTwelveData,
  fetchCoinGecko, fetchBinance, fetchFxUsdCzk, type Quote,
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

  const [{ data: positions }, { data: watch }] = await Promise.all([
    supabase.from("positions").select("ticker").neq("type", "Cash"),
    supabase.from("watchlist").select("ticker"),
  ]);
  const all = Array.from(new Set([
    ...(positions ?? []).map((p: any) => p.ticker),
    ...(watch ?? []).map((w: any) => w.ticker),
  ])).filter((t: string) => t && t.toUpperCase() !== "CASH");

  const cryptoTickers = all.filter((t) => cryptoBase(t));
  const stockTickers = all.filter((t) => !cryptoBase(t));

  const collected = new Map<string, Quote>();
  const missing = () => stockTickers.filter((t) => !collected.has(t));
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
  if (finnhubKey) await run("finnhub", () => fetchFinnhub(stockTickers, finnhubKey));
  if (missing().length && twelveKey) await run("twelvedata", () => fetchTwelveData(missing(), twelveKey));

  // Foreign/UCITS tickers (BARC, VUSA, CSPX, CSG, SMSN…) can't be fetched by the live
  // providers from the edge. The GitHub-Actions history worker prices them DAILY (Yahoo +
  // currency→USD) into price_history — copy its latest close into the cache for whatever is
  // still missing, so those holdings track the market (a day stale) instead of freezing at
  // whatever was last written manually.
  if (missing().length) {
    const { data: hist } = await supabase
      .from("price_history").select("symbol,date,close")
      .in("symbol", missing()).gt("close", 0)
      .order("date", { ascending: false });
    let fromHistory = 0;
    for (const r of (hist ?? []) as any[]) {
      if (collected.has(r.symbol)) continue; // newest-first: first row per symbol wins
      collected.set(r.symbol, { price: Number(r.close), prev: Number(r.close), pct: 0 });
      fromHistory++;
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

  if (rows.length) await supabase.from("price_cache").upsert(rows, { onConflict: "symbol" });

  // Also append today's close to the shared price_history (keeps history current for charts, free).
  const today = now.slice(0, 10);
  const histRows = rows.filter((r: any) => Number.isFinite(Number(r.price)) && Number(r.price) > 0)
    .map((r: any) => ({ symbol: r.symbol, date: today, close: r.price }));
  if (histRows.length) await supabase.from("price_history").upsert(histRows, { onConflict: "symbol,date" });

  const missingFinal = all.filter((t) => !collected.has(t));
  return new Response(
    JSON.stringify({
      refreshed: rows.length, stocks: stockTickers.length, crypto: cryptoTickers.length,
      providersUsed, missing: missingFinal,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
