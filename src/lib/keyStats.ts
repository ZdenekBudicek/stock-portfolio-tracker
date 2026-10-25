// Key statistics for the stock detail (market cap, P/E, …): the live price against the latest
// statements. Price-based figures follow every price tick; the statement side is the latest
// trailing twelve months (four quarters, else the last fiscal year) and the latest balance sheet.
//
// - Market cap uses the period-end share count (split-adjusted like the valuation chart), so
//   EPS = net income / that count and P/E = price / EPS exactly.
// - Prices are in USD; a company reporting in another currency gets no price-based figures
//   rather than a ratio mixing two currencies.
// - A multiple on zero or negative earnings / cash flow / equity is meaningless and stays null.
import type { CompanyFundamentals } from '@/types/fundamentals';
import { latestFlow, latestStock } from '@/lib/valuationSeries';

export interface KeyStats {
  /** False when the statements are not in USD — price-based figures are then null. */
  priced: boolean;
  /** Period end of the share count the market cap uses. */
  sharesAsOf: string | null;
  /** Period end of the latest twelve-month figures. */
  ttmAsOf: string | null;
  shares: number | null;
  marketCap: number | null;
  ev: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  pfcf: number | null;
  evEbitda: number | null;
  divYield: number | null;
  eps: number | null;
  revenue: number | null;
  netMargin: number | null;
  roe: number | null;
  debtToEquity: number | null;
  netCash: number | null;
}

const pos = (num: number | null, den: number | null) => (num == null || den == null || num <= 0 || den <= 0 ? null : num / den);
const div = (num: number | null, den: number | null) => (num == null || den == null || den <= 0 ? null : num / den);

export function keyStats(f: CompanyFundamentals, price: number | null): KeyStats {
  const shares = latestStock(f, 'basicShares');
  const cash = latestStock(f, 'cash')?.value ?? null;
  const debt = latestStock(f, 'totalDebt')?.value ?? null;
  const equity = latestStock(f, 'equity')?.value ?? null;
  const ni = latestFlow(f, 'netIncome');
  const revenue = latestFlow(f, 'revenue');
  const fcf = latestFlow(f, 'fcf')?.value ?? null;
  const ebitda = latestFlow(f, 'ebitda')?.value ?? null;
  const dividends = latestFlow(f, 'dividendsPaid')?.value ?? null;

  const priced = (f.currency || 'USD') === 'USD';
  const n = shares && shares.value > 0 ? shares.value : null;
  const cap = priced && price != null && Number.isFinite(price) && price > 0 && n != null ? price * n : null;
  const ev = cap != null && cash != null && debt != null ? cap + debt - cash : null;
  const niV = ni?.value ?? null, revV = revenue?.value ?? null;
  const ttmEnds = [ni?.end, revenue?.end].filter((x): x is string => !!x).sort();

  return {
    priced,
    sharesAsOf: shares?.end ?? null,
    ttmAsOf: ttmEnds.length ? ttmEnds[ttmEnds.length - 1] : null,
    shares: n,
    marketCap: cap,
    ev,
    pe: pos(cap, niV),
    ps: pos(cap, revV),
    pb: pos(cap, equity),
    pfcf: pos(cap, fcf),
    evEbitda: pos(ev, ebitda),
    // dividendsPaid is negative (cash out); no payout in the statements = 0 %, unknown = null.
    divYield: cap != null && dividends != null ? Math.max(0, -dividends) / cap : null,
    eps: niV != null && n != null ? niV / n : null,
    revenue: revV,
    netMargin: niV != null ? div(niV, revV) : null,
    roe: niV != null ? div(niV, equity) : null,
    debtToEquity: div(debt, equity),
    netCash: cash != null && debt != null ? cash - debt : null,
  };
}
