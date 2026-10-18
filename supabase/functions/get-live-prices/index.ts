// Reads prices from the shared price_cache only. No external provider calls here —
// the scheduled `refresh-prices` function keeps the cache fresh. This makes the
// per-user cost zero regardless of how many users load the dashboard.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STALE_MS = 20 * 60 * 1000; // consider cache stale if older than 20 min

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
      ...(positions ?? []).map((p: any) => p.ticker),
      ...(watch ?? []).map((w: any) => w.ticker),
    ])).filter((t: string) => t && t.toUpperCase() !== "CASH");

    const { data: cache } = await supabase.from("price_cache").select("*");
    const cacheMap = new Map<string, any>((cache ?? []).map((r: any) => [r.symbol, r]));

    const now = Date.now();
    let stale = false;
    const prices: Record<string, { price: number; changePct: number; prevClose: number | null }> = {};
    for (const t of tickers) {
      const r = cacheMap.get(t);
      if (r) {
        prices[t] = { price: Number(r.price), changePct: Number(r.change_pct ?? 0), prevClose: r.prev_close === null ? null : Number(r.prev_close) };
        if (now - new Date(r.fetched_at).getTime() > STALE_MS) stale = true;
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
      const { data: hist } = await supabase
        .from("price_history").select("symbol,date,close")
        .in("symbol", missingTk).gt("close", 0)
        .order("date", { ascending: false });
      for (const r of (hist ?? []) as any[]) {
        if (prices[r.symbol]) continue; // rows are newest-first; first per symbol = latest close
        prices[r.symbol] = { price: Number(r.close), changePct: 0, prevClose: null };
      }
    }

    const fxRow = cacheMap.get("USDCZK");
    const newestFetch = (cache ?? []).reduce((max: number, r: any) => Math.max(max, new Date(r.fetched_at).getTime()), 0);

    return new Response(
      JSON.stringify({
        prices,
        usdCzk: fxRow ? Number(fxRow.price) : 23.0,
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
