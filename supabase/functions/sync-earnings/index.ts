// Sync earnings calendar AND dividends for portfolio tickers.
// Source: Nasdaq public API (free, no key). Falls back gracefully on failure.
//
// Dividend model:
//  - PAID T212 dividends come exactly from its API (sync-broker, broker='T212').
//  - PAID non-T212 dividends (Revolut/XTB/manual — no API) are AUTOMATED here from public
//    data: per user/ticker we pull the real schedule (ex-date, pay-date, $/share) and record
//    amount = non-T212 shares held at the ex-date × $/share (broker='auto').
//  - UPCOMING dividends are projected here for ALL brokers on the user's TOTAL shares —
//    T212's API only returns PAID dividends, so the future would otherwise be invisible.
// Only auto rows are deleted/recomputed each run, so the exact T212 API dividends are never
// touched. Past auto (non-T212) and the T212-API row for the same ex-date coexist; the UI
// merges same-ticker rows within a month and sums them, so a stock shows once per dividend.
//
// Who may run what. The scheduler (service-role key / CRON_SECRET, see _shared/auth.ts) runs
// it for every user. A signed-in user — the "Sync" buttons in Dividendy and Kalendář —
// runs it for THEMSELVES only: their positions, trades and auto dividends, plus the shared
// earnings calendar of their own tickers. Anything else (the public anon key, no token) is
// refused: it used to delete and re-insert every user's auto dividends for any caller.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isSchedulerToken } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NASDAQ_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nasdaq.com",
  "Referer": "https://www.nasdaq.com/",
};

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function dateStr(d: Date) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function parseUSDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
}
function parseAmount(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization");
  // null = every user (scheduler); otherwise the one signed-in user this run is limited to.
  let onlyUser: string | null = null;
  if (!isSchedulerToken(auth, [serviceKey, Deno.env.get("CRON_SECRET")])) {
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth ?? "" } } });
    const { data: userData } = await userClient.auth.getUser();
    onlyUser = userData.user?.id ?? null;
    if (!onlyUser) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
  // Narrows a user-data query to `onlyUser` (no-op for the scheduler's all-users run).
  const scoped = (q: any) => (onlyUser ? q.eq("user_id", onlyUser) : q);

  const supabase = createClient(url, serviceKey);

  // PostgREST caps a single select at 1000 rows; heavy accounts have more, so page through.
  const fetchAll = async (make: () => any) => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await make().range(from, from + 999);
      if (!data || data.length === 0) break;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  };

  try {
    // All positions (every user, or just the caller) — used to know which tickers to fetch at all.
    const positions = await fetchAll(() => scoped(supabase.from("positions").select("ticker, shares, user_id").neq("type", "Cash")));
    const heldTickers = Array.from(new Set(
      (positions || []).filter((p: any) => Number(p.shares) > 0).map((p: any) => String(p.ticker)),
    ));
    const tickerSet = new Set(heldTickers.map((t) => t.toUpperCase()));

    // All trades with broker + user, so we can compute NON-T212 holdings per user/ticker
    // (T212 dividends come from its own API; we must not double-count them here).
    const allTx = await fetchAll(() => scoped(supabase
      .from("transactions")
      .select("ticker, side, shares, executed_at, broker, ext_id, user_id")
      .neq("ticker", "CASH"))
      .order("executed_at", { ascending: true }));
    const nonT212 = (allTx || []).filter((t: any) => {
      const ext = String(t.ext_id ?? "");
      return String(t.broker ?? "").toUpperCase() !== "T212" && !ext.includes(":adj:") && !ext.includes(":pos:");
    });
    // userId|ticker -> trades (chronological), and current net shares
    const txByUT = new Map<string, any[]>();
    const nowByUT = new Map<string, number>();
    for (const t of nonT212) {
      const key = `${t.user_id}|${t.ticker}`;
      (txByUT.get(key) || txByUT.set(key, []).get(key)!).push(t);
      nowByUT.set(key, (nowByUT.get(key) ?? 0) + (t.side === "BUY" ? 1 : -1) * Number(t.shares));
    }
    // Shares held the day BEFORE an ex-date (record-date proxy), for a user+ticker.
    const sharesAt = (uid: string, ticker: string, exDate: string): number => {
      const txs = txByUT.get(`${uid}|${ticker}`) || [];
      const cutoff = new Date(exDate).getTime();
      let s = 0;
      for (const t of txs) { if (new Date(t.executed_at).getTime() >= cutoff) break; s += t.side === "BUY" ? Number(t.shares) : -Number(t.shares); }
      return Math.max(0, s);
    };
    // Total shares per user+ticker across ALL brokers (incl. T212) — used to project
    // UPCOMING dividends. T212's API only returns PAID dividends, so the future is invisible
    // without this. Past dividends keep using non-T212 shares (T212 paid come from its API).
    const totalByUT = new Map<string, number>();
    for (const p of (positions || [])) {
      const s = Number(p.shares);
      if (!(s > 0)) continue;
      const key = `${p.user_id}|${String(p.ticker)}`;
      totalByUT.set(key, (totalByUT.get(key) ?? 0) + s);
    }
    // Every ticker any user holds (any broker) gets a dividend-schedule lookup.
    const usersByTicker = new Map<string, string[]>();
    for (const [key, net] of totalByUT) {
      if (net <= 0.0001) continue;
      const [uid, ticker] = key.split("|");
      (usersByTicker.get(ticker) || usersByTicker.set(ticker, []).get(ticker)!).push(uid);
    }
    // Shares to attribute to a dividend on a given ex-date:
    //  - future ex-date -> TOTAL shares (all brokers); no API/statement row will collide.
    //  - recent past    -> current non-T212 shares (T212 paid come from its own API).
    //  - older past     -> non-T212 shares as held at that ex-date.
    const todayMs0 = Date.now();
    const sharesForDate = (uid: string, ticker: string, exStr: string): number => {
      const exMs = new Date(exStr).getTime();
      if (exMs > todayMs0) return totalByUT.get(`${uid}|${ticker}`) ?? 0;
      if (exMs >= todayMs0 - 60 * 86400000) return nowByUT.get(`${uid}|${ticker}`) ?? 0;
      return sharesAt(uid, ticker, exStr);
    };

    const errors: string[] = [];

    // ===== EARNINGS calendar (global / broker-agnostic): scan next ~60 trading days =====
    const today = new Date();
    const earningsByKey = new Map<string, any>();
    const days: string[] = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      const wd = d.getUTCDay();
      if (wd === 0 || wd === 6) continue;
      days.push(dateStr(d));
    }
    const BATCH = 16;
    for (let i = 0; i < days.length; i += BATCH) {
      const slice = days.slice(i, i + BATCH);
      await Promise.all(slice.map(async (day) => {
        try {
          const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${day}`, { headers: NASDAQ_HEADERS });
          if (!r.ok) return;
          const j = await r.json();
          for (const row of (j?.data?.rows ?? [])) {
            const sym = String(row.symbol || "").toUpperCase();
            if (!tickerSet.has(sym)) continue;
            const time = String(row.time || "").includes("after") ? "AMC" : String(row.time || "").includes("before") ? "BMO" : null;
            earningsByKey.set(`${sym}|${day}`, { ticker: sym, earnings_date: day, time_of_day: time, eps_estimate: parseAmount(row.epsForecast) });
          }
        } catch (_e) { /* ignore single-day failures */ }
      }));
    }

    // ===== DIVIDENDS (per user, non-T212 holdings) =====
    // Seed cadence from existing PAST dividends per user+ticker (resilient to provider gaps).
    const existingDivs = await fetchAll(() => scoped(supabase
      .from("dividends").select("ticker, ex_date, pay_date, amount_per_share, user_id, broker")).order("ex_date", { ascending: true }));
    const existingByUT = new Map<string, any[]>();
    // Keys (user|ticker|ex_date) that ALREADY exist from ANY source (T212 API or a broker
    // statement) — we never duplicate those; auto only fills what's genuinely missing.
    const existingKeys = new Set<string>();
    // A statement records only the PAYMENT date (stored as ex_date too), while this function
    // stores the real ex-date — so comparing ex_dates never matched and the same dividend was
    // kept twice. Recorded payment dates per user+ticker are matched by a window instead.
    const recordedPayDates = new Map<string, string[]>();
    const normT = (t: string) => String(t).toUpperCase().split(".")[0];
    for (const d of (existingDivs || [])) {
      // Only statement-imported rows (non-T212, non-auto) block an auto insert: auto-past
      // covers ONLY non-T212 shares, so it must coexist with the T212-API row for the same
      // ex-date (the display sums them). Blocking on T212 would drop the non-T212 portion.
      // Our own 'auto' rows are deleted and recomputed each run, so they never block.
      const bk = String(d.broker ?? "").toLowerCase();
      if (bk !== "auto" && bk !== "t212") {
        existingKeys.add(`${d.user_id}|${d.ticker}|${d.ex_date}`);
        const rk = `${d.user_id}|${normT(d.ticker)}`;
        (recordedPayDates.get(rk) || recordedPayDates.set(rk, []).get(rk)!).push(d.pay_date ?? d.ex_date);
      }
      if (String(d.broker ?? "").toUpperCase() === "T212") continue; // T212 handled by its API
      const key = `${d.user_id}|${d.ticker}`;
      (existingByUT.get(key) || existingByUT.set(key, []).get(key)!).push(d);
    }
    const pushedKeys = new Set<string>();
    const shiftDays = (day: string, n: number) => dateStr(new Date(new Date(day).getTime() + n * 86400000));
    const pushDiv = (row: any) => {
      const k = `${row.user_id}|${row.ticker}|${row.ex_date}`;
      if (existingKeys.has(k) || pushedKeys.has(k)) return; // statement/T212/dup already covers it
      // Same window as dedupeDividends (src/lib/dividendTax.ts): a recorded payment from 3 days
      // before the ex-date to 10 days after the pay date is this dividend.
      const from = shiftDays(row.ex_date, -3);
      const to = shiftDays(row.pay_date ?? shiftDays(row.ex_date, 40), 10);
      if ((recordedPayDates.get(`${row.user_id}|${normT(row.ticker)}`) ?? []).some((x) => x >= from && x <= to)) return;
      pushedKeys.add(k);
      dividendInserts.push(row);
    };

    const todayStr = dateStr(today);
    const nasdaqCache = new Map<string, any>();
    const dividendInserts: any[] = [];

    for (const [ticker, users] of usersByTicker) {
      // Fetch the dividend schedule once per ticker.
      const sym = ticker.split(".")[0].toUpperCase(); // META.US -> META (same schedule)
      let data = nasdaqCache.get(sym);
      if (data === undefined) {
        try {
          const r = await fetch(`https://api.nasdaq.com/api/quote/${sym}/dividends?assetclass=stocks`, { headers: NASDAQ_HEADERS });
          data = r.ok ? ((await r.json())?.data ?? null) : null;
        } catch (_e) { data = null; }
        nasdaqCache.set(sym, data);
      }
      if (!data) continue;
      const rows = data?.dividends?.rows ?? [];
      const upEx = parseUSDate(data.exDividendDate);
      const upPay = parseUSDate(data.dividendPaymentDate);
      const todayMs = Date.now();

      for (const uid of users) {
        if ((totalByUT.get(`${uid}|${ticker}`) ?? 0) <= 0) continue;

        // Recent/upcoming dividend from the header.
        if (upEx && rows.length > 0) {
          const exMs = new Date(upEx).getTime();
          if (exMs >= todayMs - 50 * 86400000) {
            const aps = parseAmount(rows[0].amount);
            const sh = sharesForDate(uid, ticker, upEx);
            if (aps && aps > 0 && sh > 0) {
              pushDiv({ ticker, ex_date: upEx, pay_date: upPay, amount_per_share: aps, shares_held: sh, total_amount_usd: aps * sh, status: exMs < todayMs ? "paid" : "upcoming", broker: "auto", user_id: uid });
            }
          }
        }
        // Historical rows (paid) — shares held at that ex-date.
        for (const row of rows) {
          const ex = parseUSDate(row.exOrEffDate);
          if (!ex) continue;
          const exMs = new Date(ex).getTime();
          if (upEx && ex === upEx) continue;
          if (exMs < todayMs - 365 * 86400000 || exMs > todayMs) continue;
          const aps = parseAmount(row.amount);
          if (!aps || aps <= 0) continue;
          const sh = sharesForDate(uid, ticker, ex);
          if (sh <= 0) continue;
          pushDiv({ ticker, ex_date: ex, pay_date: parseUSDate(row.paymentDate), amount_per_share: aps, shares_held: sh, total_amount_usd: aps * sh, status: "paid", broker: "auto", user_id: uid });
        }

        // Project from cadence (fills recent gaps + near future).
        const historicalEx: { date: Date; amount: number; payOffset: number }[] = [];
        const seenEx = new Set<string>();
        const addHist = (ex: string | null, pay: string | null, amt: number | null) => {
          if (!ex || !amt || amt <= 0 || seenEx.has(ex)) return;
          if (new Date(ex).getTime() > todayMs) return;
          seenEx.add(ex);
          const exDt = new Date(ex);
          historicalEx.push({ date: exDt, amount: amt, payOffset: pay ? Math.round((new Date(pay).getTime() - exDt.getTime()) / 86400000) : 14 });
        };
        for (const row of rows) addHist(parseUSDate(row.exOrEffDate), parseUSDate(row.paymentDate), parseAmount(row.amount));
        for (const d of (existingByUT.get(`${uid}|${ticker}`) || [])) if (d.ex_date <= todayStr) addHist(d.ex_date, d.pay_date, Number(d.amount_per_share));
        historicalEx.sort((a, b) => a.date.getTime() - b.date.getTime());

        if (historicalEx.length >= 2) {
          const intervals: number[] = [];
          for (let i = 1; i < historicalEx.length; i++) intervals.push((historicalEx[i].date.getTime() - historicalEx[i - 1].date.getTime()) / 86400000);
          intervals.sort((a, b) => a - b);
          const cadenceDays = Math.round(intervals[Math.floor(intervals.length / 2)]);
          if (cadenceDays >= 25 && cadenceDays <= 200) {
            const last = historicalEx[historicalEx.length - 1];
            // Use the provider's latest per-share amount for projections, NOT the seeded
            // history: a statement-imported dividend can carry the TOTAL in amount_per_share
            // (shares_held=1), which would otherwise be projected as a per-share amount and
            // explode the figure (e.g. MSFT $15.97 "per share" × 20 shares).
            const projAmount = parseAmount(rows[0]?.amount) ?? last.amount;
            const existingEx = new Set(dividendInserts.filter((d) => d.ticker === ticker && d.user_id === uid).map((d) => d.ex_date));
            for (let i = 1; i <= 12; i++) {
              const nextEx = new Date(last.date.getTime() + cadenceDays * i * 86400000);
              if (nextEx.getTime() > todayMs + 400 * 86400000) break;
              const nextExStr = dateStr(nextEx);
              if (existingEx.has(nextExStr)) continue;
              const isPast = nextEx.getTime() <= todayMs;
              const sh = sharesForDate(uid, ticker, nextExStr);
              if (sh <= 0) continue;
              pushDiv({ ticker, ex_date: nextExStr, pay_date: dateStr(new Date(nextEx.getTime() + last.payOffset * 86400000)), amount_per_share: projAmount, shares_held: sh, total_amount_usd: projAmount * sh, status: isPast ? "paid" : "upcoming", broker: "auto", user_id: uid });
            }
          }
        }
      }
    }

    // Replace auto-synced data. Earnings calendar is global; dividends are replaced only
    // for non-T212 (auto + statement) rows so the exact T212 API dividends stay intact.
    const earningsInserts = Array.from(earningsByKey.values());
    if (earningsInserts.length > 0) {
      await supabase.from("earnings_calendar").delete().in("ticker", heldTickers).gte("earnings_date", todayStr);
      await supabase.from("earnings_calendar").insert(earningsInserts);
    }
    const oldest = dateStr(new Date(Date.now() - 365 * 86400000));
    const userIds = Array.from(new Set((positions || []).map((p: any) => p.user_id).filter(Boolean)));
    for (const uid of userIds) {
      // Only replace our own auto rows — never the exact T212-API or statement dividends.
      await supabase.from("dividends").delete().eq("user_id", uid).eq("broker", "auto").gte("ex_date", oldest);
    }
    // Dividends land NET of withholding tax. The auto source is US-listed holdings, where
    // CZ residents pay the 15% treaty rate, so the cash received = gross × 0.85 (this is
    // what the broker shows). Apply it so the tracked amount matches reality.
    const US_WHT = 0.15;
    for (const d of dividendInserts) {
      d.amount_per_share = d.amount_per_share * (1 - US_WHT);
      d.total_amount_usd = d.total_amount_usd * (1 - US_WHT);
    }
    if (dividendInserts.length > 0) await supabase.from("dividends").insert(dividendInserts);

    return new Response(JSON.stringify({
      tickers: heldTickers.length,
      earnings_count: earningsInserts.length,
      dividends_count: dividendInserts.length,
      errors: errors.slice(0, 10),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
