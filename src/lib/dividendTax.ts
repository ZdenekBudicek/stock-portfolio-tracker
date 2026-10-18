// Dividends for the Czech tax return (§ 8 ZDP, příloha 3): gross income, the tax withheld
// abroad, both in CZK at the rate of the payment date, and the credit (zápočet) — capped at
// 15 % of the gross dividend, the treaty rate for US shares.
//
// The dividends table stores ONE amount per row and which one it is depends on the source:
//   XTB statement      → gross (XTB lists the withholding tax on a separate line)
//   T212 API, Revolut  → net, what landed in the account
//   auto (sync-earnings) → net by construction: gross × 0.85
// Where only one side is known, the other is derived with the 15 % US treaty rate and the row
// says so (`basis`). Rows that carry explicit gross/withheld columns use them as they are.
import { usdCzkFor, type FxMethod, type FxRate } from "@/lib/cnbRates";

export const ASSUMED_WHT_RATE = 0.15;
export const CREDIT_CAP_RATE = 0.15;
export const CZ_DIVIDEND_TAX_RATE = 0.15;

export interface DividendRecord {
  id: string;
  ticker: string;
  ex_date: string;
  pay_date: string | null;
  amount_per_share: number;
  shares_held: number | null;
  total_amount_usd: number | null;
  status: string;
  broker?: string | null;
  broker_account?: string | null;
  ext_id?: string | null;
  user_id?: string | null;
  /** Optional exact figures, when a source provides them. */
  gross_amount_usd?: number | null;
  withholding_tax_usd?: number | null;
}

export type DividendBasis = "exact" | "gross" | "net";

const normTicker = (t: string) => t.toUpperCase().split(".")[0];
const brokerUp = (d: DividendRecord) => String(d.broker ?? "manual").toUpperCase();
export const dividendAmountUsd = (d: DividendRecord) => Number(d.total_amount_usd ?? d.amount_per_share * (d.shares_held ?? 0)) || 0;

/** The day the dividend was paid — what decides the tax year. Statements store it in both columns. */
export const dividendPayDate = (d: DividendRecord) => d.pay_date ?? d.ex_date;

function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/**
 * Drop `auto` rows that repeat a dividend a statement (or a manual entry) already recorded.
 *
 * A statement only knows the PAYMENT date and stores it as ex_date too; sync-earnings stores
 * the real ex-date. The old de-duplication compared ex_dates, so the same dividend was kept
 * twice. Now a recorded payment anywhere from 3 days before the auto row's ex-date to 10 days
 * after its pay date is treated as that dividend. T212 rows never suppress auto rows: auto
 * past rows cover only the non-T212 shares, so both are real parts of the payout.
 */
export function dedupeDividends<T extends DividendRecord>(rows: T[]): T[] {
  const recorded = new Map<string, string[]>();
  for (const d of rows) {
    const b = brokerUp(d);
    if (b === "AUTO" || b === "T212") continue;
    const k = `${d.user_id ?? ""}|${normTicker(d.ticker)}`;
    (recorded.get(k) ?? recorded.set(k, []).get(k)!).push(dividendPayDate(d));
  }
  return rows.filter((d) => {
    if (brokerUp(d) !== "AUTO") return true;
    const dates = recorded.get(`${d.user_id ?? ""}|${normTicker(d.ticker)}`);
    if (!dates) return true;
    const from = addDays(d.ex_date, -3);
    const to = addDays(d.pay_date ?? addDays(d.ex_date, 40), 10);
    return !dates.some((x) => x >= from && x <= to);
  });
}

export interface DividendTaxRow {
  id: string;
  ticker: string;
  broker: string;
  payDate: string;
  basis: DividendBasis;
  /** Estimated by sync-earnings from public data, not a recorded payment. */
  estimated: boolean;
  grossUsd: number;
  whtUsd: number;
  netUsd: number;
  fx: FxRate | null;
  grossCzk: number | null;
  whtCzk: number | null;
  creditableCzk: number | null;
  /** Credit that WOULD apply if the assumed 15 % withholding really happened (unverified). */
  assumedCreditCzk: number;
}

export function dividendTaxRow(d: DividendRecord, fxMethod: FxMethod): DividendTaxRow {
  const broker = brokerUp(d);
  const amount = dividendAmountUsd(d);
  let basis: DividendBasis, grossUsd: number, whtUsd: number;
  if (d.gross_amount_usd != null) {
    basis = "exact";
    grossUsd = Number(d.gross_amount_usd);
    whtUsd = Number(d.withholding_tax_usd ?? 0);
  } else if (broker === "XTB") {
    basis = "gross";
    grossUsd = amount;
    whtUsd = amount * ASSUMED_WHT_RATE;
  } else {
    basis = "net";
    grossUsd = amount / (1 - ASSUMED_WHT_RATE);
    whtUsd = grossUsd - amount;
  }
  const payDate = dividendPayDate(d);
  const fx = usdCzkFor(payDate, fxMethod);
  const grossCzk = fx ? grossUsd * fx.rate : null;
  const whtCzk = fx ? whtUsd * fx.rate : null;
  return {
    id: d.id, ticker: d.ticker, broker, payDate, basis, estimated: broker === "AUTO",
    grossUsd, whtUsd, netUsd: grossUsd - whtUsd, fx, grossCzk, whtCzk,
    // Only a withholding the broker actually REPORTED is creditable. An assumed 15 % (net
    // amount grossed up, or an XTB gross with no tax line) may never have been withheld —
    // claiming it would under-pay. It is shown separately as an assumption to verify.
    creditableCzk: grossCzk != null && whtCzk != null ? (basis === "exact" ? Math.min(whtCzk, grossCzk * CREDIT_CAP_RATE) : 0) : null,
    assumedCreditCzk: grossCzk != null && whtCzk != null && basis !== "exact" ? Math.min(whtCzk, grossCzk * CREDIT_CAP_RATE) : 0,
  };
}

export interface DividendYearReport {
  year: number;
  rows: DividendTaxRow[];
  missingFx: string[];
  complete: boolean;
  grossCzk: number;
  whtCzk: number;
  creditableCzk: number;
  /** Credit resting on an assumed withholding — not included in creditableCzk / topUpCzk. */
  assumedCreditCzk: number;
  /** 15 % Czech tax on the gross dividends. */
  czTaxCzk: number;
  /** What remains to pay in CZ after the credit. */
  topUpCzk: number;
  /** Withheld above the 15 % cap — not creditable in CZ (reclaim abroad). */
  excessWhtCzk: number;
  estimatedCount: number;
  assumedCount: number;
}

export function buildDividendReport(divs: DividendRecord[], year: number, fxMethod: FxMethod, today = new Date().toISOString().slice(0, 10)): DividendYearReport {
  const rows = dedupeDividends(divs)
    .filter((d) => d.status === "paid" && dividendPayDate(d) <= today && Number(dividendPayDate(d).slice(0, 4)) === year)
    .map((d) => dividendTaxRow(d, fxMethod))
    .sort((a, b) => b.payDate.localeCompare(a.payDate) || a.ticker.localeCompare(b.ticker));
  const missing = new Set<string>();
  let grossCzk = 0, whtCzk = 0, creditableCzk = 0, assumedCreditCzk = 0;
  for (const r of rows) {
    if (r.grossCzk == null) { missing.add(r.payDate); continue; }
    grossCzk += r.grossCzk; whtCzk += r.whtCzk!; creditableCzk += r.creditableCzk!; assumedCreditCzk += r.assumedCreditCzk;
  }
  const czTaxCzk = grossCzk * CZ_DIVIDEND_TAX_RATE;
  return {
    year, rows, missingFx: [...missing].sort(), complete: missing.size === 0,
    grossCzk, whtCzk, creditableCzk, assumedCreditCzk, czTaxCzk,
    topUpCzk: Math.max(0, czTaxCzk - creditableCzk),
    excessWhtCzk: Math.max(0, whtCzk - creditableCzk - assumedCreditCzk),
    estimatedCount: rows.filter((r) => r.estimated).length,
    assumedCount: rows.filter((r) => r.basis !== "exact").length,
  };
}
