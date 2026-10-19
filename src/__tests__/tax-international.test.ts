import { describe, expect, it } from "vitest";
import { TAX_ENGINES, type TaxInput, type TaxTrade, type TaxProfile, type Profile, type Country } from "@/lib/tax/engines";
import { buildUsReport } from "@/lib/tax/us";
import { buildGbReport } from "@/lib/tax/gb";
import { buildDeReport, germanIncomeTax } from "@/lib/tax/de";
import { buildSkReport } from "@/lib/tax/sk";
import { buildPlReport } from "@/lib/tax/pl";
import { validateTaxProfile } from "@/lib/tax/profile";
import { createCnbFx } from "@/lib/tax/fx";
import { normalizeResidence, jurisdictionFor, TAX_RESIDENCES } from "@/lib/tax/jurisdictions";

const profiles: Record<Country, TaxProfile> = {
  US: { version: 1, year: 2024, residence: "US", filingStatus: "single", otherOrdinaryTaxableIncome: 50000,
    otherMagi: 70000, otherNetInvestmentIncome: 0, shortTermLossCarry: 0, longTermLossCarry: 0, foreignTaxCreditLimit: 0 },
  SK: { version: 1, year: 2024, residence: "SK", otherTaxableIncome: 0, securitiesAllowanceRemaining: 500,
    healthInsurance: "standard", deductibleHealthContributions: 0 },
  DE: { version: 1, year: 2024, residence: "DE", otherTaxableIncome: 30000, jointAssessment: false, churchTaxRate: 0,
    saverAllowanceUsed: 0, stockLossCarry: 0, generalLossCarry: 0, privateLossCarry: 0, otherPrivateDisposalNet: 0 },
  GB: { version: 1, year: 2024, residence: "GB", otherTaxableIncome: 50000, unusedPersonalAllowance: 0,
    basicRateBand: 37700, higherRateBandEnd: 125140, lossCarry: 0, annualExemptAmount: 3000, dividendAllowanceRemaining: 500 },
  PL: { version: 1, year: 2024, residence: "PL", otherSolidarityBase: 0, cryptoCostCarry: 0, securityLosses: [] },
};
const tx = (id: string, side: "BUY" | "SELL", shares: number, price: number, date: string, ticker = "A", extra: Partial<TaxTrade> = {}): TaxTrade =>
  ({ id, ticker, side, shares, price_usd: price, taxDate: date, executed_at: `${date}T12:00:00Z`, broker: "B", broker_account: "1", ...extra });
const input = (country: Country, trades: TaxTrade[] = [], profile = {}): TaxInput => ({ profile: { ...profiles[country], ...profile } as TaxProfile,
  trades, dividends: [], instruments: {
    A: { kind: "stock", assetId: "A", regulatedMarketSince: "2000-01-01" },
    B: { kind: "stock", assetId: "B", regulatedMarketSince: "2000-01-01" },
    C: { kind: "crypto", assetId: "C" },
    F: { kind: "etf", assetId: "F", regulatedMarketSince: "2000-01-01", deFundType: "equity", ukReportingFund: true },
  }, completeThrough: "2027-05-05", fundDataComplete: true,
  fx: date => ({ rate: 1, ref: date, source: "test-only", statutory: true }) });
const roundTrip = (gain: number, ticker = "A", buy = "2024-01-01", sell = "2024-06-01") =>
  [tx(`b${ticker}`, "BUY", 1, 10000, buy, ticker), tx(`s${ticker}`, "SELL", 1, 10000 + gain, sell, ticker)];

describe("US lot matching / wash sales", () => {
  it("uses calendar anniversary, not a fixed 365 days", () => {
    const r = buildUsReport(input("US", [tx("b", "BUY", 2, 100, "2023-06-01"), tx("s1", "SELL", 1, 200, "2024-06-01"), tx("s2", "SELL", 1, 200, "2024-06-02")]));
    expect(r.rows.map(x => x.classification)).toEqual(["short-term", "long-term"]);
  });
  it("partially disallows a loss and increases only the replacement segment's basis", () => {
    const r = buildUsReport(input("US", [tx("b", "BUY", 10, 100, "2023-01-01"), tx("s", "SELL", 10, 80, "2024-06-01"),
      tx("r", "BUY", 4, 90, "2024-06-20", "A", { broker: "OTHER" })]));
    expect(r.rows[0].gain).toBe(-200); expect(r.rows[0].washDisallowed).toBe(80); expect(r.rows[0].taxableGain).toBe(-120);
    expect(r.openLots[0].cost).toBe(440); expect(r.openLots[0].washBasis).toBe(80);
  });
  it("splits a larger replacement so subsequent partial sale consumes adjusted shares first", () => {
    const r = buildUsReport(input("US", [tx("b", "BUY", 4, 100, "2023-01-01"), tx("s", "SELL", 4, 80, "2024-02-01"),
      tx("r", "BUY", 10, 90, "2024-02-10"), tx("s2", "SELL", 2, 120, "2024-04-01")]));
    expect(r.rows[1].cost).toBe(220); expect(r.rows[1].gain).toBe(20);
    expect(r.openLots.map(x => [x.shares, x.cost])).toEqual([[2, 220], [6, 540]]);
  });
  it("handles chained wash sales and tacks actual holding days", () => {
    const r = buildUsReport(input("US", [tx("b", "BUY", 100, 10, "2024-01-01"), tx("s", "SELL", 100, 8, "2024-01-10"),
      tx("r", "BUY", 100, 9, "2024-01-20"), tx("s2", "SELL", 100, 10, "2024-01-30"), tx("r2", "BUY", 100, 8, "2024-02-05")]));
    expect(r.rows.map(x => x.washDisallowed)).toEqual([200, 100]);
    expect(r.openLots[0].cost).toBe(900); expect(r.openLots[0].holdingDate).toBe("2024-01-17");
  });
  it("matches pre-sale replacements still held, excludes consumed lots and day 31", () => {
    const r = buildUsReport(input("US", [tx("b", "BUY", 10, 100, "2023-01-01"), tx("pre", "BUY", 3, 90, "2024-05-15"),
      tx("s", "SELL", 10, 80, "2024-06-01"), tx("outside", "BUY", 9, 90, "2024-07-02")]));
    expect(r.rows[0].washDisallowed).toBe(60);
    expect(r.openLots.find(x => x.buyId === "pre")?.cost).toBe(330);
  });
  it("includes fees and the inclusive 30-day boundary across calendar years", () => {
    const r = buildUsReport(input("US", [tx("b", "BUY", 10, 100, "2023-01-01", "A", { fee_usd: 10 }),
      tx("s", "SELL", 10, 80, "2024-12-20", "A", { fee_usd: 10 }), tx("r", "BUY", 10, 90, "2025-01-19")]));
    expect(r.rows[0].washDisallowed).toBeCloseTo(220); expect(r.openLots[0].cost).toBeCloseTo(1120);
  });
  it("does not apply wash sale to spot crypto", () => {
    const r = buildUsReport(input("US", [...roundTrip(-200, "C"), tx("r", "BUY", 1, 9800, "2024-06-02", "C")]));
    expect(r.rows[0].washDisallowed).toBe(0); expect(r.rows[0].taxableGain).toBe(-200);
  });
  it("permanently disallows IRA replacement losses without increasing IRA basis", () => {
    const r = buildUsReport(input("US", [...roundTrip(-200), tx("r", "BUY", 1, 9800, "2024-06-02", "A", { broker_account: "IRA", accountType: "ira" })]));
    expect(r.rows[0].taxableGain).toBe(0); expect(r.openLots[0].washBasis).toBe(0);
  });
  it("supports documented specific ID and never borrows a different account's lots", () => {
    const r = buildUsReport(input("US", [tx("old", "BUY", 1, 100, "2023-01-01"), tx("new", "BUY", 1, 200, "2024-01-01"),
      tx("s", "SELL", 1, 300, "2024-06-01", "A", { lots: [{ buyId: "new", shares: 1 }] })]));
    expect(r.rows[0].cost).toBe(200); expect(r.rows[0].classification).toBe("short-term");
    const bad = input("US", [tx("b", "BUY", 1, 100, "2024-01-01"), tx("s", "SELL", 1, 150, "2024-06-01", "A", { broker_account: "2" })]);
    // Another account's lots are never borrowed: the sale stays unmatched — left out of the
    // estimate and named, not blanking the year.
    const rb = buildUsReport(bad);
    expect(rb.rows).toHaveLength(0);
    expect(rb.warnings.find((w) => w.code === "unmatched-sell")).toMatchObject({ blocking: false, ref: "s" });
  });
  it("allocates a replacement once across separate losses and does not mutate inputs", () => {
    const data = input("US", [tx("b", "BUY", 20, 100, "2023-01-01"), tx("s1", "SELL", 10, 80, "2024-06-01"),
      tx("s2", "SELL", 10, 70, "2024-06-02"), tx("r", "BUY", 10, 90, "2024-06-03")]);
    const snapshot = JSON.stringify(data); const r = buildUsReport(data);
    expect(r.rows.map(x => x.washDisallowed)).toEqual([200, 0]); expect(JSON.stringify(data)).toBe(snapshot);
  });
});

describe("US federal netting and income tax", () => {
  it("nets ST losses against LT gains before the preferential rate", () => {
    const r = buildUsReport(input("US", [...roundTrip(-4000), ...roundTrip(10000, "B", "2022-01-01")]));
    expect(r.breakdown.shortTermNet).toBe(0); expect(r.breakdown.longTermNet).toBe(6000); expect(r.estimatedTax).toBeCloseTo(900);
  });
  it("deducts $3000, consumes ST first and retains character in carryforward", () => {
    const r = buildUsReport(input("US", [...roundTrip(-2000), ...roundTrip(-5000, "B", "2022-01-01")]));
    expect(r.breakdown.capitalLossDeduction).toBe(3000); expect(r.carryforward).toEqual({ shortTerm: 0, longTerm: 4000 });
    // 2,850 at 22%, then 150 at 12% = $645 tax saving.
    expect(r.estimatedTax).toBeCloseTo(-645);
  });
  it("uses the $1500 married-separate limit and preserves unused deduction at low income", () => {
    const r = buildUsReport(input("US", roundTrip(-5000), { filingStatus: "marriedSeparate" }));
    expect(r.carryforward.shortTerm).toBe(3500);
    const low = buildUsReport(input("US", roundTrip(-5000), { otherOrdinaryTaxableIncome: -1000 }));
    expect(low.carryforward.shortTerm).toBe(5000); expect(low.estimatedTax).toBe(0);
  });
  it.each([[2024, 47025], [2025, 48350], [2026, 49450]])("stacks LT across the %i zero-rate band", (year, zero) => {
    const r = buildUsReport(input("US", roundTrip(2000, "A", "2020-01-01", `${year}-06-01`), { year, otherOrdinaryTaxableIncome: zero - 1000 }));
    expect(r.estimatedTax).toBeCloseTo(150);
  });
  it.each([["single", 518900], ["marriedJoint", 583750], ["marriedSeparate", 291850], ["headOfHousehold", 551350], ["qualifyingSurvivingSpouse", 583750]])("crosses the 15/20 boundary for %s", (filingStatus, ceiling) => {
    const r = buildUsReport(input("US", roundTrip(2000, "A", "2020-01-01"), { filingStatus, otherOrdinaryTaxableIncome: Number(ceiling) - 1000, otherMagi: 0 }));
    expect(r.estimatedTax).toBeCloseTo(350);
  });
  it("ST income crosses ordinary brackets rather than using one flat marginal rate", () => {
    const r = buildUsReport(input("US", roundTrip(1000), { otherOrdinaryTaxableIncome: 47000 }));
    expect(r.estimatedTax).toBeCloseTo(150 * .12 + 850 * .22);
  });
  it("NIIT uses MAGI, not taxable income, and is incremental", () => {
    const r = buildUsReport(input("US", roundTrip(10000, "A", "2020-01-01"), { otherMagi: 195000 }));
    expect(r.breakdown.niit).toBeCloseTo(190); expect(r.estimatedTax).toBeCloseTo(1690);
  });
  it("taxes qualified dividends at LT rates, ordinary dividends at ordinary rates and caps credit", () => {
    const data = input("US", [], { foreignTaxCreditLimit: 100 });
    data.dividends = [{ id: "q", ticker: "A", taxDate: "2024-06-01", grossUsd: 1000, withholdingUsd: 150, creditLimit: 150, qualified: true },
      { id: "o", ticker: "B", taxDate: "2024-06-01", grossUsd: 1000, withholdingUsd: 0, creditLimit: 0, qualified: false }];
    const r = buildUsReport(data); expect(r.taxBeforeCredit).toBeCloseTo(370); expect(r.estimatedTax).toBeCloseTo(270);
  });
  it("preserves an allowed foreign credit when a capital loss makes the portfolio tax delta negative", () => {
    const data = input("US", roundTrip(-3000), { foreignTaxCreditLimit: 100 });
    data.dividends = [{ id: "q", ticker: "B", taxDate: "2024-06-01", grossUsd: 1000, withholdingUsd: 150, creditLimit: 100, qualified: true }];
    const r = buildUsReport(data);
    expect(r.taxBeforeCredit).toBeCloseTo(-498.75); expect(r.foreignTaxCredit).toBe(100); expect(r.estimatedTax).toBeCloseTo(-598.75);
  });
});

describe("UK same-day, 30-day and Section 104", () => {
  it("pools across accounts and uses the average historical cost", () => {
    const r = buildGbReport(input("GB", [tx("b1", "BUY", 100, 10, "2023-01-01"), tx("b2", "BUY", 100, 20, "2024-01-01", "A", { broker: "OTHER" }), tx("s", "SELL", 100, 30, "2024-06-01")]));
    expect(r.rows[0].cost).toBe(1500); expect(r.rows[0].gain).toBe(1500); expect(r.rows[0].classification).toBe("section-104");
  });
  it("prioritizes same day, then 30 days, then the pool", () => {
    const r = buildGbReport(input("GB", [tx("old", "BUY", 100, 10, "2023-01-01"), tx("s", "SELL", 100, 30, "2024-06-01"),
      tx("same", "BUY", 20, 25, "2024-06-01"), tx("future", "BUY", 30, 20, "2024-07-01")]));
    expect(r.rows.map(x => [x.classification, x.shares, x.cost])).toEqual([["same-day", 20, 500], ["30-day", 30, 600], ["section-104", 50, 500]]);
    expect(r.breakdown["poolShares:A"]).toBe(50); expect(r.breakdown["poolCost:A"]).toBe(500);
  });
  it("reserves a future day's own same-day sale before matching an earlier disposal", () => {
    const r = buildGbReport(input("GB", [tx("old", "BUY", 100, 10, "2023-01-01"), tx("s1", "SELL", 50, 30, "2024-06-01"),
      tx("b", "BUY", 50, 20, "2024-06-10"), tx("s2", "SELL", 50, 25, "2024-06-10")]));
    expect(r.rows.find(x => x.sellId === "s1")?.cost).toBe(500);
    expect(r.rows.find(x => x.sellId === "s2")?.classification).toBe("same-day");
  });
  it("matches across April 5 and excludes April 6 disposals from the previous year", () => {
    const r = buildGbReport(input("GB", [tx("old", "BUY", 100, 10, "2023-01-01"), tx("s", "SELL", 50, 30, "2025-04-05"),
      tx("b", "BUY", 50, 20, "2025-04-20"), tx("s2", "SELL", 10, 25, "2025-06-01")]));
    expect(r.rows).toHaveLength(1); expect(r.rows[0].cost).toBe(1000); expect(r.rows[0].classification).toBe("30-day");
  });
  it("does not match day 31 and applies the same matching to crypto", () => {
    const r = buildGbReport(input("GB", [tx("b", "BUY", 1, 1000, "2023-01-01", "C"), tx("s", "SELL", 1, 1500, "2024-06-01", "C"), tx("r", "BUY", 1, 1200, "2024-07-02", "C")]));
    expect(r.rows[0].classification).toBe("section-104"); expect(r.rows[0].gain).toBe(500);
  });
  it("allocates AEA to post-30 October gains, then basic band to pre-change gains", () => {
    const r = buildGbReport(input("GB", [...roundTrip(5000), ...roundTrip(5000, "B", "2023-01-01", "2024-11-01")], { otherTaxableIncome: 33700 }));
    expect(r.breakdown.earlyTaxable).toBe(5000); expect(r.breakdown.lateTaxable).toBe(2000);
    expect(r.estimatedTax).toBe(4000 * .1 + 1000 * .2 + 2000 * .24);
  });
  it("uses current losses before AEA and brought-forward losses only above AEA", () => {
    const r = buildGbReport(input("GB", [...roundTrip(5000), ...roundTrip(-1000, "B")], { lossCarry: 5000 }));
    expect(r.estimatedTax).toBe(0); expect(r.carryforward.capitalLoss).toBe(4000);
  });
  it("uses the changed 2026 dividend rate and preserves band use by the £500 allowance", () => {
    const data = input("GB", [], { year: 2026, otherTaxableIncome: 37000 });
    data.dividends = [{ id: "d", ticker: "A", taxDate: "2026-06-01", grossUsd: 1000, withholdingUsd: 0, creditLimit: 0 }];
    expect(buildGbReport(data).estimatedTax).toBeCloseTo(200 * .1075 + 300 * .3575);
  });
});

describe("Slovakia", () => {
  it("requires more than one year of BOTH ownership and market admission", () => {
    const data = input("SK", [...roundTrip(2000, "A", "2023-06-01", "2024-06-01"), ...roundTrip(2000, "B", "2023-01-01", "2024-06-01")]);
    const r = buildSkReport(data);
    expect(r.rows.map(x => x.taxableGain)).toEqual([2000, 0]); expect(r.estimatedTax).toBe(1500 * .19); expect(r.healthContributions).toBe(225);
    data.instruments.B.regulatedMarketSince = "2024-01-01";
    expect(buildSkReport(data).estimatedTax).toBe(3500 * .19);
  });
  it("does not offset crypto with security losses, and has no crypto holding exemption", () => {
    const r = buildSkReport(input("SK", [...roundTrip(-2000), ...roundTrip(1000, "C", "2020-01-01")]));
    expect(r.estimatedTax).toBe(190); expect(r.healthContributions).toBe(150);
  });
  it("uses 2026 progressive bands and 16% health assessment", () => {
    const r = buildSkReport(input("SK", roundTrip(2000, "C", "2025-01-01", "2026-06-01"), { year: 2026, otherTaxableIncome: 75000 }));
    expect(r.estimatedTax).toBeCloseTo(10.32 * .30 + 1989.68 * .35); expect(r.healthContributions).toBe(320);
  });
  it("uses the corporate PROFIT year for 7/10%, and 19% for fund distributions", () => {
    const data = input("SK", [], { year: 2025 });
    data.dividends = [
      { id: "d1", ticker: "A", taxDate: "2025-06-01", grossUsd: 1000, withholdingUsd: 0, creditLimit: 0, profitYear: 2024, skCategory: "corporate" },
      { id: "d2", ticker: "B", taxDate: "2025-06-01", grossUsd: 1000, withholdingUsd: 150, creditLimit: 150, profitYear: 2025, skCategory: "corporate" },
      { id: "d3", ticker: "F", taxDate: "2025-06-01", grossUsd: 1000, withholdingUsd: 0, creditLimit: 0, skCategory: "fund" },
    ];
    const r = buildSkReport(data); expect(r.taxBeforeCredit).toBe(360); expect(r.foreignTaxCredit).toBe(70); expect(r.estimatedTax).toBe(290);
  });
});

describe("Germany", () => {
  it("applies €1000 allowance, 25% capital tax and 5.5% solidarity on TAX", () => {
    const r = buildDeReport(input("DE", roundTrip(2000)));
    expect(r.estimatedTax).toBeCloseTo(263.75);
  });
  it("keeps stock losses separate from ETF gains and dividends", () => {
    const data = input("DE", [...roundTrip(-2000), ...roundTrip(2000, "F")], { saverAllowanceUsed: 1000 });
    const r = buildDeReport(data); expect(r.taxableBase).toBe(1400); expect(r.carryforward.stockLoss).toBe(2000); expect(r.estimatedTax).toBeCloseTo(369.25);
  });
  it("subtracts prior Vorabpauschale before partial exemption and includes current deemed income", () => {
    const trades = roundTrip(2000, "F"); trades[0].priorFundIncome = 500;
    const data = input("DE", trades, { saverAllowanceUsed: 1000 });
    data.fundIncome = [{ id: "f", ticker: "F", taxDate: "2024-01-02", amount: 100 }];
    const r = buildDeReport(data); expect(r.rows[0].taxableGain).toBe(1050); expect(r.taxableBase).toBe(1120);
  });
  it("applies the crypto €1000 cliff, not a €1000 deduction, and the one-year test", () => {
    expect(buildDeReport(input("DE", roundTrip(999, "C"))).estimatedTax).toBe(0);
    const taxable = buildDeReport(input("DE", roundTrip(1000, "C")));
    expect(taxable.breakdown.privateBase).toBe(1000);
    expect(taxable.estimatedTax).toBe(germanIncomeTax(31000, 2024) - germanIncomeTax(30000, 2024));
    expect(buildDeReport(input("DE", roundTrip(2000, "C", "2020-01-01"))).estimatedTax).toBe(0);
  });
  it("uses the statutory church-tax denominator and foreign credit before surcharges", () => {
    const data = input("DE", [], { saverAllowanceUsed: 1000, churchTaxRate: .09 });
    data.dividends = [{ id: "d", ticker: "A", taxDate: "2024-06-01", grossUsd: 1000, withholdingUsd: 150, creditLimit: 150 }];
    expect(buildDeReport(data).estimatedTax).toBeCloseTo((1000 - 4 * 150) / 4.09 * 1.145);
  });
});

describe("Poland", () => {
  it("taxes securities at 19% and applies loss carry by vintage", () => {
    const r = buildPlReport(input("PL", roundTrip(10000), { securityLosses: [{ year: 2023, original: 4000, remaining: 4000, oneOffUsed: true }] }));
    expect(r.estimatedTax).toBe(8000 * .19); expect(r.polishLossCarry?.[0].remaining).toBe(2000);
  });
  it("expires losses after five years and can use the one-off deduction", () => {
    const r = buildPlReport(input("PL", roundTrip(10000, "A", "2024-01-01", "2025-06-01"), { year: 2025,
      securityLosses: [{ year: 2019, original: 10000, remaining: 10000, oneOffUsed: false }, { year: 2024, original: 6000, remaining: 6000, oneOffUsed: false }] }));
    expect(r.estimatedTax).toBe(4000 * .19); expect(r.polishLossCarry).toEqual([]);
  });
  it("deducts ALL annual crypto purchases, carries costs, and keeps securities separate", () => {
    const r = buildPlReport(input("PL", [...roundTrip(1000), tx("cb", "BUY", 2, 1000, "2024-01-01", "C"), tx("cs", "SELL", 1, 1500, "2024-06-01", "C")]));
    expect(r.estimatedTax).toBe(190); expect(r.carryforward.cryptoCosts).toBe(500); expect(r.breakdown.cryptoBase).toBe(0);
  });
  it("excludes crypto swaps and includes crypto income in the 4% solidarity base", () => {
    const r = buildPlReport(input("PL", [tx("swap", "BUY", 1, 50000, "2024-01-01", "C", { cryptoExchange: true }),
      tx("cash", "SELL", 1, 2000, "2024-06-01", "C")], { otherSolidarityBase: 999000 }));
    expect(r.estimatedTax).toBe(2000 * .19 + 1000 * .04);
  });
  it("taxes dividends separately even when securities have a loss", () => {
    const data = input("PL", roundTrip(-1000));
    data.dividends = [{ id: "d", ticker: "A", taxDate: "2024-06-01", grossUsd: 1000, withholdingUsd: 150, creditLimit: 150 }];
    expect(buildPlReport(data).estimatedTax).toBe(40);
  });
});

describe("international contract, FX and validation", () => {
  it.each(["US", "SK", "DE", "GB", "PL"] as Country[])("provides a pure annual simulation for %s", country => {
    const data = input(country, [tx("b", "BUY", 1, 1000, "2024-01-01")]);
    const snapshot = JSON.stringify(data);
    const result = TAX_ENGINES[country].simulate(data, { trade: tx("s", "SELL", 1, 10000, "2024-06-01") });
    expect(result.after.complete).toBe(true); expect(result.taxDelta).toBeGreaterThan(0); expect(JSON.stringify(data)).toBe(snapshot);
    expect(normalizeResidence(` ${country.toLowerCase()} `)).toBe(country);
    expect(jurisdictionFor(country).annualEngine).toBe(TAX_ENGINES[country]);
    expect(jurisdictionFor(country).caps.taxEstimate).toBe(false); // existing UI is Czech-only
  });
  it("leaves legacy UI choices unchanged", () => expect(TAX_RESIDENCES).toEqual(["CZ", "OTHER"]));
  it("requires complete lookahead and returns null instead of a misleading tax", () => {
    for (const country of ["US", "GB"] as Country[]) {
      const data = input(country, roundTrip(1000)); data.completeThrough = "2024-12-31";
      expect(TAX_ENGINES[country].report(data).estimatedTax).toBeNull();
    }
  });
  it("does not turn missing FX into zero, even when only the purchase date is missing", () => {
    const data = input("SK", roundTrip(1000)); data.fx = date => date === "2024-01-01" ? null : { rate: 1, ref: date, source: "test", statutory: true };
    const r = buildSkReport(data); expect(r.rows[0].gain).toBeNull(); expect(r.estimatedTax).toBeNull(); expect(r.complete).toBe(false);
  });
  it("converts cost and proceeds at their own dates", () => {
    const data = input("PL", [tx("b", "BUY", 1, 100, "2024-01-01"), tx("s", "SELL", 1, 100, "2024-06-01")]);
    data.fx = date => ({ rate: date === "2024-01-01" ? 4 : 5, ref: date, source: "NBP-test", statutory: true });
    const r = buildPlReport(data); expect(r.rows[0].gain).toBe(100); expect(r.estimatedTax).toBe(19);
  });
  it("crosses all currency legs on the same CNB date, and refuses stale future weekdays", () => {
    const fx = createCnbFx({ rates: { "2024-06-07": { USD: 23, EUR: 25, GBP: 29, PLN: 5.8 } } });
    expect(fx("2024-06-09", "EUR")?.rate).toBe(23 / 25); expect(fx("2024-06-07", "GBP")?.rate).toBe(23 / 29);
    expect(fx("2024-06-07", "PLN")?.statutory).toBe(false); expect(fx("2024-06-10", "EUR")).toBeNull();
    expect(fx("2024-06-06", "EUR")).toBeNull();
    expect(fx("not-a-date", "EUR")).toBeNull(); expect(fx("2024-02-30", "USD")).toBeNull();
  });
  it("rejects nonfinite inputs, unknown profile years, duplicate IDs and incorrect country profiles", () => {
    expect(validateTaxProfile({ ...profiles.US, year: 2027 }).success).toBe(false);
    expect(validateTaxProfile({ ...profiles.US, otherMagi: NaN }).success).toBe(false);
    expect(validateTaxProfile({ ...profiles.US, filingStatus: "guess" }).success).toBe(false);
    const { otherMagi, ...missing } = profiles.US as Profile<"US">;
    expect(validateTaxProfile(missing).success).toBe(false);
    const data = input("US", [tx("b", "BUY", 1, 100, "2024-01-01"), tx("b", "BUY", 1, 100, "2024-02-01")]);
    expect(() => buildUsReport(data)).toThrow(); expect(() => buildSkReport(input("US"))).toThrow();
  });
  it("blocks unclassified dividends and missing ETF deemed-income data", () => {
    const data = input("US"); data.dividends = [{ id: "d", ticker: "A", taxDate: "2024-06-01", grossUsd: 100, withholdingUsd: 0, creditLimit: 0 }];
    expect(buildUsReport(data).estimatedTax).toBeNull();
    const funds = input("DE", roundTrip(1000, "F")); funds.fundDataComplete = false;
    expect(buildDeReport(funds).estimatedTax).toBeNull();
  });
});
