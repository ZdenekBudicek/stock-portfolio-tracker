// USD → CZK conversion for the tax report. Every amount is converted at the rate of ITS OWN
// date (purchase cost at the purchase date, proceeds at the sale date) — never at today's
// live rate. A date the data file does not cover is reported as missing, not guessed.
//
// Data: src/data/cnbUsdCzk.json, the daily ČNB "kurzy devizového trhu" for USD.
// Refresh it with `node scripts/update-cnb-rates.mjs` (after each year end, before filing).
import cnb from "@/data/cnbUsdCzk.json";

export type FxMethod = "cnb-daily" | "gfr-annual";

export interface FxRate {
  /** CZK per 1 USD. */
  rate: number;
  /** Which published rate was used: the ČNB date, or the year of the GFŘ unified rate. */
  ref: string;
}

const RATES = (cnb as { rates: Record<string, number> }).rates;
const DATES = Object.keys(RATES).sort();
const LAST = DATES[DATES.length - 1];

/** Last index i with DATES[i] <= date, or -1. */
function floorIndex(date: string): number {
  let lo = 0, hi = DATES.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (DATES[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const isWeekend = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

/**
 * The ČNB rate valid on `date` (YYYY-MM-DD): the rate published that day, or on a weekend /
 * holiday the last one published before it. Past the end of the data file only a weekend
 * directly after the last published day is still known; anything later returns null so the
 * report says "chybí kurz" instead of silently using a stale or live rate.
 */
export function cnbUsdCzk(date: string): FxRate | null {
  if (!DATES.length || date < DATES[0]) return null;
  if (date > LAST) {
    for (let d = nextDay(LAST); d <= date; d = nextDay(d)) if (!isWeekend(d)) return null;
    return { rate: RATES[LAST], ref: LAST };
  }
  const i = floorIndex(date);
  if (i < 0) return null;
  // A gap of more than a long weekend inside the file means the file itself is broken.
  if (daysBetween(DATES[i], date) > 6) return null;
  return { rate: RATES[DATES[i]], ref: DATES[i] };
}

/**
 * The GFŘ "jednotný kurz" for a year: the average of the ČNB rates valid on the last day of
 * each of its 12 months, rounded to 2 decimals (§ 38 ZDP). Computed from the same data file;
 * it reproduces the published GFŘ figures (2020 23,14 · 2021 21,72 · 2022 23,41 · 2023 22,14 ·
 * 2024 23,28 · 2025 21,84). A year whose December rate is not in the file has no unified rate yet.
 */
export function gfrUsdCzk(year: number): FxRate | null {
  let sum = 0;
  for (let m = 1; m <= 12; m++) {
    const lastDay = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    if (lastDay > LAST) return null;
    const r = cnbUsdCzk(lastDay);
    if (!r) return null;
    sum += r.rate;
  }
  return { rate: Math.round((sum / 12) * 100) / 100, ref: `GFŘ ${year}` };
}

/** Rate for a date under the chosen method (GFŘ: the unified rate of that date's year). */
export function usdCzkFor(date: string, method: FxMethod): FxRate | null {
  return method === "gfr-annual" ? gfrUsdCzk(Number(date.slice(0, 4))) : cnbUsdCzk(date);
}

/** Last date the bundled ČNB file covers (shown in the report so a stale file is visible). */
export const CNB_DATA_TO = LAST;

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
