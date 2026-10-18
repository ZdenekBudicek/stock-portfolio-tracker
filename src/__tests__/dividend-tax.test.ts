import { describe, it, expect } from "vitest";
import { buildDividendReport, dedupeDividends, dividendTaxRow, type DividendRecord } from "@/lib/dividendTax";
import { cnbUsdCzk, gfrUsdCzk } from "@/lib/cnbRates";

let seq = 0;
const div = (o: Partial<DividendRecord>): DividendRecord => ({
  id: `d${++seq}`, ticker: "KO", ex_date: "2024-03-14", pay_date: "2024-04-01", amount_per_share: 1,
  shares_held: 1, total_amount_usd: 10, status: "paid", broker: "Revolut", user_id: "u1", ...o,
});

describe("dedupeDividends", () => {
  it("drops an auto row when a statement already recorded the same payment (pay date ≠ ex-date)", () => {
    // Statement: only the payment date, stored in both columns. Auto: the real ex-date.
    const statement = div({ broker: "Revolut", ex_date: "2024-04-01", pay_date: "2024-04-01" });
    const auto = div({ broker: "auto", ex_date: "2024-03-14", pay_date: "2024-04-01" });
    expect(dedupeDividends([statement, auto])).toEqual([statement]);
  });

  it("keeps auto rows next to T212 rows (they cover the non-T212 shares)", () => {
    const t212 = div({ broker: "T212", ex_date: "2024-04-01", pay_date: "2024-04-01" });
    const auto = div({ broker: "auto" });
    expect(dedupeDividends([t212, auto])).toHaveLength(2);
  });

  it("keeps an auto row of a different quarter and of another ticker", () => {
    const statement = div({ broker: "XTB", ex_date: "2024-07-01", pay_date: "2024-07-01" });
    const autoQ1 = div({ broker: "auto", ex_date: "2024-03-14", pay_date: "2024-04-01" });
    const autoOther = div({ broker: "auto", ticker: "PEP", ex_date: "2024-06-05", pay_date: "2024-07-01" });
    expect(dedupeDividends([statement, autoQ1, autoOther])).toHaveLength(3);
  });

  it("matches ticker variants (META vs META.US)", () => {
    const statement = div({ broker: "XTB", ticker: "META.US", ex_date: "2024-03-26", pay_date: "2024-03-26" });
    const auto = div({ broker: "auto", ticker: "META", ex_date: "2024-02-21", pay_date: "2024-03-26" });
    expect(dedupeDividends([statement, auto])).toEqual([statement]);
  });
});

describe("dividend gross / withholding / credit", () => {
  it("treats XTB amounts as gross and grosses up net amounts with the 15 % treaty rate", () => {
    const xtb = dividendTaxRow(div({ broker: "XTB", total_amount_usd: 100 }), "cnb-daily");
    expect(xtb).toMatchObject({ basis: "gross", grossUsd: 100 });
    expect(xtb.whtUsd).toBeCloseTo(15, 9);
    const rev = dividendTaxRow(div({ broker: "Revolut", total_amount_usd: 85 }), "cnb-daily");
    expect(rev.basis).toBe("net");
    expect(rev.grossUsd).toBeCloseTo(100, 9);
    expect(rev.whtUsd).toBeCloseTo(15, 9);
  });

  it("uses exact columns when present and caps the credit at 15 % of gross", () => {
    const row = dividendTaxRow(div({ gross_amount_usd: 100, withholding_tax_usd: 30, pay_date: "2024-04-02" }), "cnb-daily");
    const r = cnbUsdCzk("2024-04-02")!.rate;
    expect(row.basis).toBe("exact");
    expect(row.grossCzk).toBeCloseTo(100 * r, 6);
    expect(row.whtCzk).toBeCloseTo(30 * r, 6);
    expect(row.creditableCzk).toBeCloseTo(15 * r, 6);
  });

  it("builds the year by PAYMENT date, without duplicates or upcoming rows, in CZK at the payment-date rate", () => {
    const rows = [
      div({ broker: "Revolut", total_amount_usd: 85, ex_date: "2024-04-01", pay_date: "2024-04-01" }),
      div({ broker: "auto", total_amount_usd: 85, ex_date: "2024-03-14", pay_date: "2024-04-01" }), // duplicate
      div({ broker: "XTB", total_amount_usd: 50, ex_date: "2023-12-28", pay_date: "2024-01-15" }),  // ex 2023, paid 2024
      div({ status: "upcoming", ex_date: "2024-12-12", pay_date: "2025-01-02" }),
    ];
    const rep = buildDividendReport(rows, 2024, "cnb-daily", "2024-12-31");
    expect(rep.rows.map((r) => r.broker)).toEqual(["REVOLUT", "XTB"]);
    const expectedGross = 100 * cnbUsdCzk("2024-04-01")!.rate + 50 * cnbUsdCzk("2024-01-15")!.rate;
    expect(rep.grossCzk).toBeCloseTo(expectedGross, 6);
    // No reported withholding on these rows: nothing is creditable, the 15 % is only an assumption.
    expect(rep.creditableCzk).toBeCloseTo(0, 6);
    expect(rep.assumedCreditCzk).toBeCloseTo(expectedGross * 0.15, 6);
    expect(rep.topUpCzk).toBeCloseTo(expectedGross * 0.15, 6);
    expect(rep.complete).toBe(true);
  });

  it("GFŘ unified rates reproduce the published values", () => {
    expect([2020, 2021, 2022, 2023, 2024, 2025].map((y) => gfrUsdCzk(y)!.rate)).toEqual([23.14, 21.72, 23.41, 22.14, 23.28, 21.84]);
    expect(gfrUsdCzk(2099)).toBeNull();
  });
});
