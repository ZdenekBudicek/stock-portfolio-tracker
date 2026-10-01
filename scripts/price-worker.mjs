// Professional multi-source historical price worker.
// Runs from a non-throttled IP (GitHub Actions) so it can use Yahoo as the primary
// source (broadest coverage: US + LSE/Xetra/foreign + crypto), with Twelve Data as a
// fallback when Yahoo crashes or returns nothing/garbage. Foreign listings are
// converted to USD via FX. Results go into the SHARED price_history table and every
// user's daily_snapshots are recomputed. Idempotent — safe to run on a schedule.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, TWELVE_DATA_KEY (optional)

import { applySplitAdjustment, createHoldingsTimeline, isSyntheticRow } from "../supabase/functions/_shared/history.js";

const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_KEY;
const TD = process.env.TWELVE_DATA_KEY || "";
if (!U || !K) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dstr = (d) => d.toISOString().slice(0, 10);
const H = { apikey: K, Authorization: `Bearer ${K}` };

async function rest(path) {
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const r = await fetch(`${U}/rest/v1/${path}`, { headers: { ...H, Range: `${f}-${f + 999}` } });
    const p = await r.json();
    if (!Array.isArray(p)) break;
    rows.push(...p);
    if (p.length < 1000) break;
  }
  return rows;
}
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${U}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) { console.log(`upsert ${table} err`, await r.text()); break; }
  }
}

// ---- sources ---------------------------------------------------------------
const cryptoYahoo = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", BNB: "BNB-USD", DOT: "DOT-USD", EGLD: "EGLD-USD", ADA: "ADA-USD", XRP: "XRP-USD", DOGE: "DOGE-USD", AVAX: "AVAX-USD", LINK: "LINK-USD" };
const heuristicYahoo = (t) => cryptoYahoo[t.toUpperCase().replace(/USD$/, "")] ?? t.replace(/_US_EQ$/, "").replace(/_EQ$/, "").replace(/\./g, "-");

async function yahoo(sym, fromUnix) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${fromUnix}&period2=${Math.floor(Date.now() / 1000) + 86400}&interval=1d&events=split`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const ts = res.timestamp ?? [];
  const cl = res.indicators?.quote?.[0]?.close ?? [];
  const currency = res.meta?.currency ?? "USD";
  const m = new Map();
  for (let i = 0; i < ts.length; i++) if (typeof cl[i] === "number" && cl[i] > 0) m.set(dstr(new Date(ts[i] * 1000)), cl[i]);
  // Yahoo close is split-adjusted, so as-traded share counts must be adjusted too.
  const sp = res.events?.splits ?? {};
  const splits = Object.values(sp).map((s) => ({ date: dstr(new Date(s.date * 1000)), ratio: s.numerator / s.denominator })).filter((s) => s.ratio > 0);
  return m.size ? { currency, map: m, splits } : null;
}
async function twelve(sym, fromDate) {
  if (!TD) return null;
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&start_date=${fromDate}&outputsize=5000&apikey=${TD}`);
  const j = await r.json().catch(() => null);
  const vals = j?.values;
  if (!Array.isArray(vals) || !vals.length) return null;
  const m = new Map();
  for (const v of vals) { const c = Number(v.close); if (c > 0) m.set(v.datetime, c); }
  return m.size ? { currency: "USD", map: m } : null; // Twelve Data free is USD-listed
}

// Self-heal: resolve an unknown ticker's correct Yahoo symbol from its ISIN via OpenFIGI.
// OpenFIGI returns every listing; we pick US first, then LSE, then Xetra, then other EU,
// and build the exchange-qualified Yahoo symbol (e.g. BRK-B, RR.L, DBK.DE).
const US_EXCH = new Set(["US", "UN", "UW", "UA", "UC", "UP", "UQ", "UR", "UV", "UD", "UB", "UM", "UT", "UX", "UF"]);
const EXCH_SUFFIX = { LN: ".L", GR: ".DE", GY: ".DE", GF: ".DE", GD: ".DE", GS: ".DE", GM: ".DE", GI: ".DE", GH: ".DE", GT: ".DE", GB: ".DE", FP: ".PA", NA: ".AS", SM: ".MC", SW: ".SW", IM: ".MI", SS: ".ST", DC: ".CO", BB: ".BR", PL: ".LS", VI: ".VI" };
const yahooFromFigi = (ticker, exchCode) => {
  const t = String(ticker).replace(/\//g, "-").toUpperCase(); // BRK/B -> BRK-B, RR/ -> RR-
  if (US_EXCH.has(exchCode)) return t.replace(/-$/, "");
  const sfx = EXCH_SUFFIX[exchCode];
  return sfx ? t.replace(/[-/]+$/, "") + sfx : null;
};
async function resolveYahooCandidatesViaIsin(isin) {
  try {
    const r = await fetch("https://api.openfigi.com/v3/mapping", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ idType: "ID_ISIN", idValue: isin }]),
    });
    if (!r.ok) return [];
    const data = (await r.json())?.[0]?.data;
    if (!Array.isArray(data) || !data.length) return [];
    const pref = ["US", "LN", "GR", "FP", "NA", "SM", "SW", "IM"]; // exchange preference
    const score = (e) => { const i = pref.indexOf(US_EXCH.has(e) ? "US" : e); return i < 0 ? 99 : i; };
    const sorted = [...data].sort((a, b) => score(a.exchCode) - score(b.exchCode));
    const out = [];
    for (const d of sorted) { const y = yahooFromFigi(d.ticker, d.exchCode); if (y && !out.includes(y)) out.push(y); }
    return out; // ordered candidates; worker tries each until one returns data
  } catch { return []; }
}

// Drop single-day spikes (data glitches): a close >5x or <1/5 of the previous kept value.
function sanitize(map) {
  const dates = [...map.keys()].sort();
  const out = new Map();
  let prev = null;
  for (const d of dates) {
    const c = map.get(d);
    if (prev != null && (c > prev * 5 || c < prev / 5)) continue;
    out.set(d, c); prev = c;
  }
  return out;
}

async function main() {
  // 1) the ledger + the broker-reconciled positions.
  // The reconstruction is ANCHORED to `positions` (see _shared/history.js), so both are
  // needed: the ledger supplies the dated moves, `positions` supplies today's truth.
  const allRows = await rest(`transactions?select=user_id,ticker,side,shares,price_usd,executed_at,ext_id&order=executed_at.asc`);
  const txs = allRows.filter((t) => t.ticker !== "CASH" && !isSyntheticRow(t.ext_id));
  const allPos = await rest(`positions?select=user_id,ticker,shares,type,holding_start_date`);
  const isCash = (p) => p.ticker === "CASH" || String(p.type ?? "") === "Cash";
  const posRows = allPos.filter((p) => !isCash(p));
  // Today's cash balance per user. This job stamps it on today's snapshot so the balance
  // accumulates a day at a time — daily-snapshot-cron was supposed to do it, but it depends
  // on an external scheduler that is not running (the S&P benchmark it also refreshes had
  // been frozen since June). The reliable job owns it instead.
  const cashByUser = new Map();
  for (const p of allPos) if (isCash(p)) cashByUser.set(p.user_id, (cashByUser.get(p.user_id) ?? 0) + Number(p.shares));
  if (!txs.length && !posRows.length) { console.log("no trades"); return; }
  // Price every ticker that appears anywhere — a holding imported as a portfolio snapshot
  // (Revolut "Portfolio breakdown") has no trades but still has to be valued.
  const tickers = [...new Set([...txs.map((t) => t.ticker), ...posRows.map((p) => p.ticker)])];
  const firstByTicker = new Map();
  for (const t of allRows) {
    if (t.ticker === "CASH") continue;
    const d = t.executed_at.slice(0, 10);
    const c = firstByTicker.get(t.ticker);
    if (!c || d < c) firstByTicker.set(t.ticker, d);
  }
  const globalFirst = [...firstByTicker.values()].sort()[0] ?? dstr(new Date(Date.now() - 365 * 86400000));
  const fromUnix = Math.floor(new Date(globalFirst).getTime() / 1000);

  // 2) alias map (canonical + yahoo_symbol)
  const aliasRows = await rest(`ticker_alias?select=alias,canonical,yahoo_symbol,isin`);
  const alias = new Map(aliasRows.map((a) => [a.alias, a]));

  // 3) FX series for currency conversion -> USD, and USD->CZK for value_czk
  const fxGbp = (await yahoo("GBPUSD=X", fromUnix))?.map ?? new Map();
  const fxEur = (await yahoo("EURUSD=X", fromUnix))?.map ?? new Map();
  const fxCzk = (await yahoo("CZK=X", fromUnix))?.map ?? new Map();
  const nearest = (m, day, fallback) => { // last value on/before day
    if (m.has(day)) return m.get(day);
    let best = fallback, bestD = "";
    for (const [d, v] of m) if (d <= day && d > bestD) { bestD = d; best = v; }
    return best;
  };
  const toUsd = (close, currency, day) => {
    switch (currency) {
      case "USD": return close;
      case "EUR": return close * nearest(fxEur, day, 1.08);
      case "GBP": return close * nearest(fxGbp, day, 1.27);
      case "GBp": case "GBX": return (close / 100) * nearest(fxGbp, day, 1.27);
      case "CZK": return close / nearest(fxCzk, day, 21.3); // Prague-listed (e.g. Colt CZ COLT.PR)
      default: return close; // unknown -> assume already USD
    }
  };

  // 4) fetch each ticker (Yahoo primary -> Twelve Data fallback), convert, validate, store
  const series = {};
  let okY = 0, okT = 0, fail = [];
  for (const t of tickers) {
    const a = alias.get(t);
    const ysym = a?.yahoo_symbol || heuristicYahoo(t);
    const tdsym = a?.canonical && a.canonical !== t ? a.canonical : t.replace(/_US_EQ$/, "").replace(/_EQ$/, "");

    let picked = null, src = "";
    const y = await yahoo(ysym, fromUnix).catch(() => null);
    if (y) {
      const usd = new Map();
      for (const [d, c] of sanitize(y.map)) usd.set(d, toUsd(c, y.currency, d));
      picked = usd; src = `yahoo(${ysym}${y.currency !== "USD" ? "," + y.currency : ""})`; okY++;
    } else {
      const tw = await twelve(tdsym, globalFirst).catch(() => null);
      if (tw) { picked = sanitize(tw.map); src = `twelve(${tdsym})`; okT++; }
    }

    // Self-heal: nothing worked but we have an ISIN -> resolve the correct Yahoo symbol
    // via OpenFIGI, persist it (shared, so it's instant next time), and retry.
    if (!picked && a?.isin) {
      const cands = await resolveYahooCandidatesViaIsin(a.isin);
      for (const cs of cands) {
        if (cs === ysym) continue;
        const y2 = await yahoo(cs, fromUnix).catch(() => null);
        if (y2) {
          const usd = new Map();
          for (const [d, c] of sanitize(y2.map)) usd.set(d, toUsd(c, y2.currency, d));
          picked = usd; src = `yahoo*auto(${cs}${y2.currency !== "USD" ? "," + y2.currency : ""})`; okY++;
          await upsert("ticker_alias", [{ alias: t, canonical: a?.canonical ?? t, isin: a.isin, yahoo_symbol: cs, source: "openfigi-auto" }], "alias");
          break;
        }
        await sleep(150);
      }
      await sleep(2600); // OpenFIGI no-key rate limit
    }

    // cross-check: if both sources exist, warn on >8% divergence at latest common date
    if (picked && src.startsWith("yahoo")) {
      const tw = await twelve(tdsym, globalFirst).catch(() => null);
      if (tw) {
        const common = [...picked.keys()].filter((d) => tw.map.has(d)).sort();
        const d = common[common.length - 1];
        if (d) { const diff = Math.abs(picked.get(d) - tw.map.get(d)) / tw.map.get(d); if (diff > 0.08) console.log(`  ! divergence ${t} ${d}: yahoo ${picked.get(d).toFixed(2)} vs twelve ${tw.map.get(d).toFixed(2)} (${(diff * 100).toFixed(0)}%)`); }
      }
    }

    if (picked && picked.size) {
      series[t] = picked;
      await upsert("price_history", [...picked.entries()].map(([date, close]) => ({ symbol: t, date, close })), "symbol,date");
    } else {
      fail.push(t);
    }
    console.log(`${t.padEnd(12)} ${src || "FAILED"} (${picked?.size ?? 0} pts)`);
    await sleep(200);
  }
  if (fxCzk.size) await upsert("price_history", [...fxCzk.entries()].map(([date, close]) => ({ symbol: "USDCZK", date, close })), "symbol,date");
  console.log(`\nsources: yahoo ${okY}, twelve ${okT}, failed ${fail.length}${fail.length ? " -> " + fail.join(", ") : ""}`);

  // S&P 500 for the comparison line. It used to be refreshed only by the Supabase cron, which
  // stopped running — the benchmark froze on 25 June 2026 and every "vs. S&P" figure silently
  // went stale (a 1-month comparison read +0.00 %). This job already reaches Yahoo reliably
  // from GitHub's IP, so it owns the benchmark too. One fetch refills the whole range.
  {
    const spx = await yahoo("^GSPC", fromUnix).catch(() => null);
    if (spx?.map?.size) {
      const rows = [...sanitize(spx.map).entries()].map(([date, close_value]) => ({ symbol: "SPX", date, close_value }));
      await upsert("benchmark_history", rows, "symbol,date");
      console.log(`benchmark SPX: ${rows.length} dní, poslední ${rows[rows.length - 1].date}`);
    } else {
      console.log("! benchmark SPX se nepodařilo stáhnout — porovnání zůstane na starých datech");
    }
  }

  // Top the tail up from the shared price_history, which refresh-prices keeps current
  // intraday. This job runs in the morning UTC, when the provider has often not published
  // the previous session's daily bar yet — the reconstruction then carried the close from
  // the session before, so the last day or two of every chart sat flat and then jumped.
  // Only tickers whose series was fetched successfully are topped up: filling a ticker we
  // failed to price would place it in the chart for a handful of recent days only.
  {
    const from = dstr(new Date(Date.now() - 10 * 86400000));
    const have = tickers.filter((t) => series[t]?.size);
    let filled = 0;
    for (let i = 0; i < have.length; i += 40) {
      const chunk = have.slice(i, i + 40);
      const rows = await rest(`price_history?select=symbol,date,close&date=gte.${from}&symbol=in.(${chunk.join(",")})`);
      for (const r of rows) {
        const c = Number(r.close);
        const s = series[r.symbol];
        if (!(c > 0) || !s || s.has(r.date)) continue;
        s.set(r.date, c);
        filled++;
      }
    }
    if (filled) console.log(`doplněno z price_history: ${filled} chybějících denních cen`);
  }

  // 5) recompute daily_snapshots per user
  const users = [...new Set([...allRows.map((t) => t.user_id), ...posRows.map((p) => p.user_id)])].filter(Boolean);
  for (const uid of users) {
    const uAll = allRows.filter((t) => t.user_id === uid && t.ticker !== "CASH");
    const utx = uAll.filter((t) => !isSyntheticRow(t.ext_id));
    const upos = posRows.filter((p) => p.user_id === uid);
    if (!uAll.length && !upos.length) continue;

    // Broker truth = what `positions` says is held today. The live header is computed from
    // exactly this, so anchoring history to it is what keeps the chart and the header on
    // the same portfolio (and kills the cliff on the last day).
    const truth = new Map();
    for (const p of upos) truth.set(p.ticker, (truth.get(p.ticker) ?? 0) + Number(p.shares));
    // Where a ticker has no trades at all (a Revolut/T212 holdings snapshot), fall back to
    // the position's own start date, then to its earliest ledger row of any kind.
    const startByTicker = new Map();
    for (const t of uAll) {
      const d = t.executed_at.slice(0, 10);
      const c = startByTicker.get(t.ticker);
      if (!c || d < c) startByTicker.set(t.ticker, d);
    }
    for (const p of upos) {
      if (!p.holding_start_date) continue;
      const d = String(p.holding_start_date).slice(0, 10);
      const c = startByTicker.get(p.ticker);
      if (!c || d < c) startByTicker.set(p.ticker, d);
    }

    // As-traded quantities -> today's split-adjusted terms, derived from the trade price
    // against the (split-adjusted) close of the same day and verified against the broker's
    // share count. See applySplitAdjustment: this replaces the old Yahoo split-event list,
    // which could not tell an unadjusted ledger from one where the broker had already booked
    // the split as extra shares — and double-counted in the second case.
    const closeAt = (tk, day) => {
      const s = series[tk];
      if (!s) return null;
      for (let i = 0, ms = Date.parse(day); i < 6; i++, ms -= 86400000) {
        const c = s.get(dstr(new Date(ms)));
        if (c) return c;
      }
      return null;
    };
    const { trades, adjusted, unverified } = applySplitAdjustment(
      utx.map((t) => ({
        ticker: t.ticker, day: t.executed_at.slice(0, 10),
        signed: (t.side === "BUY" ? 1 : -1) * Number(t.shares), price: Number(t.price_usd),
      })),
      closeAt, truth,
    );
    if (Object.keys(adjusted).length) console.log(`  splity: ${Object.entries(adjusted).map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    if (unverified.length) console.log(`  ! ledger nesedí na počty u brokera: ${unverified.join(", ")}`);

    const timeline = createHoldingsTimeline(trades, truth, startByTicker);
    const uFirst = [...timeline.start.values()].filter(Boolean).sort()[0];
    if (!uFirst) { console.log(`user ${uid.slice(0, 8)}: nothing datable — SKIP`); continue; }

    const last = {};
    let lastCzk = 23;
    const snapMap = new Map(); // keyed by day -> dedupes any DST-repeated date
    // iterate in UTC ms to avoid DST quirks
    const todayMs = Date.now();
    for (let ms = Date.parse(uFirst); ms <= todayMs; ms += 86400000) {
      const day = dstr(new Date(ms));
      const held = timeline.advanceTo(day);
      if (fxCzk.has(day)) lastCzk = fxCzk.get(day);
      let val = 0;
      for (const [t, qty] of held) {
        if (qty <= 1e-9) continue;
        const s = series[t];
        if (s?.has(day)) last[t] = s.get(day);
        if (last[t]) val += qty * last[t];
      }
      // cash_usd is present on EVERY row (null where not tracked). A bulk insert where some
      // objects carry a key and others do not is rejected wholesale by PostgREST — that is
      // how a rebuild silently stopped after three batches and truncated the history.
      if (val > 0) snapMap.set(day, { user_id: uid, snapshot_date: day, value_usd: Math.round(val * 100) / 100, value_czk: Math.round(val * lastCzk * 100) / 100, cash_usd: null, profit_usd: 0, profit_pct: 0, profit_czk: 0, fx_rate: lastCzk });
    }
    if (timeline.clamped > 1e-6) console.log(`  ! user ${uid.slice(0, 8)}: ledger sells exceed broker holdings by ${timeline.clamped.toFixed(4)} shares (clamped to 0)`);
    if (timeline.unknownStart.length) console.log(`  ! user ${uid.slice(0, 8)}: no date for ${timeline.unknownStart.join(", ")} — left out of history`);

    // The daily cash balance is RECORDED, never recomputed — this job rebuilds the holdings
    // value from prices and would otherwise wipe it, since it deletes the user's rows first.
    // Carry every already-recorded balance across the rebuild.
    const prevCash = new Map();
    for (const r of await rest(`daily_snapshots?select=snapshot_date,cash_usd&user_id=eq.${uid}&cash_usd=not.is.null`)) {
      prevCash.set(r.snapshot_date, Number(r.cash_usd));
    }
    let carried = 0;
    for (const s of snapMap.values()) {
      const c = prevCash.get(s.snapshot_date);
      if (c != null && Number.isFinite(c)) { s.cash_usd = c; carried++; }
    }
    // Stamp today's balance, which is the one figure we know for certain.
    const snaps = [...snapMap.values()];
    const todayCash = cashByUser.get(uid);
    if (snaps.length && todayCash != null && Number.isFinite(todayCash)) {
      snaps[snaps.length - 1].cash_usd = todayCash;
      carried++;
    }
    if (carried) console.log(`  hotovost: ${carried} dní (dnes $${Math.round(todayCash ?? 0)})`);
    if (!snaps.length) { console.log(`user ${uid.slice(0, 8)}: 0 snapshots computed — SKIP delete (keeping existing)`); continue; }
    await fetch(`${U}/rest/v1/daily_snapshots?user_id=eq.${uid}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
    let inserted = 0;
    for (let i = 0; i < snaps.length; i += 500) {
      const r = await fetch(`${U}/rest/v1/daily_snapshots`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(snaps.slice(i, i + 500)) });
      if (!r.ok) {
        // Never leave a user with half a history: this job DELETED their rows first, so a
        // failed batch means the chart is truncated until someone notices.
        console.log(`  !! snapshot insert FAILED (${uid.slice(0, 8)} batch ${i}) — history is now INCOMPLETE:`, await r.text());
        process.exitCode = 1;
        break;
      }
      inserted += snaps.slice(i, i + 500).length;
    }
    console.log(`user ${uid.slice(0, 8)}: ${inserted}/${snaps.length} snapshots, last ${snaps[snaps.length - 1] ? "$" + Math.round(snaps[snaps.length - 1].value_usd) : "-"}`);
  }
  console.log("DONE");
}
main().catch((e) => { console.error(e); process.exit(1); });
