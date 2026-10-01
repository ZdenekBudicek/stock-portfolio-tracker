// Sync S&P 500 historical close values from Twelve Data into benchmark_history
// Tries SPX first (index), falls back to SPY (ETF) which is on free plan
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchSeries(symbol: string, apiKey: string) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=5000&apikey=${apiKey}`;
  const r = await fetch(url);
  const j = await r.json();
  return j;
}

async function fetchYahooGspc() {
  const period1 = Math.floor(new Date("2000-01-01T00:00:00Z").getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
  const values: Array<{ datetime: string; close: string }> = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close === "number" && Number.isFinite(close)) {
      values.push({ datetime: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: String(close) });
    }
  }
  return values;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "TWELVE_DATA_API_KEY missing" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    let used = "Yahoo ^GSPC";
    let values: any[] = await fetchYahooGspc().catch(() => []);
    let lastError: any = null;

    if (values.length === 0) {
      // Try SPX (paid on some plans), then SPY ETF as a close proxy.
      const candidates = ["SPX", "^GSPC", "SPY"];
      for (const sym of candidates) {
        const j = await fetchSeries(sym, apiKey);
        if (Array.isArray(j.values) && j.values.length > 0) {
          used = sym;
          values = j.values;
          break;
        }
        lastError = j;
      }
    }

    if (values.length === 0) {
      return new Response(JSON.stringify({ inserted: 0, error: "no data", lastError }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sanity-filter glitch points (e.g. a provider returning 690 instead of 6930, or a
    // market-closed row): drop any close that jumps >40% from the previous kept value.
    const clean = values
      .map((v: any) => ({ date: v.datetime as string, close: parseFloat(v.close) }))
      .filter((v) => Number.isFinite(v.close) && v.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const kept: { date: string; close: number }[] = [];
    let prev: number | null = null;
    for (const v of clean) {
      if (prev != null && (v.close > prev * 1.4 || v.close < prev * 0.6)) continue;
      kept.push(v); prev = v.close;
    }
    const inserts = kept.map((v) => ({ symbol: "SPX", date: v.date, close_value: v.close }));

    if (inserts.length > 0) {
      await supabase.from("benchmark_history").upsert(inserts, { onConflict: "symbol,date" });
    }

    return new Response(JSON.stringify({ inserted: inserts.length, source: used }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
