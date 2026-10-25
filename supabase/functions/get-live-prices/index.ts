// Reads prices from the shared price_cache only. No external provider calls here —
// the scheduled `refresh-prices` function keeps the cache fresh. This makes the
// per-user cost zero regardless of how many users load the dashboard.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fetchRowsBySymbols, latestCloses } from "../_shared/price-providers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STALE_MS = 20 * 60 * 1000; // consider cache stale if older than 20 min
const CLOSE_STALE_MS = 4 * 24 * 60 * 60 * 1000; // a carried close older than this is a frozen price
const FX_STALE_MS = 3 * 24 * 60 * 60 * 1000; // EUR/GBP/PLN rows: fall back to ČNB beyond this

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // The caller's OWN positions and watchlist: read with their JWT so RLS scopes the rows.
    // Reading them with the service key handed every user's tickers to anyone signed in.
    const asCaller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const [{ data: positions, error: posErr }, { data: watch }] = await Promise.all([
      asCaller.from("positions").select("ticker").neq("type", "Cash"),
      asCaller.from("watchlist").select("ticker"),
    ]);
    if (posErr) throw posErr;

    const tickers = Array.from(new Set([
      ...(positions ?? []).map((p) => p.ticker),
      ...(watch ?? []).map((w) => w.ticker),
    ])).filter((t: string) => t && t.toUpperCase() !== "CASH");

    // Only the rows this caller needs (the whole table is capped at 1000 rows by PostgREST, so
    // a growing cache silently lost symbols), chunked and fully paged.
    const cache = await fetchRowsBySymbols([...tickers, "USDCZK", "EURCZK", "GBPCZK", "PLNCZK"], (chunk, f, t) =>
      supabase.from("price_cache").select("*").in("symbol", chunk).order("symbol", { ascending: true }).range(f, t), "price_cache");
    const cacheMap = new Map<string, typeof cache[number]>((cache ?? []).map((r) => [r.symbol, r]));

    const now = Date.now();
    let stale = false;
    const prices: Record<string, { price: number; changePct: number; prevClose: number | null }> = {};
    for (const t of tickers) {
      const r = cacheMap.get(t);
      if (r) {
        prices[t] = { price: Number(r.price), changePct: Number(r.change_pct ?? 0), prevClose: r.prev_close === null ? null : Number(r.prev_close) };
        // A carried daily close (as_of, audit B6) is current while it is the latest close (a long weekend included);
        // a live quote is current for 20 minutes.
        if (r.as_of ? now - Date.parse(r.as_of) > CLOSE_STALE_MS : now - new Date(r.fetched_at).getTime() > STALE_MS) stale = true;
      } else {
        stale = true; // a held ticker has no cached price yet
      }
    }

    // Foreign / UCITS tickers (BARC.L, VUSA, CSPX, …) can't be fetched by the live providers
    // from the edge IP, so they're absent from price_cache. The history worker DOES price them
    // (Yahoo + currency→USD), so fall back to their latest price_history close — the correct
    // value (a day stale) instead of letting the UI drop to cost basis.
    const missingTk = tickers.filter((t) => !prices[t]);
    if (missingTk.length) {
      // Latest close PER SYMBOL — not the newest 1000 rows globally, which left out symbols
      // whose last close is older than the others'. Best-effort: a failed read keeps the rest.
      try {
        for (const [symbol, r] of await latestCloses(supabase, missingTk)) {
          if (!prices[symbol]) prices[symbol] = { price: r.close, changePct: 0, prevClose: null };
        }
      } catch (e) {
        console.error("price_history fallback failed", (e as Error).message);
      }
    }

    const fxRow = cacheMap.get("USDCZK");
    const newestFetch = (cache ?? []).reduce((max: number, r) => Math.max(max, new Date(r.fetched_at).getTime()), 0);

    return new Response(
      JSON.stringify({
        prices,
        usdCzk: fxRow ? Number(fxRow.price) : 23.0,
        // CZK per 1 EUR / GBP / PLN (display currencies); missing ones fall back to ČNB in the app.
        // A rate older than 3 days (weekends included) is left out: the app then uses the ČNB rate.
        fxCzk: Object.fromEntries(["EUR", "GBP", "PLN"].map((c) => cacheMap.get(`${c}CZK`)).filter((r) => r && Number(r.price) > 0 && now - new Date(r.fetched_at).getTime() <= FX_STALE_MS).map((r) => [String(r.symbol).slice(0, 3), Number(r.price)])),
        fetchedAt: newestFetch ? new Date(newestFetch).toISOString() : new Date().toISOString(),
        stale,
        error: null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message, prices: {}, usdCzk: 23.0, stale: true }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
