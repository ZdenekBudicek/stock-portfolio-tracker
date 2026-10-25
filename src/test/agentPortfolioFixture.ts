import type { DbPosition, RawSnapshot, DbTransaction, LivePrices } from "@/lib/portfolioTypes";
import type { LocalFx } from "@/lib/displayCurrency";
import type { DividendRecord } from "@/lib/dividendTax";
import type { Country, TaxProfile } from "@/lib/tax/engines";

export function createPortfolioFixture() {
  const positions: DbPosition[] = [
    { id: "stock", ticker: "SYN", name: "Synthetic stock", type: "Stock", shares: 6, avg_cost_usd: 100, sector: null, holding_start_date: null },
    { id: "cash", ticker: "CASH", name: "Cash", type: "Cash", shares: 300, avg_cost_usd: 1, sector: null, holding_start_date: null },
  ];
  const transactions: DbTransaction[] = [
    { id: "buy", ticker: "SYN", side: "BUY", shares: 10, price_usd: 100, fee_usd: 0, executed_at: "2024-01-02T12:00:00Z", note: null, broker: "manual" },
    { id: "sell", ticker: "SYN", side: "SELL", shares: 4, price_usd: 150, fee_usd: 0, executed_at: "2024-02-02T12:00:00Z", note: null, broker: "manual" },
  ];
  const snapshots: RawSnapshot[] = [
    { fxBasis: "raw-czk", snapshot_date: "2024-01-02", value_usd: 100, value_czk: 2000, profit_usd: 10, profit_czk: 200, profit_pct: 10, fx_rate: 20, cash_usd: 300 },
  ];
  const livePrices: LivePrices = { prices: { SYN: { price: 200, changePct: 5, prevClose: 190 } }, usdCzk: 25,
    stale: false, fetchedAt: "2025-01-02T12:00:00Z", error: null };
  const fx: LocalFx = { code: "CZK", perCzkAt: () => 1, perCzkToday: 1 };
  return { positions, transactions, snapshots, livePrices, fx };
}

// Captured against the original hook before extraction; independent of the shared model.
export const portfolioGolden = {
  positions: [
    { ticker: "SYN", name: "Synthetic stock", type: "Stock", shares: 6, avgPrice: 100, currentPrice: 200,
      invested: 600, value: 1200, profitUsd: 600, profitPct: 100, avgPriceCzk: 2000, investedCzk: 12000,
      valueCzk: 30000, profitCzk: 18000, profitPctCzk: 150, dailyChangeUsd: 60, dailyChangePct: 5, allocation: 80 },
    { ticker: "CASH", name: "Cash", type: "Cash", shares: 300, avgPrice: 1, currentPrice: 1,
      invested: 300, value: 300, profitUsd: 0, profitPct: 0, avgPriceCzk: 25, investedCzk: 7500,
      valueCzk: 7500, profitCzk: 0, profitPctCzk: 0, dailyChangeUsd: 0, dailyChangePct: 0, allocation: 20 },
  ],
  totalValue: 1500, totalInvested: 600, totalInvestedCzk: 12000, unrealizedProfit: 600, unrealizedProfitCzk: 18000,
  realizedProfit: 200, dailyReturn: 60, netDepositsUsd: null, netDepositsCzk: null, totalProfit: 800, totalProfitCzk: 20000,
  totalReturnPct: 133.33333333333331, totalReturnPctCzk: 133.33333333333331,
  totalProfitPct: 100, totalProfitPctCzk: 150, usdCzk: 25, usdLocal: 25,
};

export function createTaxFixture() {
  const fixture = createPortfolioFixture();
  const transactions = fixture.transactions.map(t => t.side === "SELL"
    ? { ...t, executed_at: "2026-02-02T12:00:00Z" } : t);
  const dividends: DividendRecord[] = [
    { id: "paid", ticker: "SYN", ex_date: "2026-02-01", pay_date: "2026-02-02", amount_per_share: 2,
      shares_held: 6, total_amount_usd: 12, status: "paid", broker: "manual" },
  ];
  return { transactions, dividends, positions: portfolioGolden.positions.map(p => ({ ...p })),
    registry: { positions: fixture.positions, aliases: [], profiles: [] },
    year: 2026, today: "2026-10-23", usdCzk: 25,
    settings: { fxMethod: "cnb-daily" as const, limitIncludesExempt: true }, currency: "USD" as const };
}

export function createInternationalFixture(country: Country = "SK") {
  const profiles: Record<Country, TaxProfile> = {
    SK: { version: 1, year: 2026, residence: "SK", otherTaxableIncome: 0, securitiesAllowanceRemaining: 500,
      healthInsurance: "standard", deductibleHealthContributions: 0 },
    US: { version: 1, year: 2026, residence: "US", filingStatus: "single", otherOrdinaryTaxableIncome: 50000,
      otherMagi: 70000, otherNetInvestmentIncome: 0, shortTermLossCarry: 0, longTermLossCarry: 0, foreignTaxCreditLimit: 0 },
    DE: { version: 1, year: 2026, residence: "DE", otherTaxableIncome: 30000, jointAssessment: false, churchTaxRate: 0,
      saverAllowanceUsed: 0, stockLossCarry: 0, generalLossCarry: 0, privateLossCarry: 0, otherPrivateDisposalNet: 0 },
    GB: { version: 1, year: 2026, residence: "GB", otherTaxableIncome: 50000, unusedPersonalAllowance: 0,
      basicRateBand: 37700, higherRateBandEnd: 125140, lossCarry: 0, annualExemptAmount: 3000, dividendAllowanceRemaining: 500 },
    PL: { version: 1, year: 2026, residence: "PL", otherSolidarityBase: 0, cryptoCostCarry: 0, securityLosses: [] },
  };
  const fixture = createTaxFixture();
  return { ...fixture, residence: country, storedProfiles: { profiles: { [`${country}-2026`]: profiles[country] } } };
}

export function createSaleFixture() {
  const fixture = createTaxFixture();
  const transactions: DbTransaction[] = ["A", "B"].map((account, i) => ({
    id: `buy-${account}`, ticker: "AAPL", side: "BUY", shares: 5, price_usd: (i + 1) * 100,
    fee_usd: 0, executed_at: "2026-01-02T12:00:00Z", note: null, broker: "synthetic", broker_account: account,
  }));
  return { ...fixture, transactions };
}
