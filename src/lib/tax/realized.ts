// Neutral yearly view for users whose tax rules the app does not implement: realized gains
// and losses from the shared FIFO disposals (src/lib/fifo.ts) and dividends, per calendar
// year, in the user's base currency. No exemptions, no limit, no tax estimate — what is
// taxable and how is up to the user's own country.
//
// CZK amounts use the daily rate of each date (the only USD/CZK history the app has): cost
// at the purchase date, proceeds and fees at the sale date. A missing rate leaves the row's
// amount empty and marks the year incomplete — never today's rate instead. Dividends are
// shown as the broker recorded them; no withholding is assumed (XTB records gross amounts,
// the others net, and the row count of each is reported so the view can say so). Only
// recorded payments count (statement, broker API, manual — isRecorded): sync-earnings marks
// its own projections 'paid' once the ex-date passes, and those already contain an assumed
// withholding, so they are left out and only counted.
import type { Disposal, FifoWarning } from "@/lib/fifo";
import { usdCzkFor } from "@/lib/cnbRates";
import { dividendAmountUsd, dividendPayDate, type DividendRecord } from "@/lib/dividendTax";
import { isRecorded } from "@/lib/dividendAnalytics";
import type { BaseCurrency } from "@/lib/tax/jurisdictions";

export interface RealizedRow {
  ticker: string;
  broker: string;
  account: string;
  kind: Disposal["kind"];
  acquiredDate: string;
  soldDate: string;
  shares: number;
  /** In the base currency; null when a rate is missing. */
  proceeds: number | null;
  cost: number | null;
  fees: number | null;
  gain: number | null;
  gainUsd: number;
}

export interface RealizedYear {
  year: number;
  currency: BaseCurrency;
  rows: RealizedRow[];
  proceeds: number;
  /** Sum of the positive row gains / of the negative ones (as a negative number). */
  gains: number;
  losses: number;
  net: number;
  /** projected: past sync-earnings projections without a recorded payment — not in total. */
  dividends: { total: number; count: number; grossRecorded: number; projected: number };
  /** Dates without an exchange rate (CZK only). */
  missingFx: string[];
  /** Sells the ledger has no purchase for — their gain is unknown. */
  unmatchedSells: number;
  complete: boolean;
}

const day = (iso: string) => iso.slice(0, 10);

/** USD → base currency on a date; null when the rate is missing. */
function toBase(usd: number, date: string, currency: BaseCurrency): number | null {
  if (currency === "USD") return usd;
  const fx = usdCzkFor(date, "cnb-daily");
  return fx ? usd * fx.rate : null;
}

export function buildRealizedReport(
  disposals: Disposal[], warnings: FifoWarning[], divs: DividendRecord[], year: number,
  currency: BaseCurrency, today = new Date().toISOString().slice(0, 10),
): RealizedYear {
  const missing = new Set<string>();
  const rows: RealizedRow[] = disposals
    .filter((d) => Number(day(d.soldAt).slice(0, 4)) === year)
    .map((d) => {
      const acquiredDate = day(d.acquiredAt), soldDate = day(d.soldAt);
      const proceeds = toBase(d.proceedsUsd, soldDate, currency);
      const fees = toBase(d.sellFeeUsd, soldDate, currency);
      const cost = d.costUsd === 0 ? 0 : toBase(d.costUsd, acquiredDate, currency);
      if (proceeds == null) missing.add(soldDate);
      if (cost == null) missing.add(acquiredDate);
      const gain = currency === "USD" ? d.gainUsd : proceeds != null && fees != null && cost != null ? proceeds - fees - cost : null;
      return { ticker: d.ticker, broker: d.broker, account: d.account, kind: d.kind, acquiredDate, soldDate, shares: d.shares, proceeds, cost, fees, gain, gainUsd: d.gainUsd };
    })
    .sort((a, b) => b.soldDate.localeCompare(a.soldDate) || a.ticker.localeCompare(b.ticker) || a.acquiredDate.localeCompare(b.acquiredDate));

  let proceeds = 0, gains = 0, losses = 0;
  for (const r of rows) {
    if (r.proceeds != null) proceeds += r.proceeds;
    if (r.gain == null) continue;
    if (r.gain >= 0) gains += r.gain; else losses += r.gain;
  }
  const unmatchedSells = warnings.filter((w) => w.kind === "unmatched-sell" && Number(day(w.date).slice(0, 4)) === year).length;

  const dividends = { total: 0, count: 0, grossRecorded: 0, projected: 0 };
  for (const d of divs) {
    const pay = dividendPayDate(d);
    if (d.status !== "paid" || pay > today || Number(pay.slice(0, 4)) !== year) continue;
    if (!isRecorded(d)) { dividends.projected++; continue; }
    const v = toBase(dividendAmountUsd(d), pay, currency);
    if (v == null) { missing.add(pay); continue; }
    dividends.total += v;
    dividends.count++;
    if (d.gross_amount_usd == null && String(d.broker ?? "").toUpperCase() === "XTB") dividends.grossRecorded++;
  }

  return {
    year, currency, rows, proceeds, gains, losses, net: gains + losses, dividends,
    missingFx: [...missing].sort(), unmatchedSells, complete: missing.size === 0 && unmatchedSells === 0,
  };
}

/** Years with a sale or a paid dividend, newest first, always including the current one. */
export function realizedYears(disposals: Disposal[], divs: DividendRecord[], today = new Date().toISOString().slice(0, 10)): number[] {
  const ys = new Set<number>([Number(today.slice(0, 4))]);
  for (const d of disposals) ys.add(Number(day(d.soldAt).slice(0, 4)));
  for (const d of divs) if (d.status === "paid" && isRecorded(d) && dividendPayDate(d) <= today) ys.add(Number(dividendPayDate(d).slice(0, 4)));
  return [...ys].filter(Number.isFinite).sort((a, b) => b - a);
}
