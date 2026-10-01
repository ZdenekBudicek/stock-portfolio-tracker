// Daily snapshot cron - per-user
// Computes portfolio value from positions + latest cached prices and inserts a daily_snapshots row PER USER

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Auth: require a shared CRON_SECRET (or service-role key) in the Authorization header.
    // This endpoint is meant to be invoked by the scheduler, not by anonymous callers.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const cronSecret = Deno.env.get("CRON_SECRET");
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const allowed = token && (token === serviceKey || (cronSecret && token === cronSecret));
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey,
    );


    await supabase.functions.invoke("get-live-prices");
    // Keep S&P 500 benchmark fresh so the comparison chart doesn't flatline
    await supabase.functions.invoke("sync-benchmark").catch((e) => console.error("sync-benchmark failed", e));

    // PostgREST caps a plain select at 1000 rows. Positions must be paged: silently losing
    // rows past the cap would write a snapshot that undercounts somebody's portfolio, and a
    // stored snapshot is never recomputed by this cron.
    const positions: any[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await supabase.from("positions").select("*").range(f, f + 999);
      if (error) throw error;
      const page = data ?? []; positions.push(...page); if (page.length < 1000) break;
    }
    const { data: cache } = await supabase.from("price_cache").select("*");

    if (!positions.length || !cache) throw new Error("Missing data");

    const priceMap = new Map(cache.map((r: any) => [r.symbol, r]));
    const fx = priceMap.get("USDCZK")?.price ?? 23.0;
    const today = new Date().toISOString().slice(0, 10);

    // Group by user_id
    const byUser = new Map<string, any[]>();
    for (const p of positions) {
      if (!p.user_id) continue;
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
      byUser.get(p.user_id)!.push(p);
    }

    const results: any[] = [];
    for (const [user_id, ups] of byUser) {
      // HOLDINGS value only (exclude cash) — the same figure backfill-snapshots and the
      // nightly price worker reconstruct, and the same `positions` rows the live header is
      // computed from. Cash is reported separately in the UI, never folded into history.
      // Cash is recorded ALONGSIDE the holdings value, not folded into it. Without it the
      // chart cannot see money that left the positions, so selling a big holding and sitting
      // on the proceeds looked like a crash. Past days carry NULL (never tracked); from here
      // on the chart can draw the whole portfolio.
      const cashUsd = ups
        .filter((p: any) => p.type === "Cash" || p.ticker === "CASH")
        .reduce((s: number, p: any) => s + Number(p.shares), 0);
      let valueUsd = 0;
      for (const p of ups) {
        if (p.type === "Cash" || p.ticker === "CASH") continue;
        const px = priceMap.get(p.ticker)?.price ?? Number(p.avg_cost_usd);
        valueUsd += Number(p.shares) * Number(px);
      }
      // profit_* fields are stored as 0, same as backfill-snapshots. The old computation
      // here (value − net trade flow) was NOT a cost basis (a buy-sell-buy sequence breaks
      // it) and disagreed with the header's FIFO figures. The daily log UI now derives the
      // per-day change client-side from consecutive snapshot values instead.
      const valueCzk = valueUsd * fx;

      const { error } = await supabase.from("daily_snapshots").upsert(
        {
          user_id,
          snapshot_date: today,
          value_usd: valueUsd,
          value_czk: valueCzk,
          cash_usd: cashUsd,
          profit_usd: 0,
          profit_pct: 0,
          profit_czk: 0,
          fx_rate: fx,
        },
        { onConflict: "user_id,snapshot_date" },
      );
      if (error) console.error("upsert err for", user_id, error.message);
      results.push({ user_id, valueUsd: valueUsd.toFixed(2) });
    }

    // Internal log only — do not leak per-user data in the HTTP response
    console.log("snapshot summary", { date: today, users: results });
    return new Response(JSON.stringify({ success: true, date: today, count: results.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("Snapshot error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
