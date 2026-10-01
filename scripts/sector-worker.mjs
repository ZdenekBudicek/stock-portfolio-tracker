// Nightly Yahoo sector pass. The counterpart of supabase/functions/sync-sectors/index.ts.
//
// The two writers are split by NETWORK REACHABILITY, not by preference:
//   - The edge function runs on the Supabase edge, where Yahoo answers 401 and Stooq 404.
//     It has Finnhub only, and Finnhub returns one coarse `finnhubIndustry` string with no
//     sector at all.
//   - This worker runs from GitHub Actions, where the IP is clean and Yahoo works. Yahoo
//     returns sector AND industry separately, which maps far more precisely.
// So this job REFINES what the edge function guessed: every row it left at source='finnhub'
// is re-fetched here regardless of age, and a Yahoo answer replaces the coarse guess.
//
// This worker owns yahoo_miss_count and NOTHING ELSE about the Finnhub path: it never reads
// or writes finnhub_miss_count (the column is not even selected, and is absent from every
// payload, so an upsert leaves it untouched on the conflict branch). The two providers fail
// independently and their backoffs must too — see the column comments in
// 20260809100000_ticker_profiles.sql.
//
// Idempotent: safe to re-run, safe to overlap with the edge function's writes.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, FINNHUB_API_KEY (optional fallback)
//
// NOTE ON NODE VERSION: this file imports _shared/profile-providers.ts, so it needs a Node
// with TypeScript type stripping — Node 24 (or >= 22.18). Under Node 20 the import dies with
// ERR_UNKNOWN_FILE_EXTENSION ".ts" before a single line runs. .github/workflows/price-history.yml
// pins the sectors job to Node 24 for exactly this reason.

import { pathToFileURL } from "node:url";
import { cryptoBase } from "../supabase/functions/_shared/crypto.js";
import { mapSector } from "../supabase/functions/_shared/sectors.js";
import { fetchFinnhubProfile, parseYahooProfile } from "../supabase/functions/_shared/profile-providers.ts";

const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

const DAY_MS = 86_400_000;
// Rows younger than this are fresh and are not re-fetched. Only applies to rows Yahoo has
// already classified; a source='finnhub' row is re-fetched at any age (see rankTicker).
const FRESH_DAYS = 90;
// After this many consecutive EMPTY Yahoo answers (never: failures to REACH Yahoo) we stop
// asking. The row keeps whatever sector it has; the edge function still works it on its own
// counter. Clearing yahoo_miss_count by hand is the way back.
const MAX_MISSES = 5;
// Node's fetch has NO default timeout. Without this a single hung socket stalls the whole
// nightly run indefinitely — there is no platform kill on a GitHub runner to save us, the
// job would just sit there until the 6-hour Actions limit. Same value as fetchFinnhubProfile.
const FETCH_TIMEOUT_MS = 8000;
// Politeness between tickers. This runs nightly with no wall-clock pressure, so unlike the
// edge function there is NO per-run cap — we would rather take an hour than leave rows behind.
const SLEEP_MS = 1200;
// ...but a run where nothing at all is reachable is not worth an hour. See failStreak.
const OUTAGE_STREAK = 20;
// Yahoo rejects the default Node UA.
const UA = "Mozilla/5.0";
// The only values ticker_profiles.asset_type accepts (CHECK constraint). One violating row
// aborts the WHOLE statement — an upsert is a single INSERT ... ON CONFLICT — so nothing at
// all gets written. Everything is funnelled through assetType() rather than trusted.
const ASSET_TYPES = new Set(["EQUITY", "ETF", "CRYPTO"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (t) => String(t ?? "").trim().toUpperCase();
const H = { apikey: K, Authorization: `Bearer ${K}` };

// ---- pure helpers (exported for unit tests; no IO) --------------------------------

/** Coerce anything into a value the asset_type CHECK constraint accepts. */
export function assetType(v) {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return ASSET_TYPES.has(s) ? s : "EQUITY";
}

/**
 * Which symbol to ASK YAHOO for. The ticker_profiles row is always keyed on the canonical
 * ticker; this is only the query string.
 *
 * ~18 seeded ticker_alias rows have canonical = alias with the actually-resolvable symbol
 * only in yahoo_symbol (BATSl->BATS.L, ELF_EQ_US->ELF, BRK_B->BRK-B, TLRY1->TLRY, ...). The
 * edge function deliberately ignores that column — Finnhub takes the plain canonical — and
 * leaves it to us. Same approach as scripts/price-worker.mjs, whose heuristic fallback is
 * mirrored here minus its crypto map (crypto never reaches this function).
 *
 * @param {string} ticker canonical, upper-cased
 * @param {Map<string,string>} yahooByCanon UPPER-CASED canonical -> yahoo_symbol
 */
export function yahooQuerySymbol(ticker, yahooByCanon) {
  const t = up(ticker);
  const mapped = yahooByCanon && yahooByCanon.get(t);
  if (mapped) return mapped;
  return t.replace(/_US_EQ$/, "").replace(/_EQ$/, "").replace(/\./g, "-");
}

/**
 * What to do with one ticker, from its stored row alone. Lower rank = fetched earlier.
 *   1  never seen
 *   2  resolved by someone other than Yahoo (or never attributed) -> REFINE, at any age
 *   3  Yahoo has come back empty before and the backoff has elapsed
 *   4  Yahoo-resolved and older than FRESH_DAYS
 *  -1  skip
 *
 * Gates on yahoo_miss_count ONLY. finnhub_miss_count is not read here, is not even selected
 * from the table, and must never influence this decision — that separation is the entire
 * reason the migration has two columns.
 *
 * The backoff runs BEFORE the "refine a finnhub row at any age" rule on purpose. "Regardless
 * of age" means the 90-day freshness rule does not apply; it does not mean the backoff is
 * void. Without this ordering, a symbol Yahoo simply does not know (a delisted legacy ticker,
 * say) would be asked about every single night forever, and yahoo_miss_count — a column that
 * exists precisely for those rows — would never gate anything.
 *
 * @param {object|undefined} prior the ticker_profiles row, or undefined when absent
 * @param {number} now epoch ms
 */
export function rankTicker(prior, now) {
  if (!prior) return 1;
  const misses = Number(prior.yahoo_miss_count) || 0;
  if (misses >= MAX_MISSES) return -1;
  const stamp = Date.parse(prior.fetched_at);
  // An unparseable fetched_at must not freeze a row out; treat it as infinitely old.
  const age = Number.isFinite(stamp) ? now - stamp : Infinity;
  if (misses > 0) return age > Math.pow(2, misses) * DAY_MS ? 3 : -1;
  // The point of this worker: Yahoo's sector+industry pair beats Finnhub's single coarse
  // string, so anything Yahoo has not decided is re-fetched at any age.
  if (prior.source !== "yahoo") return 2;
  return age > FRESH_DAYS * DAY_MS ? 4 : -1;
}

/**
 * Build one ticker_profiles row. EVERY row handed to a bulk POST is built here, so they all
 * carry the SAME keys — PostgREST rejects a batch whose objects disagree on their key set.
 *
 * Three review defects are structurally impossible here, which is why the carry-forwards
 * live inside this function and not at the call sites:
 *
 *  1. `name` is never nulled out by a fetch that did not carry one. parseYahooProfile returns
 *     name:null on the quoteSummary branch — Yahoo's assetProfile module genuinely has no
 *     name field — and this worker re-fetches every source='finnhub' row, so a naive
 *     `name: profile.name` would wipe every name the edge function wrote on the FIRST run.
 *  2. `sector` is never demoted to null over a value we already have.
 *  3. `asset_type` falls back to the stored value rather than defaulting an ETF to EQUITY.
 *
 * finnhub_miss_count is deliberately ABSENT. A PostgREST upsert only writes the columns
 * present in the payload, so on the conflict branch that column keeps its stored value.
 * Adding it here would hand this job control of the other provider's backoff.
 */
export function mkProfileRow(ticker, profile, before, opts) {
  const o = opts || {};
  return {
    ticker,
    name: profile?.name ?? before?.name ?? null,
    // The raw columns are diagnostic and may end up mixed-provenance (Finnhub never sets
    // sectorRaw at all); `source` names the provider that decided `sector`, which is what
    // anything downstream keys off.
    sector_raw: profile?.sectorRaw ?? before?.sector_raw ?? null,
    industry_raw: profile?.industryRaw ?? before?.industry_raw ?? null,
    sector: o.sector ?? before?.sector ?? null,
    asset_type: assetType(profile?.assetType ?? before?.asset_type),
    source: o.source ?? before?.source ?? null,
    yahoo_miss_count: o.missCount,
    fetched_at: o.at,
  };
}

// ---- supabase REST ----------------------------------------------------------------

/**
 * Paged read. PostgREST caps a single select at 1000 rows and returns the first page
 * SILENTLY, so every read pages.
 *
 * Unlike price-worker.mjs's rest(), this one THROWS instead of returning what it has. A
 * truncated ticker_profiles read is not a smaller run, it is a CORRUPT one: the missing rows
 * look like tickers we have never fetched, so yahoo_miss_count restarts at 1 and never
 * reaches MAX_MISSES, and a row with a sector would be re-fetched and re-written from
 * scratch. Doing nothing and being run again tomorrow is strictly better.
 *
 * The caller must pass an `order` on the primary key. Postgres gives no stable ordering for
 * LIMIT/OFFSET without one, and this job is designed to overlap with the edge function's
 * writes, so unordered pages shift under us and drop rows — reproducing the exact truncation
 * the paging exists to prevent.
 */
async function rest(path) {
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const r = await fetch(`${U}/rest/v1/${path}`, { headers: { ...H, Range: `${f}-${f + 999}` } });
    if (!r.ok) throw new Error(`read ${path.split("?")[0]}: HTTP ${r.status} ${await r.text()}`);
    const p = await r.json();
    if (!Array.isArray(p)) throw new Error(`read ${path.split("?")[0]}: unexpected payload`);
    rows.push(...p);
    if (p.length < 1000) break;
  }
  return rows;
}

// Rows the database actually changed, as reported by Content-Range when count=exact is
// honoured. Falls back to the number of rows sent, which is an upper bound.
const changedFrom = (res, sent) => {
  const m = /\/(\d+)$/.exec(res.headers.get("content-range") || "");
  return m ? Number(m[1]) : sent;
};

const errors = [];
const note = (msg) => { if (errors.length < 40) errors.push(msg); console.log(`  ! ${msg}`); };

/** POST /ticker_profiles. resolution: "merge-duplicates" (overwrite) | "ignore-duplicates". */
async function upsertProfiles(label, rows, resolution) {
  let changed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${U}/rest/v1/ticker_profiles?on_conflict=ticker`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: `resolution=${resolution},return=minimal,count=exact` },
      body: JSON.stringify(chunk),
    });
    // Surface the failure instead of swallowing it: a log saying "40 resolved" when the table
    // is untouched means nobody retries and the same lookups burn the quota again tomorrow.
    if (!r.ok) { note(`${label}: HTTP ${r.status} ${await r.text()}`); continue; }
    changed += changedFrom(r, chunk.length);
  }
  return changed;
}

/** PATCH one row. `filter` carries the guard (e.g. "&sector=is.null"). */
async function patchProfile(ticker, patch, filter = "") {
  const r = await fetch(`${U}/rest/v1/ticker_profiles?ticker=eq.${encodeURIComponent(ticker)}${filter}`, {
    method: "PATCH",
    headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal,count=exact" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) { note(`patch ${ticker}: HTTP ${r.status} ${await r.text()}`); return 0; }
  return changedFrom(r, 1);
}

// ---- yahoo ------------------------------------------------------------------------

async function getJson(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    return { ok: true, json: await r.json() };
  } catch (e) {
    // Transport failure, abort/timeout, or a body that is not JSON. Never the symbol's fault.
    return { ok: false, detail: e?.name || "fetch failed" };
  }
}

/**
 * One Yahoo lookup, returning the same ok/empty/error union as fetchFinnhubProfile.
 *
 * quoteSummary?modules=assetProfile has required a crumb + cookie since 2023 and may simply
 * never work from a bare fetch. It is tried first because it is the richer answer, and ANY
 * shortfall — 401, 5xx, timeout, or a 200 whose assetProfile is empty — falls through to
 * v1/finance/search, which still returns sector/industry (and quoteType, so ETFs classify)
 * unauthenticated. parseYahooProfile already handles both shapes; there is no second parser.
 *
 * ONLY the search endpoint can produce "empty". A quoteSummary that parses to nothing is not
 * evidence about the symbol: assetProfile is legitimately empty for every ETF, so counting it
 * as a miss would burn all five misses on instruments search classifies perfectly.
 */
async function fetchYahooProfile(querySymbol) {
  const sym = encodeURIComponent(querySymbol);
  const qs = await getJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=assetProfile`);
  if (qs.ok) {
    const p = parseYahooProfile(querySymbol, qs.json);
    if (p) return { status: "ok", profile: p, via: "quoteSummary" };
  }
  const se = await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${sym}&quotesCount=5&newsCount=0`);
  if (!se.ok) {
    return { status: "error", detail: `quoteSummary ${qs.ok ? "no assetProfile" : qs.detail}, search ${se.detail}` };
  }
  const p = parseYahooProfile(querySymbol, se.json);
  return p ? { status: "ok", profile: p, via: "search" } : { status: "empty" };
}

// ---- main -------------------------------------------------------------------------

async function main() {
  if (!U || !K) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
  if (!FINNHUB_KEY) console.log("! FINNHUB_API_KEY not set — Yahoo only, no fallback");

  // 1. Every ticker anyone holds or watches, plus the state we already have. EVERY read is
  // ordered by its primary key (see rest()). ticker_profiles deliberately does NOT select
  // finnhub_miss_count — this job has no business knowing it.
  const [positions, watch, aliases, existing] = await Promise.all([
    rest("positions?select=ticker,type&shares=gt.0&order=id.asc"),
    rest("watchlist?select=ticker&order=id.asc"),
    rest("ticker_alias?select=alias,canonical,yahoo_symbol&order=alias.asc"),
    rest("ticker_profiles?select=ticker,name,sector_raw,industry_raw,sector,asset_type,source,yahoo_miss_count,fetched_at&order=ticker.asc"),
  ]);

  // Cash is filtered in JS, not with .neq("type","Cash"): `type <> 'Cash'` is NULL for a row
  // whose type is NULL, so a server-side filter silently drops those rows. Same test as
  // price-worker.mjs. This makes our ticker set a SUPERSET of the edge function's, which is
  // the safe direction — an extra ticker just gets a profile nobody asked for.
  const isCash = (p) => up(p.ticker) === "CASH" || String(p.type ?? "") === "Cash";

  const all = [...new Set([
    ...positions.filter((p) => !isCash(p)).map((p) => p.ticker),
    ...watch.map((w) => w.ticker),
  ])].map(up).filter((t) => t && t !== "CASH");

  // Resolve broker tickers to the canonical symbol so FB/IPOE/VACQ share one profile row.
  // Upper-cased on BOTH sides, exactly like the edge function: ticker_profiles.ticker is a
  // case-SENSITIVE text primary key, so writing 'BATSl' where the edge function wrote 'BATSL'
  // creates a second row per instrument and both halves of the pair stay half-filled forever.
  const canonOf = new Map(aliases.map((a) => [up(a.alias), up(a.canonical)]));
  // filter(Boolean): a ticker_alias row with a NULL/blank canonical would otherwise map a
  // real ticker to "", and we would query Yahoo for the empty string and key a row on it.
  const canonical = [...new Set(all.map((t) => canonOf.get(t) || t))].filter(Boolean);

  // canonical -> yahoo_symbol. Keyed on the UPPER-CASED canonical because that is what the
  // profile row is keyed on, while ticker_alias stores mixed case ('BATSl'). First non-empty
  // wins; the read is ordered by alias, so "first" is deterministic across runs.
  const yahooByCanon = new Map();
  for (const a of aliases) {
    const ysym = typeof a.yahoo_symbol === "string" ? a.yahoo_symbol.trim() : "";
    if (!ysym) continue;
    const c = up(a.canonical);
    if (!yahooByCanon.has(c)) yahooByCanon.set(c, ysym);
  }

  const prior = new Map(existing.map((r) => [up(r.ticker), r]));

  // 2. Decide what to look up. Crypto is skipped entirely — the edge function classifies it
  // without an API call, and no stock-profile provider knows what BTCUSD is.
  const now = Date.now();
  const stocks = canonical.filter((t) => !cryptoBase(t));
  const cryptoSkipped = canonical.length - stocks.length;
  const frozen = stocks.filter((t) => (Number(prior.get(t)?.yahoo_miss_count) || 0) >= MAX_MISSES);
  const queue = stocks
    .map((t) => [t, rankTicker(prior.get(t), now)])
    .filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1]) // stable, so ranks keep their input order within a tier
    .map(([t]) => t);

  console.log(
    `${canonical.length} canonical tickers: ${queue.length} queued, ` +
    `${stocks.length - queue.length - frozen.length} fresh, ${frozen.length} frozen at ${MAX_MISSES} misses, ${cryptoSkipped} crypto`,
  );
  if (frozen.length) console.log(`frozen (clear yahoo_miss_count to retry): ${frozen.join(", ")}`);

  // 3. Fetch. One bad ticker never aborts the run.
  const resolvedRows = [];   // full row, overwrite on conflict
  const newMissRows = [];    // insert only if still absent
  const missPatches = [];    // [ticker, patch] — guarded narrow UPDATE
  const keptPatches = [];    // [ticker, patch] — counter + fetched_at only
  let okYahoo = 0, okFinnhub = 0, missed = 0, kept = 0, failed = 0, processed = 0;
  // Circuit breaker for a total provider outage. Every lookup that reaches nobody still costs
  // two 8 s timeouts plus the sleep, so a few hundred tickers would sit there for two hours
  // achieving precisely nothing. Breaking out writes nothing and touches no counter — the
  // untouched rows rank identically tomorrow — it just stops burning runner minutes.
  let failStreak = 0;

  for (const ticker of queue) {
    if (processed) await sleep(SLEEP_MS);
    processed++;
    const before = prior.get(ticker);
    const prevMiss = Number(before?.yahoo_miss_count) || 0;
    const ysym = yahooQuerySymbol(ticker, yahooByCanon);
    const label = ticker.padEnd(12) + (ysym === ticker ? "" : `(${ysym}) `);

    const y = await fetchYahooProfile(ysym);
    // Re-key to the CANONICAL ticker before mapping: the search endpoint is queried with the
    // Yahoo symbol (BATS.L), so parseYahooProfile echoes that back, and mapSector's
    // TICKER_OVERRIDES table is keyed on our tickers (NU, META, MSTR, ...).
    const yProfile = y.status === "ok" ? { ...y.profile, ticker } : null;
    const yahooSector = yProfile ? mapSector(yProfile) : null;
    if (yProfile && !yahooSector) {
      console.log(`  ? ${ticker}: no mapping rule for yahoo sector="${yProfile.sectorRaw ?? "-"}" industry="${yProfile.industryRaw ?? "-"}"`);
    }
    // A profile we cannot map counts as a miss, same judgement call as the edge function: it
    // is deterministic and will not change until someone adds a rule to _shared/sectors.js.
    const yahooAnsweredEmpty = y.status === "empty" || (y.status === "ok" && !yahooSector);

    let profile = yahooSector ? yProfile : null;
    let sector = yahooSector;
    let source = yahooSector ? "yahoo" : null;
    let via = yahooSector ? y.via : "";

    // Finnhub fallback — ONLY when nothing has a sector for this row yet. Finnhub's single
    // coarse industry string is strictly worse than Yahoo's sector+industry pair, so letting
    // it overwrite an existing sector would DOWNGRADE the row and flip source to 'finnhub' on
    // a night when Yahoo merely timed out. That is the exact inverse of the design.
    if (!sector && !before?.sector && FINNHUB_KEY) {
      const f = await fetchFinnhubProfile(ticker, FINNHUB_KEY);
      if (f.status === "ok") {
        const fProfile = { ...f.profile, ticker };
        const fSector = mapSector(fProfile);
        if (fSector) { profile = fProfile; sector = fSector; source = "finnhub"; via = "profile2"; }
        else console.log(`  ? ${ticker}: no mapping rule for finnhub industry="${fProfile.industryRaw ?? "-"}"`);
      } else if (f.status === "error") {
        console.log(`  ? ${ticker}: finnhub ${f.detail}`);
      }
    }

    const at = new Date().toISOString();

    if (sector) {
      failStreak = 0;
      if (source === "yahoo") okYahoo++; else okFinnhub++;
      resolvedRows.push(mkProfileRow(ticker, profile, before, {
        sector,
        source,
        // Yahoo resolved it -> the counter resets. Finnhub resolved it while Yahoo answered
        // with nothing -> Yahoo still missed, and the counter has to move or a symbol Yahoo
        // does not know is asked about every night for ever (the row stays source='finnhub',
        // which rankTicker re-queues at any age).
        missCount: source === "yahoo" ? 0 : (yahooAnsweredEmpty ? prevMiss + 1 : prevMiss),
        at,
      }));
      console.log(`${label}-> ${source}/${via} ${sector}`);
      continue;
    }

    // Nothing resolved. If Yahoo never actually ANSWERED, this says nothing whatsoever about
    // the symbol: leave the row completely alone — not even fetched_at moves, or an outage
    // would mark every ticker as freshly checked and hide itself.
    if (!yahooAnsweredEmpty) {
      failed++;
      console.log(`${label}FAILED (row untouched) — ${y.detail}`);
      if (++failStreak >= OUTAGE_STREAK) {
        console.log(`!! ${failStreak} lookups in a row reached nobody — aborting the run, no counter moved`);
        break;
      }
      continue;
    }
    failStreak = 0;

    const nextMiss = prevMiss + 1;

    // Already classified and the refresh found nothing better: record ONLY that we looked.
    // Never demote a resolved row to null.
    if (before?.sector) {
      kept++;
      keptPatches.push([ticker, { yahoo_miss_count: nextMiss, fetched_at: at }]);
      console.log(`${label}kept ${before.sector} (yahoo empty, miss ${nextMiss})`);
      continue;
    }

    missed++;
    if (!before) {
      // Insert-if-absent. If the edge function created the row while we were fetching, its
      // answer is better than our "nothing found" and must survive untouched.
      newMissRows.push(mkProfileRow(ticker, yProfile, before, {
        sector: null,
        source: yProfile ? "yahoo" : null,
        missCount: nextMiss,
        at,
      }));
    } else {
      // Existing unresolved row: a narrow UPDATE guarded on the sector still being NULL.
      // `prior` was read before up to an hour of fetching; an unconditional upsert here would
      // write sector:null over a sector the edge function resolved inside that window.
      const patch = { yahoo_miss_count: nextMiss, fetched_at: at };
      if (yProfile) {
        patch.name = yProfile.name ?? before.name ?? null;
        patch.sector_raw = yProfile.sectorRaw ?? before.sector_raw ?? null;
        patch.industry_raw = yProfile.industryRaw ?? before.industry_raw ?? null;
        patch.asset_type = assetType(yProfile.assetType ?? before.asset_type);
        patch.source = "yahoo";
      }
      missPatches.push([ticker, patch]);
    }
    console.log(`${label}MISS (yahoo empty, miss ${nextMiss}/${MAX_MISSES})`);
  }

  // 4. Write.
  let changed = 0;
  if (resolvedRows.length) changed += await upsertProfiles("resolved", resolvedRows, "merge-duplicates");
  if (newMissRows.length) changed += await upsertProfiles("new misses", newMissRows, "ignore-duplicates");
  for (const [ticker, patch] of missPatches) {
    const n = await patchProfile(ticker, patch, "&sector=is.null");
    if (n === 0) console.log(`  = ${ticker}: skipped, sector resolved by someone else mid-run`);
    changed += n;
  }
  for (const [ticker, patch] of keptPatches) changed += await patchProfile(ticker, patch);

  // processed/resolved/missed/kept/failed count LOOKUPS; `changed` counts rows the database
  // actually touched. They differ when a write failed, when a guarded update matched nothing,
  // and — by design — for every `failed`.
  console.log(
    `\nprocessed ${processed}/${queue.length} — resolved ${okYahoo} yahoo + ${okFinnhub} finnhub, ` +
    `missed ${missed}, kept ${kept}, failed ${failed}; ${changed} rows written`,
  );
  // Everything still outstanding after this run. A failed ticker's row is untouched, so it
  // ranks identically tomorrow; a frozen one needs a human.
  console.log(`remaining: ${queue.length - processed + failed} to retry tomorrow, ${frozen.length} frozen`);
  if (errors.length) {
    console.log(`\n${errors.length} write error(s):`);
    for (const e of errors) console.log(`  ${e}`);
    process.exitCode = 1;
  }
  // A night where every single lookup failed is a provider/network outage, not a quiet
  // success. Nothing was written and nothing was counted against any symbol — but the red X
  // in the Actions tab is the only signal anyone gets.
  if (processed > 0 && failed === processed) {
    console.log("!! every lookup failed — provider outage, no counters moved");
    process.exitCode = 1;
  }
  console.log("DONE");
}

// Only run when executed directly, so the pure helpers above can be unit-tested by importing
// this file. price-worker.mjs calls main() unconditionally; it has nothing worth importing.
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
