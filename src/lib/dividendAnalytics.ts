// Dividend outlook and income for the Dividendy screen (and its cards elsewhere).
//
// Grouped by the PAYMENT date (pay_date, else ex_date) — the day the money arrives, which is
// what a "příjem po měsících" chart means.
//
// Provenance: rows written by sync-earnings (broker "auto") are projections, already net of the
// assumed 15 % withholding. A row from a statement or the broker API (an ext_id) or one entered
// by hand is a recorded/declared payment. `status = "paid"` alone is NOT proof of a payment —
// sync-earnings marks its own past projections paid — so the received totals only count
// recorded rows.
import { dividendPayDate, dividendTaxRow, type DividendRecord } from "@/lib/dividendTax";
import { addDays } from "@/lib/czTax";

export type DividendKind = "declared" | "estimate";

export interface ForecastItem {
  ticker: string;
  payDate: string;
  amountUsd: number;
  kind: DividendKind;
}

export interface ForecastMonth {
  month: string; // YYYY-MM
  items: ForecastItem[];
  amountUsd: number;
  /** Every item of the month is declared (not a projection). */
  declared: boolean;
}

const isAuto = (d: DividendRecord) => String(d.broker ?? "").toLowerCase() === "auto";
/** A payment from a statement, the broker API or entered by hand — not a sync-earnings projection. */
export const isRecorded = (d: DividendRecord & { ext_id?: string | null }) => !isAuto(d) && (!!d.ext_id || String(d.broker ?? "manual").toLowerCase() === "manual");
const norm = (t: string) => t.toUpperCase().split(".")[0];
/** What reached (or will reach) the account: XTB rows are gross, so the withholding comes off. */
const netUsd = (d: DividendRecord) => dividendTaxRow(d, "cnb-daily").netUsd;
/**
 * Still expected: a future payment date and either announced ("upcoming") or a projection.
 * sync-earnings marks its projections "paid" once the EX-date passes, so status alone would
 * drop a payout between its ex-date and pay date.
 */
const isExpected = (d: DividendRecord, today: string) => dividendPayDate(d) > today && (d.status === "upcoming" || isAuto(d));
/** `held` undefined = no filter; an empty set = nothing is held (all projections drop). */
const heldOk = (held: Set<string> | undefined, t: string) => !held || held.has(norm(t));

/** Next 12 months of expected payouts, one entry per calendar month (empty months included). */
export function dividendForecast(divs: DividendRecord[], today: string, heldTickers?: Set<string>): ForecastMonth[] {
  const horizon = addDays(today, 365);
  const months: ForecastMonth[] = [];
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    months.push({ month: d.toISOString().slice(0, 7), items: [], amountUsd: 0, declared: true });
  }
  const byMonth = new Map(months.map((x) => [x.month, x]));
  for (const d of divs) {
    if (!isExpected(d, today)) continue;
    const pay = dividendPayDate(d);
    if (pay > horizon) continue;
    if (!heldOk(heldTickers, d.ticker)) continue;
    const slot = byMonth.get(pay.slice(0, 7));
    if (!slot) continue;
    const amountUsd = netUsd(d);
    if (!(amountUsd > 0)) continue;
    const kind: DividendKind = isAuto(d) ? "estimate" : "declared";
    // Same stock on several brokers in one month = one payout.
    const same = slot.items.find((it) => it.ticker === norm(d.ticker) && it.payDate === pay);
    if (same) { same.amountUsd += amountUsd; if (kind === "estimate") same.kind = "estimate"; }
    else slot.items.push({ ticker: norm(d.ticker), payDate: pay, amountUsd, kind });
    slot.amountUsd += amountUsd;
  }
  for (const s of months) {
    s.items.sort((a, b) => a.payDate.localeCompare(b.payDate));
    s.declared = s.items.length > 0 && s.items.every((it) => it.kind === "declared");
  }
  // A month in the past horizon whose slot start is before the window is impossible; months
  // are generated from next month on, so the current month's remaining payouts go to it too.
  return months;
}

/** The current month's remaining payouts are not in `dividendForecast` (it starts next month). */
export function remainingThisMonth(divs: DividendRecord[], today: string, heldTickers?: Set<string>): ForecastItem[] {
  const month = today.slice(0, 7);
  const out: ForecastItem[] = [];
  for (const d of divs) {
    if (!isExpected(d, today)) continue;
    const pay = dividendPayDate(d);
    if (pay.slice(0, 7) !== month) continue;
    if (!heldOk(heldTickers, d.ticker)) continue;
    const amountUsd = netUsd(d);
    if (!(amountUsd > 0)) continue;
    const kind: DividendKind = isAuto(d) ? "estimate" : "declared";
    // Same stock on several brokers on one day = one payout.
    const same = out.find((it) => it.ticker === norm(d.ticker) && it.payDate === pay);
    if (same) { same.amountUsd += amountUsd; if (kind === "estimate") same.kind = "estimate"; }
    else out.push({ ticker: norm(d.ticker), payDate: pay, amountUsd, kind });
  }
  return out.sort((a, b) => a.payDate.localeCompare(b.payDate));
}

export interface ReceivedByTicker { ticker: string; amountUsd: number; }

/** Recorded payouts in the last 365 days, per ticker (sold stocks included). */
export function receivedLast12m(divs: (DividendRecord & { ext_id?: string | null })[], today: string): { total: number; byTicker: ReceivedByTicker[] } {
  const from = addDays(today, -365);
  const map = new Map<string, number>();
  for (const d of divs) {
    if (d.status !== "paid" || !isRecorded(d)) continue;
    const pay = dividendPayDate(d);
    if (!(pay > from && pay <= today)) continue;
    const a = netUsd(d);
    if (!(a > 0)) continue;
    map.set(norm(d.ticker), (map.get(norm(d.ticker)) ?? 0) + a);
  }
  const byTicker = [...map.entries()].map(([ticker, amountUsd]) => ({ ticker, amountUsd })).sort((a, b) => b.amountUsd - a.amountUsd);
  return { total: byTicker.reduce((s, x) => s + x.amountUsd, 0), byTicker };
}

/** Every recorded paid dividend (net USD) per pay day — the income part of cash changes. */
export function paidDividendsByDay(divs: (DividendRecord & { ext_id?: string | null })[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const d of divs) {
    if (d.status !== "paid" || !isRecorded(d)) continue;
    const a = netUsd(d);
    if (!(a > 0)) continue;
    const pay = dividendPayDate(d);
    map.set(pay, (map.get(pay) ?? 0) + a);
  }
  return map;
}

/** Expected yearly income per ticker from a forecast (+ the rest of this month). */
export function annualByTicker(forecast: ForecastMonth[], rest: ForecastItem[] = []): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of [...rest, ...forecast.flatMap((f) => f.items)]) m.set(it.ticker, (m.get(it.ticker) ?? 0) + it.amountUsd);
  return m;
}
