// Company data right away (Ocenění v3): when the assistant or the fair value card needs a company
// nobody has data for, this fetches it while the user waits (~1–4 s) instead of queueing a GitHub run.
//
// Yahoo rejects Supabase edge IPs, so: statements from SEC EDGAR (US filers; only when nothing is
// stored), analyst consensus EPS (up to four fiscal years), targets and ratings from Nasdaq (when the
// stored snapshot is missing or older than three days). Both are written for everyone; the nightly
// worker refreshes companies asked about in the last 90 days with fuller Yahoo + EDGAR data.
//
// Abuse guard: the user's hourly quota and one live fetch per company a day, both through
// reserve_fundamentals_requests (as request-fundamentals). A company the SEC does not have (listed
// abroad) falls back to the GitHub on-demand run (Yahoo), which finishes the request itself.
// Secrets: FINNHUB_API_KEY (share count when the filings give none), optional SEC_USER_AGENT,
// GITHUB_DISPATCH_TOKEN + GITHUB_REPO (the fallback run, as request-fundamentals).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { cleanTickers, canonicalOf } from "../_shared/fundamentalsRequests.js";
import { isCryptoHolding } from "../_shared/crypto.js";
import { allowedOrigins, corsHeadersFor } from "../_shared/cors.ts";
import { smallJson } from "../_shared/requestBody.ts";
import { secCikMap, secFactsUrl, secTicker, SEC_TICKERS_URL } from "../_shared/edgar.js";
import { edgarOnlyFundamentals, liveDue, NASDAQ_HEADERS, nasdaqForecastUrl, nasdaqTargetUrl, parseNasdaqSnapshot } from "../_shared/companyData.js";

// Browser access only from the app's origins (audit A6, _shared/cors.ts); server callers send no Origin.
const jsonWith = (cors: Record<string, string>) => (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const USER_HOURLY_LIMIT = 30;
const FETCH_TIMEOUT_MS = 5_000;
type Outcome = "stored" | "loaded" | "unavailable";

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
  return await res.json();
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req, allowedOrigins(Deno.env.get("AGENT_ALLOWED_ORIGINS"))), json = jsonWith(corsHeaders);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await svc.auth.getUser(jwt);
    const user = auth?.user;
    if (!user) return json({ error: "auth" }, 401);

    const body = await smallJson(req) as { ticker?: unknown } | null;
    if (!body) return json({ error: "too_large" }, 413);
    const [ticker] = cleanTickers([body.ticker]);
    if (!ticker) return json({ error: "ticker" }, 400);
    const aliases = await svc.from("ticker_alias").select("alias,canonical,yahoo_symbol").in("alias", [...new Set([ticker, ticker.toUpperCase()])]);
    if (aliases.error) throw aliases.error;
    const symbol = canonicalOf(ticker, aliases.data ?? []);
    const yahoo = String(aliases.data?.[0]?.yahoo_symbol ?? "");
    if (/-USD$/i.test(yahoo) || (!yahoo && isCryptoHolding(symbol, undefined))) return json({ symbol, fundamentals: "unavailable", analysts: "unavailable", reason: "crypto" });

    const [fund, snap] = await Promise.all([
      svc.from("company_fundamentals").select("status,fetched_at,data").eq("symbol", symbol).maybeSingle(),
      svc.from("analyst_snapshots").select("status,fetched_at,data").eq("symbol", symbol).maybeSingle(),
    ]);
    if (fund.error || snap.error) throw fund.error ?? snap.error;
    const now = Date.now();
    const needFundamentals = !fund.data || fund.data.status !== "ok" || !fund.data.data;
    const needAnalysts = liveDue(snap.data, now);
    const result: { symbol: string; fundamentals: Outcome; analysts: Outcome; reason?: string } =
      { symbol, fundamentals: needFundamentals ? "unavailable" : "stored", analysts: needAnalysts ? "unavailable" : "stored" };
    if (!needFundamentals && !needAnalysts) return json(result);

    const { data: reserved, error: reserveError } = await svc.rpc("reserve_fundamentals_requests", { p_user: user.id, p_symbols: [symbol], p_hourly_limit: USER_HOURLY_LIMIT });
    if (reserveError) {
      if (String(reserveError.message).includes("rate_limited")) return json({ ...result, reason: "rate_limited" }, 429);
      throw reserveError;
    }
    if (!(reserved ?? []).includes(symbol)) return json({ ...result, reason: "recent" });

    const nowIso = new Date(now).toISOString(), today = nowIso.slice(0, 10);
    const errors: string[] = [];
    const statements = async () => {
      const sec = secTicker(yahoo || symbol);
      if (!sec) throw new Error("not an SEC ticker");
      const headers = { "User-Agent": Deno.env.get("SEC_USER_AGENT") || "Trackora valuation research dev@trackora-test.invalid", Accept: "application/json" };
      const cik = secCikMap(await getJson(SEC_TICKERS_URL, headers)).get(sec);
      if (!cik) throw new Error("not an SEC filer");
      const facts = await getJson(secFactsUrl(cik), headers);
      let data = edgarOnlyFundamentals(facts, symbol, nowIso);
      const shares = data && ["annual", "quarterly"].some(k => ["dilutedShares", "sharesOutstanding"].some(m => (data![k as "annual"].values[m as "revenue"] ?? []).some((x: number | null) => (x ?? 0) > 0)));
      const key = Deno.env.get("FINNHUB_API_KEY");
      if (data && !shares && key) {
        // Several share classes (Visa) and no one count in the filings: the provider's shares outstanding (millions).
        const profile = await getJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sec)}&token=${key}`, {}).catch(() => null);
        data = edgarOnlyFundamentals(facts, symbol, nowIso, typeof profile?.shareOutstanding === "number" ? profile.shareOutstanding * 1e6 : null);
      }
      if (!data) throw new Error("no usable statements");
      const write = await svc.from("company_fundamentals").upsert({ symbol, data, currency: "USD", fetched_at: nowIso, last_attempt_at: nowIso, status: "ok", last_error: null });
      if (write.error) throw write.error;
    };
    const analysts = async () => {
      const sym = (yahoo || symbol).replace(/[^A-Za-z0-9.^-]/g, "");
      const [forecast, target] = await Promise.all([getJson(nasdaqForecastUrl(sym), NASDAQ_HEADERS), getJson(nasdaqTargetUrl(sym), NASDAQ_HEADERS)]);
      const view = parseNasdaqSnapshot(forecast, target, symbol, today);
      if (!view) throw new Error("no analyst data");
      const write = await svc.from("analyst_snapshots").upsert({ symbol, data: view, fetched_at: nowIso, last_attempt_at: nowIso, status: "ok" });
      if (write.error) throw write.error;
    };
    const [s, a] = await Promise.allSettled([needFundamentals ? statements() : Promise.resolve(), needAnalysts ? analysts() : Promise.resolve()]);
    if (needFundamentals) { if (s.status === "fulfilled") result.fundamentals = "loaded"; else errors.push(`statements: ${String((s as PromiseRejectedResult).reason?.message ?? s).slice(0, 120)}`); }
    if (needAnalysts) { if (a.status === "fulfilled") result.analysts = "loaded"; else errors.push(`analysts: ${String((a as PromiseRejectedResult).reason?.message ?? a).slice(0, 120)}`); }
    // No SEC statements: the on-demand GitHub run (Yahoo) tries within minutes and closes the request.
    if (needFundamentals && result.fundamentals !== "loaded") {
      const token = Deno.env.get("GITHUB_DISPATCH_TOKEN") ?? "", repo = Deno.env.get("GITHUB_REPO") ?? "";
      // Workflow runs share one daily budget with request-fundamentals (reserve_shared_resource).
      const unit = token && /^[\w.-]+\/[\w.-]+$/.test(repo) ? await svc.rpc("reserve_shared_resource", { p_resource: "github_dispatch", p_units: 1 }) : null;
      const run = unit && !unit.error && unit.data === true ? await fetch(`https://api.github.com/repos/${repo}/actions/workflows/price-history.yml/dispatches`, {
        method: "POST", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "portfolio-tracker" },
        body: JSON.stringify({ ref: "main", inputs: { symbols: ticker } }),
      }).catch(() => null) : null;
      if (run?.ok) { result.reason = "queued"; return json(result); }
      await run?.body?.cancel();
    }
    const ok = !errors.length || result.fundamentals === "loaded" || result.analysts === "loaded";
    await svc.from("fundamentals_requests").update({ status: ok ? "done" : "failed", finished_at: new Date().toISOString(), last_error: errors.join("; ") || null }).eq("symbol", symbol);
    if (errors.length) console.error(symbol, errors.join("; "));
    return json(result);
  } catch (e) {
    console.error(e);
    return json({ error: "internal" }, 500);
  }
});
