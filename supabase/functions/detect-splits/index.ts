// Detects REAL stock splits via Finnhub (/stock/split) over the last 7 days and
// creates a pending split per user who holds the ticker. The old version inferred
// splits from any large price drop, which produced false positives that inflated
// portfolios when confirmed — that heuristic has been removed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isSchedulerToken } from "../_shared/auth.ts";
import { parseFinnhubSplits } from "./parse.ts";
import { isCryptoTicker } from "../_shared/crypto.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Scheduler-only: it works on every user's data and the shared provider quotas, so
  // "has a JWT" (which the public anon key and any signed-up user satisfy) is not enough.
  if (!isSchedulerToken(req.headers.get("Authorization"), [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("CRON_SECRET")])) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY") ?? "";

  try {
    if (!finnhubKey) throw new Error("FINNHUB_API_KEY not configured");

    // Who holds what (non-cash, non-crypto).
    const { data: positions } = await supabase
      .from("positions").select("ticker,user_id").neq("type", "Cash");
    const holders = new Map<string, Set<string>>(); // ticker -> set(user_id)
    for (const p of positions ?? []) {
      if (!p.ticker || isCryptoTicker(p.ticker) || p.ticker.toUpperCase() === "CASH") continue;
      if (!holders.has(p.ticker)) holders.set(p.ticker, new Set());
      holders.get(p.ticker)!.add(p.user_id);
    }

    // Existing split rows (any status) to avoid duplicates: key = ticker|user_id|date.
    const { data: existing } = await supabase.from("splits").select("ticker,user_id,split_date");
    const seen = new Set((existing ?? []).map((s: any) => `${s.ticker}|${s.user_id}|${s.split_date}`));

    const from = ymd(new Date(Date.now() - 7 * 86_400_000));
    const to = ymd(new Date());

    const candidates: any[] = [];
    for (const [ticker, users] of holders) {
      let rows: any[] = [];
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/stock/split?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey}`,
        );
        rows = await r.json();
      } catch (_e) { continue; }
      for (const c of parseFinnhubSplits(ticker, Array.isArray(rows) ? rows : [])) {
        for (const uid of users) {
          if (seen.has(`${ticker}|${uid}|${c.split_date}`)) continue;
          candidates.push({ ...c, user_id: uid });
        }
      }
    }

    if (candidates.length > 0) await supabase.from("splits").insert(candidates);

    return new Response(JSON.stringify({ detected: candidates.length, tickers_checked: holders.size }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
