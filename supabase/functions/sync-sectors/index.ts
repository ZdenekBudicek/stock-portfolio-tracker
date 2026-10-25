// Fill public.ticker_profiles for every ticker held or watched by ANY user.
//
// Finnhub only: Yahoo answers 401 and Stooq 404 from the Supabase edge IP (documented in
// refresh-prices/index.ts). The nightly GitHub worker runs the Yahoo pass from a clean IP
// and refines whatever this function guessed — see scripts/sector-worker.mjs.
//
// This function owns finnhub_miss_count and NOTHING ELSE about the Yahoo path: it never
// reads or writes yahoo_miss_count, and it never overwrites a row Yahoo has already
// classified. The two providers fail independently and their backoffs must too.
//
// Idempotent: safe to call after every broker sync and to overlap with the nightly worker.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { cryptoBase } from "../_shared/crypto.js";
import { mapSector } from "../_shared/sectors.js";
import { fetchFinnhubProfile } from "../_shared/profile-providers.ts";
import { isSchedulerToken } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ONE invocation does at most this many lookups and reports what is left over; the next
// call (auto-sync fires this after every broker sync) and the nightly worker pick up the
// rest. Two limits force the cap and neither is negotiable inside a request:
//   - Finnhub free tier = 60 calls/min, so a single run must stay under 60.
//   - An edge function is killed on a bounded wall clock (order of minutes, not hours),
//     and the kill is not graceful — anything not yet written is simply lost.
// Sleeping 60 s between batches inside a request-scoped handler spends that wall-clock
// budget doing nothing and buys only one extra batch before the kill, so there is no
// sleep here at all. Precedent: price-providers.ts fetchTwelveData caps at 8 symbols per
// invocation for exactly the same reason.
const MAX_PER_RUN = 50;
// Hard stop for the fetch loop, so a slow provider cannot push the run into the platform
// kill and lose the rows already collected: we break, write what we have and report the
// rest as remaining. Checked BETWEEN calls only — the per-request timeout that bounds a
// single hung socket lives in fetchFinnhubProfile.
const FETCH_BUDGET_MS = 60_000;
// Rows younger than this are considered fresh and are not re-fetched.
const FRESH_DAYS = 90;
// After this many consecutive EMPTY answers (never: failures to reach Finnhub), stop
// asking until a human passes ?force=TICKER.
const MAX_MISSES = 5;
// Consecutive lookups that reached nobody before we abandon the run. See the comment at
// the loop: this bounds one invocation, it never freezes a ticker.
const OUTAGE_STREAK = 5;
// The only values public.ticker_profiles.asset_type accepts (CHECK constraint in
// 20260809100000_ticker_profiles.sql). One violating row aborts the WHOLE statement — an
// upsert is a single INSERT ... ON CONFLICT — so nothing at all gets written. Everything is
// funnelled through assetType() below rather than trusted.
const ASSET_TYPES = new Set(["EQUITY", "ETF", "CRYPTO"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // 200 + ok:false for "we could not do the work": the caller is fire-and-forget
  // (auto-sync must never fail because of the sector sync) and the body carries the truth.
  // A 500 is reserved for an unexpected throw, same as sync-earnings.
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY") ?? "";

  // ?force=NBIS,SOFI — the escape hatch. Bypasses every rank() rule and treats the ticker
  // as having no history, so a row frozen at MAX_MISSES can be retried without hand-written
  // SQL against production. Applies to the tickers someone actually holds or watches; the
  // rest are reported back as forcedUnknown rather than silently ignored.
  const forced = new Set(
    (new URL(req.url).searchParams.get("force") ?? "")
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
  // Only the scheduler/operator may force (audit B8): it bypasses the backoff and spends the shared Finnhub
  // quota, and its answer lists which tickers anyone holds. A signed-in app call runs the normal ranked pass.
  if (forced.size && !isSchedulerToken(req.headers.get("Authorization"), [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("CRON_SECRET")])) {
    return reply({ ok: false, error: "force requires the scheduler key" }, 403);
  }

  try {
    const errors: string[] = [];
    const note = (msg: string) => { if (errors.length < 12) errors.push(msg); };

    // PostgREST caps a single select at 1000 rows and returns the first page SILENTLY, so
    // every read pages through — same helper as sync-earnings. positions overflows first
    // (one row per user × ticker × broker account), but a truncated ticker_profiles is the
    // dangerous one: the missing rows would look like tickers we have never fetched, so
    // finnhub_miss_count would restart at 1 every run and never reach MAX_MISSES.
    //
    // Each read is ORDERED BY ITS PRIMARY KEY. Postgres gives no stable ordering for
    // LIMIT/OFFSET without one, and this function is designed to overlap with the nightly
    // worker's writes, so unordered pages can shift under us and drop rows — reproducing
    // the exact truncation bug the pagination exists to prevent. (Ordering makes paging
    // deterministic, not transactional: a row DELETED mid-scan still shifts later pages up.
    // Nothing deletes from these tables during a run, so that residual is theoretical.)
    const fetchAll = async <T>(label: string, make: () => { range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> => {
      const out: T[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await make().range(from, from + 999);
        if (error) { note(`${label}: ${error.message}`); break; }
        if (!data || data.length === 0) break;
        out.push(...data);
        if (data.length < 1000) break;
      }
      return out;
    };

    // 1. Every ticker anyone holds or watches, plus the state we already have.
    const [positions, watch, aliases, existing] = await Promise.all([
      // Cash is excluded in JS, not with .neq("type","Cash"). In SQL `type <> 'Cash'` is
      // NULL — not true — for a NULL type, so a server-side filter silently drops those
      // rows, and a shorter result set reads here as "nothing to do". The column is
      // `not null default 'Stock'` today so nothing is actually being dropped, but the
      // predicate below cannot break if that ever changes, and it matches the one
      // price-worker.mjs already uses. `shares` stays a server-side filter: it is likewise
      // `not null`, and it is the one that meaningfully shrinks the payload for accounts
      // with many closed positions.
      fetchAll("positions", () => svc.from("positions")
        .select("ticker,type").gt("shares", 0).order("id")),
      fetchAll("watchlist", () => svc.from("watchlist").select("ticker").order("id")),
      // Only alias→canonical here. ticker_alias.yahoo_symbol exists for the provider that
      // needs a suffixed symbol (VUSA.L); Finnhub takes the plain canonical, and resolving
      // yahoo_symbol is the nightly worker's job, not this one's.
      fetchAll("ticker_alias", () => svc.from("ticker_alias")
        .select("alias,canonical").order("alias")),
      fetchAll("ticker_profiles", () => svc.from("ticker_profiles")
        .select("ticker,name,sector_raw,industry_raw,sector,asset_type,source,finnhub_miss_count,fetched_at")
        .order("ticker")),
    ]);
    // Write nothing on a failed read. A partial ticker_alias would file profiles under the
    // wrong (non-canonical) ticker and a partial ticker_profiles would corrupt the miss
    // counter; both are worse than doing nothing and being called again in a minute.
    if (errors.length) return reply({ ok: false, stage: "read", errors });

    // 2. Resolve broker tickers to the canonical symbol so FB/IPOE/VACQ share one profile.
    const isCash = (p: { ticker: string; type?: string }) => p.ticker === "CASH" || String(p.type ?? "") === "Cash";
    const all = Array.from(new Set([
      ...positions.filter((p) => !isCash(p)).map((p) => p.ticker),
      ...watch.map((w) => w.ticker),
    ])).filter((t: string) => t && t.toUpperCase() !== "CASH");
    const canonOf = new Map<string, string>(
      aliases.map((a) => [String(a.alias ?? "").trim().toUpperCase(), String(a.canonical ?? "").trim().toUpperCase()]),
    );
    // `||`, not `??`: ticker_alias.canonical is NOT NULL but nothing stops it holding "" or
    // whitespace, and `??` would pass that straight through — Finnhub queried for "" and a
    // ticker_profiles row keyed on "". trim+upper matches how the nightly worker and the
    // frontend hook normalise, so all three agree on the key by construction.
    const up = (t: unknown) => String(t ?? "").trim().toUpperCase();
    const canon = (t: string) => canonOf.get(up(t)) || up(t);
    const canonical = Array.from(new Set(all.map((t: string) => canon(t))));
    const prior = new Map<string, typeof existing[number]>(
      existing.map((r) => [String(r.ticker).toUpperCase(), r]),
    );
    // ?force=FB has to mean ?force=META, or the escape hatch misses exactly the rows the
    // alias table exists for.
    const force = new Set(Array.from(forced).map((t) => canon(t)));
    const forcedUnknown = Array.from(force).filter((t) => !canonical.includes(t));

    const assetType = (v: unknown): string => {
      const s = typeof v === "string" ? v.trim().toUpperCase() : "";
      return ASSET_TYPES.has(s) ? s : "EQUITY";
    };
    // Every row handed to upsert() is built here, so they all carry the SAME keys.
    // NOT because PostgREST rejects mismatched keys — it does not. supabase-js reduces the
    // array to the UNION of all rows' keys and sends it as the `columns` query parameter
    // (PostgrestQueryBuilder.ts:1359-1363), and upsert defaults to defaultToNull:true, so a
    // row that merely OMITS a key has NULL written into that column on the conflict branch.
    // An asymmetric batch therefore does not fail loudly — it silently nulls name,
    // sector_raw and industry_raw on rows the Yahoo worker had filled in.
    const mkRow = (ticker: string, p: {
      name?: string | null;
      sectorRaw?: string | null;
      industryRaw?: string | null;
      sector?: string | null;
      assetType?: unknown;
      source: string;
      missCount: number;
    }) => ({
      ticker,
      name: p.name ?? null,
      sector_raw: p.sectorRaw ?? null,
      industry_raw: p.industryRaw ?? null,
      sector: p.sector ?? null,
      asset_type: assetType(p.assetType),
      source: p.source,
      finnhub_miss_count: p.missCount,
      fetched_at: new Date().toISOString(),
    });

    const write = async (label: string, q: PromiseLike<{ error: { message: string } | null; count: number | null }>): Promise<number> => {
      const { error, count } = await q;
      // Report the failure instead of swallowing it: a caller told "ok, 40 resolved" when
      // the table is untouched will not retry, and the same lookups burn the quota again.
      if (error) { note(`${label}: ${error.message}`); return 0; }
      return Number(count) || 0;
    };

    // 3. Crypto never goes to a stock-profile API — classify and write it straight away.
    // Only the rows that would actually change: rewriting a correct row every invocation
    // just to move fetched_at is pure write amplification on a table with no index to help.
    const cryptoRows = canonical
      .filter((t) => cryptoBase(t))
      .filter((t) => prior.get(t)?.sector !== "Krypto" || force.has(t))
      .map((t) =>
        mkRow(t, {
          // NOT the ticker: "BTCUSD" is not a name, and writing it as one makes the column
          // lie to anyone reading the table. null means "we do not know", which is true,
          // and carrying the previous value forward means a hand-typed name survives.
          name: prior.get(t)?.name ?? null,
          // TICKER_OVERRIDES is consulted before assetType in mapSector, but no key of
          // CRYPTO_TO_GECKO appears there (overrides are NU/META/GOOGL/GOOG/MSTR/MARA/
          // RIOT/HOOD — all equities), so this is always "Krypto".
          sector: mapSector({ ticker: t, assetType: "CRYPTO" }),
          assetType: "CRYPTO",
          source: "static",
          missCount: 0,
        })
      );
    let cryptoWritten = 0;
    if (cryptoRows.length) {
      cryptoWritten = await write(
        "crypto",
        svc.from("ticker_profiles").upsert(cryptoRows, { onConflict: "ticker", count: "exact" }),
      );
    }

    // 4. Decide what to look up, and in which order. With a per-run cap the order matters:
    // a ticker bought five minutes ago must not queue behind two hundred 91-day-old
    // refreshes, or the "sector appears right after the broker sync" promise breaks.
    //   0 forced   1 never seen   2 unresolved & backoff elapsed   3 stale   -1 skip
    // The backoff (2^finnhub_miss_count days) mirrors the nightly worker's rule on its own
    // counter: without it, auto-sync running several times an hour burns all five misses in
    // an afternoon and freezes the ticker out on the strength of one bad hour.
    const now = Date.now();
    const rank = (t: string): number => {
      if (force.has(t)) return 0;
      const p = prior.get(t);
      if (!p) return 1;
      const stamp = Date.parse(p.fetched_at);
      // An unparseable fetched_at must not freeze a row out — NaN loses every comparison,
      // which would read as "brand new and not yet due". Treat it as infinitely old.
      const age = Number.isFinite(stamp) ? now - stamp : Infinity;
      if (!p.sector) {
        const misses = Number(p.finnhub_miss_count) || 0;
        if (misses >= MAX_MISSES) return -1;
        // Backoff applies ONLY once Finnhub has actually come back empty at least once.
        // finnhub_miss_count === 0 on an unresolved row means "Finnhub has never returned
        // empty for this symbol", so there is no backoff to serve and age is irrelevant.
        // Without this the counters are split but fetched_at is still SHARED, so the Yahoo
        // path re-couples them through the timestamp: the nightly worker writes
        // {yahoo_miss_count: 1, fetched_at: now} on a Yahoo miss (sector-worker.mjs, the
        // missPatches branch), and six hours later 2^0 = 1 day of backoff is measured
        // against that fresh stamp and blocks a provider that was never asked. Same rule,
        // same reason, as rankTicker()'s `if (misses > 0)` in the worker.
        if (misses === 0) return 2;
        return age > Math.pow(2, misses) * 86_400_000 ? 2 : -1;
      }
      // Never re-fetch what Yahoo already classified. Yahoo gives sector AND industry;
      // Finnhub gives one coarse industry string, so a "refresh" here would DOWNGRADE the
      // row and flip source to finnhub — the exact inverse of the design, where the worker
      // refines what this function guessed. Yahoo-resolved rows are the worker's to
      // refresh. If the worker dies permanently they go stale, which is the cheap failure:
      // a sector changes on the order of never, and stale-but-precise beats fresh-but-coarse.
      if (p.source === "yahoo") return -1;
      return age > FRESH_DAYS * 86_400_000 ? 3 : -1;
    };
    const eligible = canonical
      .filter((t) => !cryptoBase(t))
      .map((t) => [t, rank(t)] as [string, number])
      .filter(([, r]) => r >= 0)
      .sort((a, b) => a[1] - b[1]) // stable, so ranks keep their input order within a tier
      .map(([t]) => t);
    const queue = eligible.slice(0, MAX_PER_RUN);

    if (!finnhubKey) {
      return reply({
        ok: false, error: "FINNHUB_API_KEY not configured",
        todo: queue.length, remaining: eligible.length, crypto: cryptoWritten, errors,
      });
    }

    // 5. Fetch and sort each answer into one of four write paths. One bad ticker never
    // aborts the run.
    const deadline = Date.now() + FETCH_BUDGET_MS;
    let resolved = 0, missed = 0, failed = 0, checked = 0;
    const resolvedRows: Array<Record<string, unknown>> = [];  // full row, merge on conflict
    const newMissRows: Array<Record<string, unknown>> = [];   // insert only if still absent
    const missUpdates: Array<[string, Record<string, unknown>]> = []; // guarded narrow update
    const keptTickers: string[] = [];                          // fetched_at only
    // Finnhub answered but mapSector() has no rule for what it said. Reported so the fix
    // loop — add a rule to _shared/sectors.js, then ?force= the ticker — does not depend on
    // somebody thinking to go and run the SQL. Bounded to this run's lookups.
    const unmapped: Array<{ ticker: string; industry_raw: string | null }> = [];
    // Circuit breaker. A revoked or expired key answers 401 on every call, which is an
    // `error`, which by design leaves the row untouched — so the next run builds the exact
    // same queue and does it all again, and auto-sync fires this after every broker sync.
    // Breaking out bounds ONE run; it is not a persistent lockout, and it moves no counter,
    // so the untouched rows rank identically next time. The nightly worker does the same at
    // 20, sized for its few-hundred-ticker queue; 5 of a 50-cap run is the same 10% signal,
    // and a burst of consecutive failures is precisely the shape of a rate-limit or a dead
    // key rather than of a handful of odd symbols.
    let failStreak = 0;

    for (const ticker of queue) {
      if (checked > 0 && Date.now() > deadline) break;
      checked++;
      const before = prior.get(ticker);
      // force = "do not hold this ticker's history against it".
      const prevMiss = force.has(ticker) ? 0 : Number(before?.finnhub_miss_count) || 0;
      const res = await fetchFinnhubProfile(ticker, finnhubKey);

      // We never reached Finnhub (429, 5xx, timeout, bad key). That is not evidence about
      // this symbol, so the row is left ENTIRELY alone — not even fetched_at moves, or a
      // rate-limited run would silently mark every ticker as freshly checked.
      if (res.status === "error") {
        failed++;
        note(`${ticker}: ${res.detail}`);
        if (++failStreak >= OUTAGE_STREAK) {
          note(`aborted: ${failStreak} lookups in a row reached nobody`);
          break;
        }
        continue;
      }
      failStreak = 0;

      const profile = res.status === "ok" ? res.profile : null;
      const sector = profile ? mapSector(profile) : null;
      if (profile && !sector && unmapped.length < 25) {
        unmapped.push({ ticker, industry_raw: profile.industryRaw });
      }

      if (profile && sector) {
        resolved++;
        // Known, accepted race: `prior` is a snapshot, so if the nightly worker resolved
        // this row with Yahoo while we were fetching, this upsert overwrites it with the
        // coarser Finnhub answer. Left alone deliberately — PostgREST has no conditional
        // upsert, and the row lands source='finnhub', which the worker re-fetches at any
        // age, so it self-heals on the next nightly run.
        resolvedRows.push(mkRow(ticker, {
          name: profile.name ?? before?.name ?? null,
          // parseFinnhubProfile ALWAYS sets sectorRaw null — Finnhub has no sector field —
          // so without this fallback every Finnhub answer wipes a sector_raw Yahoo put
          // there. The raw columns are diagnostic and may end up mixed-provenance; `source`
          // names the provider that decided `sector`, which is what anything keys off.
          sectorRaw: profile.sectorRaw ?? before?.sector_raw ?? null,
          industryRaw: profile.industryRaw ?? before?.industry_raw ?? null,
          sector,
          assetType: profile.assetType,
          source: "finnhub",
          missCount: 0,
        }));
        continue;
      }

      // Finnhub answered and has nothing usable for this symbol.
      if (before?.sector) {
        // Already classified — refreshing found nothing better. Record ONLY that we looked,
        // so the 90-day refresh does not retry on every invocation. Touching any other
        // column would write back a snapshot read up to a minute ago, over whatever the
        // nightly worker may have resolved in the meantime.
        keptTickers.push(ticker);
        continue;
      }

      missed++;
      if (!before) {
        newMissRows.push(mkRow(ticker, {
          name: profile?.name ?? null,
          sectorRaw: profile?.sectorRaw ?? null,
          industryRaw: profile?.industryRaw ?? null,
          sector: null,
          assetType: profile?.assetType,
          source: "finnhub",
          missCount: prevMiss + 1,
        }));
        continue;
      }
      // Existing unresolved row: a narrow UPDATE guarded on the sector still being NULL.
      // `prior` was read before up to a minute of fetching; an unconditional upsert here
      // would write sector:null over a sector the nightly worker resolved inside that
      // window. An UPDATE also touches only the columns named, so nothing else can be
      // clobbered by a stale snapshot.
      const patch: Record<string, unknown> = {
        finnhub_miss_count: prevMiss + 1,
        fetched_at: new Date().toISOString(),
      };
      if (profile) {
        patch.name = profile.name ?? before.name ?? null;
        patch.sector_raw = profile.sectorRaw ?? before.sector_raw ?? null;
        patch.industry_raw = profile.industryRaw ?? before.industry_raw ?? null;
        patch.asset_type = assetType(profile.assetType);
        patch.source = "finnhub";
      }
      missUpdates.push([ticker, patch]);
    }

    let written = cryptoWritten;
    if (resolvedRows.length) {
      written += await write(
        "resolved",
        svc.from("ticker_profiles").upsert(resolvedRows, { onConflict: "ticker", count: "exact" }),
      );
    }
    if (newMissRows.length) {
      // Insert-if-absent. If the nightly worker created the row while we were fetching, its
      // answer is better than our "nothing found" and must survive untouched.
      written += await write(
        "new misses",
        svc.from("ticker_profiles")
          .upsert(newMissRows, { onConflict: "ticker", ignoreDuplicates: true, count: "exact" }),
      );
    }
    for (const [ticker, patch] of missUpdates) {
      written += await write(
        `miss ${ticker}`,
        svc.from("ticker_profiles").update(patch, { count: "exact" })
          .eq("ticker", ticker).is("sector", null),
      );
    }
    if (keptTickers.length) {
      written += await write(
        "kept",
        svc.from("ticker_profiles")
          .update({ fetched_at: new Date().toISOString() }, { count: "exact" })
          .in("ticker", keptTickers),
      );
    }

    // resolved/missed/kept/failed count LOOKUPS; written counts rows the database actually
    // changed. They differ when a write failed, when a guarded update matched nothing
    // because someone else resolved the row first, and — by design — for every `failed`.
    return reply({
      ok: errors.length === 0,
      checked, resolved, missed, kept: keptTickers.length, failed,
      crypto: cryptoWritten,
      written,
      // Everything we never got to, PLUS everything that errored: an unreached ticker's row
      // is untouched, so it ranks identically on the next run and is still outstanding.
      remaining: eligible.length - checked + failed,
      ...(force.size ? { forced: Array.from(force) } : {}),
      ...(forcedUnknown.length ? { forcedUnknown } : {}),
      ...(unmapped.length ? { unmapped } : {}),
      errors,
    });
  } catch (e) {
    return reply({ ok: false, error: (e as Error).message }, 500);
  }
});
