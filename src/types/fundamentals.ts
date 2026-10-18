export type FundamentalMetric =
  | "revenue" | "grossProfit" | "operatingIncome" | "netIncome"
  | "operatingCashFlow" | "capex" | "freeCashFlow" | "buybacks"
  | "dilutedEps" | "cash" | "totalDebt" | "sharesOutstanding"
  | "dilutedShares" | "equity" | "dividendsPaid" | "rnd" | "sga" | "costOfRevenue" | "ebitda";

export interface FundamentalSeries {
  /** Period end dates, ascending (YYYY-MM-DD). */
  periods: string[];
  /** Same length as periods; null = not reported. capex, buybacks and dividendsPaid are NEGATIVE (cash out). Older cached rows may lack the newer metrics — treat a missing array as all null. */
  values: Record<FundamentalMetric, (number | null)[]>;
}

export interface CompanyFundamentals {
  symbol: string;
  currency: string;
  fetchedAt: string;
  status: "ok" | "error";
  annual: FundamentalSeries;
  quarterly: FundamentalSeries;
}
