// Portfolio-history reconstruction — ONE implementation, shared by every writer of
// daily_snapshots: the nightly GitHub-Actions worker (scripts/price-worker.mjs) and the
// on-demand `backfill-snapshots` edge function. Plain ESM so Node, Deno and Vite can all
// import the same file; the app's tests exercise it directly.
//
// WHY THIS EXISTS
// ---------------
// Both writers used to reconstruct history from the RAW transaction ledger, skipping the
// `:adj:` reconciliation rows and the `:pos:` holdings snapshots. But `positions` — the
// table the live header is computed from — COUNTS those rows. So the ledger and the broker
// disagreed, and the chart showed the ledger's share counts for every past day while
// "today" showed the broker's: a portfolio that never existed, ending in a cliff on the
// last day. backfill-snapshots then tried to paper over the cliff by multiplying each
// ticker's whole history by truth/ledger — which turns a 2-share correction on a
// mostly-sold position into thousands of phantom dollars back when the position was large.
//
// THE RULE HERE: the broker's CURRENT share count is the only quantity we actually know.
// History is that number walked BACKWARDS through the real dated trades:
//
//     shares(ticker, day) = sharesToday(ticker) − Σ signed trades executed AFTER `day`
//
// At today that is exactly the live position (no cliff). Going back, it moves only by
// trades that really happened. Any disagreement between broker and ledger stays a single
// bounded offset instead of being multiplied through the whole chart, and it can never
// scale a past holding up. Quantities are clamped at zero and at the ticker's first known
// day, so the reconstruction never claims shares before they were acquired.

/**
 * @typedef {Object} TradeEvent
 * @property {string} ticker
 * @property {string} day     ISO date, "YYYY-MM-DD"
 * @property {number} signed  +shares for a BUY, −shares for a SELL, split-adjusted to today
 */

/**
 * Build a cursor over the daily share count per ticker.
 *
 * @param {TradeEvent[]} trades  real dated trades only (no `:adj:` / `:pos:` rows)
 * @param {Map<string, number>} truth  ticker -> shares held today (from `positions`)
 * @param {Map<string, string>} [startByTicker]  ticker -> earliest day it may be held
 *        (positions.holding_start_date, or the first row of any kind for that ticker).
 *        Only used for tickers the trade ledger doesn't cover.
 */
export function createHoldingsTimeline(trades, truth, startByTicker = new Map()) {
  const byTicker = new Map();
  for (const t of trades) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker).push(t);
  }
  for (const list of byTicker.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const tickers = [...new Set([...byTicker.keys(), ...truth.keys()])];
  // `ahead` = net signed shares still in the FUTURE relative to the cursor. Starts as the
  // ledger's full net, so before the first trade shares(day) = truth − net = the offset,
  // which the start-date guard below turns into 0.
  const ahead = new Map();
  const cursor = new Map();
  const start = new Map();
  for (const tk of tickers) {
    const list = byTicker.get(tk) ?? [];
    ahead.set(tk, list.reduce((s, e) => s + e.signed, 0));
    cursor.set(tk, 0);
    const firstTrade = list.length ? list[0].day : null;
    const declared = startByTicker.get(tk) ?? null;
    start.set(tk, firstTrade && declared ? (firstTrade < declared ? firstTrade : declared) : (firstTrade ?? declared));
  }

  const held = new Map();
  // Worst single-day shortfall per ticker. NOT a running sum — a small persistent mismatch
  // would otherwise accumulate once per day and read as a huge number after five years.
  const clampedByTicker = new Map();
  const unknownStart = tickers.filter((tk) => !start.get(tk) && (truth.get(tk) ?? 0) > 0);

  return {
    tickers,
    /** ticker -> first day it may show up in the chart */
    start,
    /** Tickers held today that carry no date at all — they cannot be placed in history. */
    unknownStart,
    /** Worst shares the clamp had to remove, summed over tickers; 0 == clean data. */
    get clamped() { return [...clampedByTicker.values()].reduce((a, b) => a + b, 0); },
    /** Per-ticker worst shortfall, for pinpointing which ledger disagrees with the broker. */
    get clampedByTicker() { return Object.fromEntries(clampedByTicker); },
    /**
     * Advance the cursor to `day` and return the share count per ticker.
     * Days MUST be passed in ascending order (the cursor never rewinds).
     * @param {string} day ISO date
     * @returns {Map<string, number>} live map, valid until the next call
     */
    advanceTo(day) {
      for (const tk of tickers) {
        const list = byTicker.get(tk) ?? [];
        let i = cursor.get(tk);
        let rest = ahead.get(tk);
        while (i < list.length && list[i].day <= day) { rest -= list[i].signed; i += 1; }
        cursor.set(tk, i);
        ahead.set(tk, rest);
        const from = start.get(tk);
        let qty = from && day >= from ? (truth.get(tk) ?? 0) - rest : 0;
        // A negative quantity means the ledger records more sold than the broker ever had.
        // Show nothing rather than negative money, and surface it via `clamped`.
        if (qty < 0) {
          if (-qty > (clampedByTicker.get(tk) ?? 0)) clampedByTicker.set(tk, -qty);
          qty = 0;
        }
        held.set(tk, qty);
      }
      return held;
    },
  };
}

/**
 * Split ratios a real corporate action actually uses — forward (2 = 2-for-1) and reverse
 * (0.1 = 1-for-10). Without the reverse ones a position from before a reverse split was
 * valued at 10x in history: as-traded 10 shares times a close already scaled for 1 share.
 */
const FORWARD_RATIOS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];
const NICE_RATIOS = [1, ...FORWARD_RATIOS, ...FORWARD_RATIOS.map((r) => 1 / r)];
const snapRatio = (r) => {
  for (const n of NICE_RATIOS) if (Math.abs(r - n) / n <= 0.08) return n;
  return null;
};

/**
 * Convert AS-TRADED quantities to today's split-adjusted terms — derived from the data
 * itself and then verified against the broker.
 *
 * Brokers book a trade with the quantity and price of the day: 0.0041 GOOGL at $2,836 in
 * January 2022. Every price series is adjusted backwards for later splits, so that same day
 * closes at $138.59. Multiplying the raw quantity by the adjusted close undervalues the
 * holding by the whole split ratio (20× for GOOGL, 3× for TSLA, 10× for NFLX here).
 *
 * The ratio is right there in the data: tradePrice / close(tradeDay) IS the cumulative split
 * factor since that trade. No external split calendar, no guessing — and no silent damage,
 * because a ticker's factors are accepted ONLY if they make the ledger add up to the share
 * count the broker reports today. When they don't, the ledger is already split-adjusted (some
 * statements book a split as extra shares) and the factors are dropped for that ticker.
 *
 * @param {TradeEvent[]} trades  with `price` (USD, as traded) alongside ticker/day/signed
 * @param {(ticker: string, day: string) => number|null} closeAt  split-adjusted close
 * @param {Map<string, number>} truth  ticker -> shares held today
 * @returns {{trades: TradeEvent[], adjusted: Record<string, number>, unverified: string[]}}
 */
export function applySplitAdjustment(trades, closeAt, truth) {
  const byTicker = new Map();
  for (const t of trades) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker).push(t);
  }
  const out = [];
  const adjusted = {};
  const unverified = [];

  for (const [ticker, list] of byTicker) {
    const sorted = [...list].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    // Resolve a factor per trade where the close is known…
    const factors = sorted.map((t) => {
      const close = closeAt(ticker, t.day);
      if (!close || !(t.price > 0)) return null;
      return snapRatio(t.price / close);
    });
    // …then fill the gaps. A trade without a same-day close sits between the resolved factor
    // before it and the one after it — a split may lie on either side. Pick whichever of
    // {previous, next, 1} best explains its price against the nearest earlier close (up to
    // 6 days back; too far for a factor of its own, close enough to choose between
    // candidates that differ by a whole split ratio). With no close at all, prefer the next
    // resolved factor, then the previous one.
    const resolved = factors.slice();
    for (let i = 0; i < factors.length; i++) {
      if (resolved[i] != null) continue;
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) if (resolved[j] != null) { prev = resolved[j]; break; }
      for (let j = i + 1; j < factors.length; j++) if (resolved[j] != null) { next = resolved[j]; break; }
      const candidates = [...new Set([next, prev, 1].filter((x) => x != null))];
      let nearby = null;
      for (let k = 1; k <= 6 && nearby == null; k++) nearby = closeAt(ticker, new Date(Date.parse(sorted[i].day) - k * 86400000).toISOString().slice(0, 10)) || null;
      if (nearby && sorted[i].price > 0) {
        const r = sorted[i].price / nearby;
        factors[i] = candidates.reduce((best, c) => (Math.abs(Math.log(r / c)) < Math.abs(Math.log(r / best)) ? c : best), candidates[0]);
      } else {
        factors[i] = next ?? prev ?? 1;
      }
    }
    const net = (f) => sorted.reduce((s, t, i) => s + t.signed * (f ? factors[i] : 1), 0);
    const target = truth.get(ticker) ?? 0;
    const tol = Math.max(Math.abs(target) * 0.01, 1e-4);
    const withSplit = net(true), raw = net(false);
    const useSplit = factors.some((f) => f !== 1) &&
      (Math.abs(withSplit - target) <= tol || Math.abs(withSplit - target) < Math.abs(raw - target));
    if (useSplit) {
      adjusted[ticker] = factors.reduce((a, f) => (Math.abs(Math.log(f)) > Math.abs(Math.log(a)) ? f : a), 1);
      if (Math.abs(withSplit - target) > tol) unverified.push(ticker);
    } else if (Math.abs(raw - target) > tol && target > 0) {
      unverified.push(ticker);
    }
    sorted.forEach((t, i) => out.push(useSplit ? { ...t, signed: t.signed * factors[i] } : t));
  }
  return { trades: out, adjusted, unverified };
}

/**
 * Drop data glitches from a daily close series: a point more than 5x away from the last kept
 * close that comes straight BACK (the next close is again within 2x of the last kept one).
 * A real crash or rally stays: the old rule compared every later point with the pre-move
 * close and so dropped the whole rest of the series after a genuine -80 % day.
 * @param {Map<string, number>} map date -> close
 * @returns {Map<string, number>}
 */
export function sanitizeSeries(map) {
  const dates = [...map.keys()].sort();
  const out = new Map();
  let prev = null;
  for (let i = 0; i < dates.length; i++) {
    const c = map.get(dates[i]);
    if (!(c > 0)) continue;
    if (prev != null && (c > prev * 5 || c < prev / 5)) {
      const next = i + 1 < dates.length ? map.get(dates[i + 1]) : null;
      const reverts = next != null && next > 0 && next <= prev * 2 && next >= prev / 2;
      if (reverts) continue; // a one-day spike
    }
    out.set(dates[i], c);
    prev = c;
  }
  return out;
}

/** True for rows the ledger carries but that are not real dated trades. */
export function isSyntheticRow(extId) {
  const e = String(extId ?? "");
  return e.includes(":adj:") || e.includes(":pos:");
}

/** Inclusive list of ISO days from `from` to `to`, iterated in UTC (DST-proof). */
export function eachDay(from, to) {
  const out = [];
  for (let ms = Date.parse(from); ms <= to; ms += 86400000) out.push(new Date(ms).toISOString().slice(0, 10));
  return out;
}
