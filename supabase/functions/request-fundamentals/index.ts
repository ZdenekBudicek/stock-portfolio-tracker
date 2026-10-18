// Fetch statements and price history right away for companies nobody has data for yet.
//
// Yahoo rejects Supabase edge IPs, so this function only decides WHAT to fetch and starts the
// existing GitHub Actions workflow (price-history.yml, workflow_dispatch with `symbols`) for
// those tickers; the run takes ~1–3 minutes and writes company_fundamentals, price_history and
// the outcome into fundamentals_requests. Known companies are left to the nightly job.
//
// Secrets: GITHUB_DISPATCH_TOKEN (fine-grained token, this repository only, Actions: read & write)
// and GITHUB_REPO ("owner/name"). Without them the function answers { configured: false }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { cleanTickers, canonicalOf, planFundamentalsRequest } from "../_shared/fundamentalsRequests.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Per user: at most this many companies reserved per hour (abuse guard, enforced in the DB). */
const USER_HOURLY_LIMIT = 30;
const WORKFLOW = "price-history.yml";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    // A signed-in user only: the JWT is verified by the platform (verify_jwt) and resolved here.
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await svc.auth.getUser(jwt);
    const user = auth?.user;
    if (!user) return json({ error: "auth" }, 401);

    const body = await req.json().catch(() => ({}));
    const tickers = cleanTickers(body?.tickers);
    if (tickers.length === 0) return json({ dispatched: [], known: [], recent: [], ignored: [] });

    const token = Deno.env.get("GITHUB_DISPATCH_TOKEN") ?? "";
    const repo = Deno.env.get("GITHUB_REPO") ?? "";
    if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ configured: false, dispatched: [] });

    // Aliases are stored with their own case ('BATSl'); look up both spellings.
    const variants = [...new Set(tickers.flatMap((t) => [t, t.toUpperCase()]))];
    const aliases = await svc.from("ticker_alias").select("alias,canonical,yahoo_symbol").in("alias", variants);
    if (aliases.error) throw aliases.error;
    const symbols = [...new Set(tickers.map((t) => canonicalOf(t, aliases.data ?? [])))];
    // Filter both tables to exactly these symbols — never a capped full-table read.
    const [existing, requests, positions] = await Promise.all([
      svc.from("company_fundamentals").select("symbol").in("symbol", symbols),
      svc.from("fundamentals_requests").select("symbol,status,requested_at,finished_at").in("symbol", symbols),
      svc.from("positions").select("ticker,type").eq("user_id", user.id).in("ticker", tickers),
    ]);
    for (const r of [existing, requests, positions]) if (r.error) throw r.error;
    const types: Record<string, string> = {};
    for (const p of positions.data ?? []) if (p.type) types[String(p.ticker)] = p.type;

    const plan = planFundamentalsRequest({
      tickers, types, aliases: aliases.data ?? [], now: Date.now(),
      existing: (existing.data ?? []).map((r) => r.symbol), requests: requests.data ?? [],
    });
    const base = { known: plan.known, recent: plan.recent, ignored: plan.ignored };
    if (plan.dispatch.length === 0) return json({ dispatched: [], ...base });

    // Atomic: per-user quota + one run per symbol even when calls race.
    const { data: reserved, error: reserveError } = await svc.rpc("reserve_fundamentals_requests", {
      p_user: user.id, p_symbols: plan.dispatch.map((d) => d.symbol), p_hourly_limit: USER_HOURLY_LIMIT,
    });
    if (reserveError) {
      if (String(reserveError.message).includes("rate_limited")) return json({ error: "rate_limited", dispatched: [], ...base }, 429);
      throw reserveError;
    }
    const got = new Set<string>(reserved ?? []);
    const go = plan.dispatch.filter((d) => got.has(d.symbol));
    if (go.length === 0) return json({ dispatched: [], ...base, recent: [...plan.recent, ...plan.dispatch.map((d) => d.symbol)] });

    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "portfolio-tracker" },
      // The workers get the tickers as the user's data spells them; they resolve aliases themselves.
      body: JSON.stringify({ ref: "main", inputs: { symbols: go.map((d) => d.ticker).join(",") } }),
    });
    if (!res.ok) {
      console.error("dispatch failed", res.status, (await res.text()).slice(0, 300));
      await svc.rpc("release_fundamentals_requests", { p_symbols: go.map((d) => d.symbol) });
      return json({ error: "dispatch_failed", dispatched: [], ...base }, 502);
    }
    return json({ dispatched: go.map((d) => d.symbol), ...base });
  } catch (e) {
    console.error(e);
    return json({ error: "internal" }, 500);
  }
});
