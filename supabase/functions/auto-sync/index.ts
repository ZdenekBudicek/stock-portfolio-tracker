// Scheduled background sync: keeps every connected T212 account fresh without the user
// pressing "Obnovit". For each broker connection it pulls the account summary (header
// numbers), mirrors free cash, and reconciles positions to the live portfolio.
//
// CRITICAL: this must use the SAME account-scoped reconcile as sync-broker
// (public.reconcile_broker_account). An earlier version carried its own copy of the old
// account-blind logic — it wrote t212:adj:<ticker> rows with NO broker_account and summed
// net over ALL T212 rows. Running side by side with the account-aware manual sync, the two
// produced two adjustments for the same shares and every reconciled position DOUBLED
// (RKLB showed 509 instead of 285). Never reintroduce a private reconcile here.
//
// Scheduler-only (pg_cron, see _shared/auth.ts). It decrypts EVERY user's T212 key and
// rewrites every account's adjustments, so a valid JWT is not enough: the anon key is public
// and anyone can sign up. The response carries counts only — never user ids or accounts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { syncCashFromApi, prepareReconcileHoldings, type T212PortfolioHolding } from "../_shared/t212.ts";
import { isSchedulerToken } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RENAME: Record<string, string> = { IPOE: "SOFI", VACQ: "RKLB", FB: "META", FBA: "META" };
const stripT212 = (t: string) => t.replace(/_US_EQ$/, "").replace(/_EQ$/, "").toUpperCase();

// Reconcile ONE T212 account to its live portfolio, via the shared account-scoped RPC.
// USD average cost + the ticker-rename guard come from the shared prepareReconcileHoldings,
// the same code sync-broker uses, so a manual sync and this background sync are
// interchangeable.
async function reconcileAccount(svc: any, userId: string, account: string, hjson: T212PortfolioHolding[]) {
  const holdings = await prepareReconcileHoldings(svc, userId, account, hjson);
  const { error } = await svc.rpc("reconcile_broker_account", {
    p_user_id: userId, p_broker: "T212", p_account: account,
    p_holdings: holdings, p_note: "Dorovnání podle Trading 212 (auto)",
  });
  if (error) throw new Error(`reconcile_broker_account: ${error.message}`);
}

// Per-user outcomes go to the function log (visible to the project owner only); the HTTP
// response says how many, nothing about whom.
const tally = (results: any[]) => ({
  users: results.length,
  synced: results.filter((r) => r.ok).length,
  skipped: results.filter((r) => r.skip).length,
  failed: results.filter((r) => r.error).length,
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!isSchedulerToken(req.headers.get("Authorization"), [serviceKey, Deno.env.get("CRON_SECRET")])) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const results: any[] = [];
  try {
    const { data: conns } = await svc.from("broker_connections").select("user_id, environment").eq("broker", "T212");
    for (const conn of (conns ?? []) as any[]) {
      const userId = conn.user_id;
      try {
        const { data: keyRows } = await svc.rpc("get_broker_key", { p_user_id: userId, p_broker: "T212" });
        const key = (keyRows as any[])?.[0]?.api_key;
        if (!key) { results.push({ userId, skip: "no key" }); continue; }
        const base = (keyRows as any[])?.[0]?.environment === "demo" ? "https://demo.trading212.com/api/v0" : "https://live.trading212.com/api/v0";
        const basic = "Basic " + btoa(key);
        const t212 = async (path: string) => {
          for (let i = 0; i < 5; i++) {
            const r = await fetch(`${base}${path}`, { headers: { Authorization: basic, Accept: "application/json" } });
            if (r.status === 429) { await sleep(2000); continue; }
            await sleep(300);
            return r;
          }
          return new Response("", { status: 429 });
        };

        // 1) account summary + WHICH account this key belongs to (fallback: leading digits
        //    of the key). Everything below is scoped to this account.
        const cashR = await t212("/equity/account/cash");
        if (!cashR.ok) { results.push({ userId, error: `cash HTTP ${cashR.status}` }); continue; }
        const cashJson = await cashR.json();
        const infoR = await t212("/equity/account/info");
        const info = infoR.ok ? await infoR.json() : null;
        // Fall back to the last known currency/account when info is throttled, so a 429 can't
        // drop the currency to null (which would either skip the cash mirror or, before the
        // shared fix, multiply cash ~21x) or lose the account id.
        const { data: prev } = await svc.from("broker_connections").select("account_summary, account_id").eq("user_id", userId).eq("broker", "T212").maybeSingle();
        const currency = info?.currencyCode ?? prev?.account_summary?.currency ?? null;
        const account = String(info?.id ?? prev?.account_id ?? (/^\d+/.exec(key)?.[0] ?? "")) || null;
        const summary = { ...cashJson, currency, account, at: new Date().toISOString() };
        await svc.from("broker_connections").update({ account_summary: summary, account_id: account, last_sync_at: new Date().toISOString() }).eq("user_id", userId).eq("broker", "T212");
        if (!account) { results.push({ userId, skip: "no account id" }); continue; }

        // 2) free cash mirror. Best-effort (a cash failure must not stop the reconcile), but
        //    never silent: syncCashFromApi throws on any failed read/write.
        try { await syncCashFromApi(svc, userId, summary); } catch (e) { console.warn(`auto-sync: cash mirror failed for one user: ${(e as Error).message}`); }

        // 3) Claim this account's legacy rows (written before per-account scoping). Only safe
        //    when no OTHER T212 account is present — otherwise the reconcile guard refuses and
        //    we skip, exactly like sync-broker, rather than guess where they belong.
        const { data: acctRows } = await svc.from("transactions")
          .select("broker_account").eq("user_id", userId).eq("broker", "T212").neq("ticker", "CASH");
        const foreign = new Set((acctRows ?? []).map((r: any) => r.broker_account).filter((a: any) => a && a !== account));
        const hasUntagged = (acctRows ?? []).some((r: any) => !r.broker_account);
        if (hasUntagged && foreign.size === 0) {
          await svc.from("transactions").update({ broker_account: account })
            .eq("user_id", userId).eq("broker", "T212").is("broker_account", null);
        } else if (hasUntagged) {
          results.push({ userId, skip: `untagged rows + foreign account(s) ${[...foreign].join(",")}` });
          continue;
        }

        // 4) positions reconcile to the live portfolio (alias-mapped tickers)
        const pr = await t212("/equity/portfolio");
        if (pr.ok) {
          const holdings: any[] = await pr.json();
          const pBases = [...new Set(holdings.map((h) => stripT212(h.ticker)))];
          const { data: pAlias } = pBases.length ? await svc.from("ticker_alias").select("alias,canonical").in("alias", pBases) : { data: [] };
          const pMap = new Map<string, string>();
          for (const r of (pAlias ?? []) as any[]) pMap.set(r.alias, r.canonical);
          const hjson = holdings.filter((h) => Number(h.quantity) > 0).map((h) => {
            const b = stripT212(h.ticker);
            return { ticker: pMap.get(b) ?? RENAME[b] ?? b, qty: Number(h.quantity), avg: Number(h.averagePrice), cur: Number(h.currentPrice), usdQuoted: /_US_EQ$/.test(String(h.ticker)) };
          });
          await reconcileAccount(svc, userId, account, hjson);
          results.push({ userId, ok: true, account, positions: hjson.length });
        } else {
          results.push({ userId, ok: true, account, positions: "portfolio skipped (" + pr.status + ")" });
        }
        await sleep(1500); // spread the per-user API load
      } catch (e) {
        results.push({ userId, error: (e as Error).message });
      }
    }

    // New holdings may have introduced tickers we have no sector for; without this they
    // wait for the nightly Yahoo worker and the donut shows them as "Ostatní" until then.
    //
    // ONCE, AFTER the loop. ticker_profiles is user-agnostic — one row per instrument for
    // the whole app — so every connection would build the SAME queue. Calling this per
    // connection would run overlapping copies fetching identical tickers: double the
    // Finnhub burn for zero extra work, against a 60/min free-tier limit that sync-sectors
    // already sizes its per-run cap against. Out here it also cannot be skipped by the
    // loop's early `continue` paths (no key / no account id / ambiguous rows), which are
    // exactly the runs where somebody is most likely to be watching the log.
    //
    // AWAITED, despite being best-effort. A promise left in flight when the handler returns
    // has no guarantee of completion — the isolate can be torn down as soon as the response
    // is sent, so an un-awaited fetch may never leave the process at all, and there would be
    // nothing to log. Nothing pays for the wait: auto-sync is a scheduled job with no
    // interactive caller (nothing in the app invokes it), and the loop above already sleeps
    // 1.5 s per user. Deliberately NOT bounded by an AbortSignal either — sync-sectors
    // writes only at the END of its run, so cancelling it mid-flight would throw away every
    // lookup it had already paid Finnhub for. It bounds itself (MAX_PER_RUN + a 60 s fetch
    // budget) and reports what it did not get to, which the next run picks up.
    //
    // Everything is swallowed: a failure here must never fail the position sync that
    // already succeeded. It is only logged — this function runs unattended, so its log is
    // the one place a failure can ever surface.
    try {
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-sectors`, {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      });
      // The body, not just the status: sync-sectors answers 200 with {ok:false} for "we
      // could not do the work" (missing key, failed read), so the status alone would report
      // a run that did nothing as a success.
      console.log(`sync-sectors: HTTP ${r.status} ${(await r.text()).slice(0, 500)}`);
    } catch (e) {
      console.log(`sync-sectors: not invoked — ${(e as Error).message}`);
    }

    console.log("auto-sync results", JSON.stringify(results));
    return new Response(JSON.stringify({ ok: true, ...tally(results) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("auto-sync failed", (e as Error).message, JSON.stringify(results));
    return new Response(JSON.stringify({ error: (e as Error).message, ...tally(results) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
