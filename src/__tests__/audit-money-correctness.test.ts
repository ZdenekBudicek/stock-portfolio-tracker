import { describe, expect, it, vi } from "vitest";
import { parseXtbTrades, parseT212Activity, excelDateToISO, type NormalizedRow } from "@/lib/statements";
import { datedCzkPer, datedUsd, makeRateLookup } from "@/lib/fxLookup";
import { buildDividendReport, dividendTaxRow, type DividendRecord } from "@/lib/dividendTax";
import { computeNetDeposits } from "@/lib/netDeposits";
import { collectT212CashPages, t212CashId, t212ExternalCashFlows, matchT212CashStatements, parseT212OrderItem, priceT212Fills, t212FillPriceUsd } from "../../supabase/functions/_shared/t212";

const serial = 45719; // 2025-03-03
const day = excelDateToISO(serial).slice(0, 10);
const header = ["Type", "Ticker", "Instrument", "Time", "Amount", "ID", "Comment"];
const cash = (currency: string, rows: unknown[][]) => [["Account number", "12345"], ["Account currency", currency], header, ...rows];
const dividend = (row: Partial<DividendRecord>): DividendRecord => ({ id: "div", ticker: "AAPL", ex_date: day, pay_date: day, status: "paid", broker: "XTB", amount_per_share: 10, shares_held: 1, total_amount_usd: 10, ...row });

describe("B1 XTB dated currency conversion", () => {
  it.each(["USD", "CZK", "EUR", "PLN"])("converts %s account cash independently of the US execution currency", (currency) => {
    const rows = parseXtbTrades(cash(currency, [
      ["Stock purchase", "AAPL.US", "", serial, -100, "trade", "OPEN BUY 1 @ 100"],
      ["Deposit", "", "", serial, 1000, "deposit", ""],
    ]));
    expect(rows[0]).toMatchObject({ kind: "TRADE", price_usd: 100, ccy: "USD", price_ccy: 100 });
    expect(rows[1].amount_usd).toBeCloseTo(datedUsd(1000, currency, day));
    expect(rows[1]).toMatchObject({ original_amount: 1000, original_currency: currency });
  });

  it("C1 preserves the legacy ticker and converts buys and closes using the raw listing currency", () => {
    const closed = [["Instrument", "Category", "Ticker", "Type", "Volume", "Close Price", "Close Time (UTC)", "Position ID"],
      ["SAP", "STOCK", "SAP.DE", "BUY", 1, 120, serial + 1, "position"]];
    const rows = parseXtbTrades(cash("CZK", [["Stock purchase", "SAP.DE", "", serial, -2500, "trade", "OPEN BUY 1 @ 100"]]), closed);
    expect(rows.map((r) => r.ticker)).toEqual(["SAP", "SAP"]);
    expect(rows[0].price_usd).toBeCloseTo(datedUsd(100, "EUR", day));
    expect(rows[1].price_usd).toBeCloseTo(datedUsd(120, "EUR", excelDateToISO(serial + 1).slice(0, 10)));
  });

  it.each([["CEZ.CZ", "CEZ", "CZK"], ["PKN.PL", "PKN", "PLN"], ["BARC.UK", "BARC", "GBP"]])(
    "C1 stores %s under %s while pricing in %s", (raw, ticker, currency) => {
      const rows = parseXtbTrades(cash("USD", [["Stock purchase", raw, "", serial, -100, "trade", `OPEN BUY 1 @ 100 ${currency === "GBP" ? currency : ""}`]]));
      expect(rows[0]).toMatchObject({ kind: "TRADE", ticker, ccy: currency });
      expect(rows[0].price_usd).toBeCloseTo(datedUsd(100, currency, day));
    });

  it("marks unknown account/instrument currency for visible review", () => {
    const rows = parseXtbTrades(cash("XYZ", [
      ["Deposit", "", "", serial, 100, "deposit", ""],
      ["Stock purchase", "UNKNOWN.ZZ", "", serial, -100, "trade", "OPEN BUY 1 @ 100"],
    ]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "SKIP" && r.needs_review && !r.price_usd && !r.amount_usd)).toBe(true);
  });
});

describe("B4 actual withholding", () => {
  it("pairs a 30% withholding with the gross dividend and never imports it as a second fee", () => {
    const rows = parseXtbTrades(cash("EUR", [
      ["Withholding tax", "SAP.DE", "", serial, -3, "tax", ""],
      ["Dividend", "SAP.DE", "", serial, 10, "div", ""],
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "DIVIDEND", original_currency: "EUR", gross_amount: 10, withholding_tax: 3 });
    const r = dividendTaxRow(dividend(rows[0]), "cnb-daily");
    expect(r.basis).toBe("exact");
    expect(r.whtUsd / r.grossUsd).toBeCloseTo(0.3);
    expect(r.creditableCzk).toBeCloseTo(r.grossCzk! * 0.15);
    expect(buildDividendReport([dividend(rows[0])], 2025, "cnb-daily").complete).toBe(true);
  });

  it("does not fabricate zero withholding from gross alone or complete an estimated report", () => {
    const d = dividend({ gross_amount_usd: 10 });
    expect(dividendTaxRow(d, "cnb-daily")).toMatchObject({ basis: "gross", estimated: true, whtUsd: 1.5, creditableCzk: 0 });
    expect(buildDividendReport([d], 2025, "cnb-daily").complete).toBe(false);
    expect(dividendTaxRow(dividend({ gross_amount_usd: 10, withholding_tax_usd: 0 }), "cnb-daily").basis).toBe("exact");
  });

  it("keeps ambiguous same-day payments estimated", () => {
    const rows = parseXtbTrades(cash("USD", [
      ["Dividend", "AAPL.US", "", serial, 10, "d1", ""],
      ["Dividend", "AAPL.US", "", serial, 20, "d2", ""],
      ["Withholding tax", "AAPL.US", "", serial, -3, "tax", ""],
    ]));
    expect(rows.every((r) => r.withholding_tax_usd == null)).toBe(true);
  });
});

describe("B3 resumable cash history", () => {
  const response = (items: unknown[], nextPagePath: string | null) => new Response(JSON.stringify({ items, nextPagePath }));
  it("stages twelve pages and resumes without advancing the cutoff", async () => {
    let page = 0;
    const fetch = vi.fn(async () => response([{ dateTime: "2025-03-03T12:00:00Z", reference: ++page }], page < 13 ? "/api/v0/equity/history/transactions?cursor=" + page : null));
    const first = await collectT212CashPages(fetch, { cutoff: "2025-03-02", path: "/start", items: [] });
    expect(first.items).toHaveLength(12);
    expect(first.cutoff).toBe("2025-03-02");
    expect(first.path).not.toBeNull();
    const last = await collectT212CashPages(fetch, first);
    expect(last.items).toHaveLength(13);
    expect(last.path).toBeNull();
  });
  it("does not stop on the cutoff day, preserving a second same-day deposit", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([{ dateTime: day + "T18:00:00Z", reference: "one", amount: 0.5 }], "/next"))
      .mockResolvedValueOnce(response([{ dateTime: day + "T09:00:00Z", reference: "two", amount: 0.5 }], null));
    const out = await collectT212CashPages(fetch, { cutoff: day, path: "/start", items: [] });
    expect(out.items.map((r) => t212CashId("account", r))).toEqual(["t212:cashtx:account:one", "t212:cashtx:account:two"]);
  });
  it("propagates HTTP failures without mutating saved progress", async () => {
    const state = { cutoff: day, path: "/start", items: [] };
    await expect(collectT212CashPages(async () => new Response("", { status: 429 }), state)).rejects.toThrow(/429/);
    expect(state).toEqual({ cutoff: day, path: "/start", items: [] });
    expect(() => t212CashId("account", {})).toThrow(/stable/);
  });
  it("keeps small single-currency deposits and excludes broker-classified non-deposit types", () => {
    const rows = ["DEPOSIT", "WITHDRAW", "INTEREST", "FEE", "TRANSFER"].map((type) => ({ type, currency: "USD", dateTime: day, amount: 0.01 }));
    expect(t212ExternalCashFlows(rows, "USD", day).map((r) => r.type)).toEqual(["DEPOSIT", "WITHDRAW"]);
  });
  it.each([0.01, 100, 100000])("C2 excludes conversion legs regardless of amount (%s)", (amount) => {
    const dateTime = day + "T12:00:00Z";
    const rows = [
      { dateTime, type: "WITHDRAW", currency: "CZK", amount: -amount * 25 },
      { dateTime, type: "DEPOSIT", currency: "USD", amount },
      { dateTime, type: "FEE", currency: "CZK", amount: -0.01 },
    ];
    expect(t212ExternalCashFlows(rows, "CZK", day)).toEqual([]);
    expect(t212ExternalCashFlows(rows, "USD", day)).toEqual([]);
    // Every leg counts, even when the only other-currency leg is a fee.
    expect(t212ExternalCashFlows(rows.slice(1), "USD", day)).toEqual([]);
  });
  it("C2 excludes conversions split across resumed pages but retains nearby tiny external flows", async () => {
    const dateTime = day + "T12:00:00Z";
    const withdrawal = { dateTime, reference: "out", type: "WITHDRAW", currency: "CZK", amount: -2500 };
    const deposit = { dateTime, reference: "in", type: "DEPOSIT", currency: "USD", amount: 100 };
    const tiny = ["DEPOSIT", "WITHDRAW"].map((type) => ({ dateTime: day + "T12:00:01Z", reference: type, type, currency: "USD", amount: 0.01 }));
    const fetch = vi.fn(async () => response([deposit, ...tiny], null));
    const completed = await collectT212CashPages(fetch, { cutoff: day, path: "/equity/history/transactions?cursor=next", items: [withdrawal] });
    expect(completed.path).toBeNull();
    expect(t212ExternalCashFlows(completed.items, "CZK", day)).toEqual([]);
    expect(t212ExternalCashFlows(completed.items, "USD", day)).toEqual(tiny);
  });
  it("links statement matches once while retaining a second equal API deposit", () => {
    const flow = { flow_date: day, amount_usd: 1, original_amount: 1, original_currency: "USD" };
    const rows = [{ ...flow, ext_id: "api:1" }, { ...flow, ext_id: "api:2" }, { ...flow, ext_id: "api:2" }];
    const stored = [{ ...flow, id: "statement", broker_account: "a", source: "statement", ext_id: "statement:1" }];
    const result = matchT212CashStatements(rows, stored, "a");
    expect(result.links).toEqual([{ id: "statement", api_reference: "api:1" }]);
    expect(result.fresh.map((r) => r.ext_id)).toEqual(["api:2"]);
  });
});

describe("B5 execution costs and bounded FX", () => {
  it("bounds weekends and rejects future, empty and stale rates", () => {
    const lookup = makeRateLookup([{ date: "2025-03-07", close: 23 }]);
    expect(lookup("2025-03-09")).toBe(23);
    expect(lookup("2025-03-06")).toBeNaN();
    expect(lookup("2025-03-14")).toBeNaN();
    expect(makeRateLookup([])(day)).toBeNaN();
  });
  it("separates fees from buy/sell settlement without using a close", () => {
    const money = { instrumentCurrency: "EUR", price: 90, quantity: 1, walletCurrency: "USD", walletFee: 2 };
    expect(t212FillPriceUsd({ ...money, side: "BUY", walletNetValue: -102 }, () => null, () => 777, day)).toBe(100);
    expect(t212FillPriceUsd({ ...money, side: "SELL", walletNetValue: 98 }, () => null, () => 777, day)).toBe(100);
  });
  it("keeps API tax/fee amounts and converts them at the execution date", async () => {
    const raw = parseT212OrderItem({ order: { status: "FILLED", ticker: "AAPL_US_EQ", instrument: { currency: "USD" } },
      fill: { id: 1, quantity: 1, price: 100, filledAt: day + "T12:00:00Z", walletImpact: { currency: "CZK", netValue: -2323, taxes: [{ name: "CURRENCY_CONVERSION_FEE", quantity: 23, currency: "CZK" }] } } })!;
    const query = { select: () => query, eq: () => query, gte: () => query, order: () => query,
      in: async () => ({ data: [{ alias: "AAPL", canonical: "AAPL" }] }), range: async () => ({ data: [{ date: day, close: 23 }], error: null }) };
    const result = await priceT212Fills({ from: () => query } as unknown as Parameters<typeof priceT212Fills>[0], [raw]);
    expect(result.unpriced).toEqual([]);
    expect(result.rows[0]).toMatchObject({ price_usd: 100, fee_usd: 1 });
  });
  it("retains statement fee columns", () => {
    const rows = parseT212Activity("2025-03-03 10:00:00 ASML NL0010273215 EUR 123 Koupit 2 650.00 1300.00 Trh XETRA 1.08 USD 1.00 0.50 - 1405.50");
    expect(rows[0]).toMatchObject({ fee_amount: 1.5, fee_currency: "USD", usd_total: 1405.5 });
  });
});

describe("B12 dated USD deposits", () => {
  const t212 = { account: "a", currency: "USD", total: 150, ppl: 0, result: 0 };
  it("converts each flow at its own date and keeps other accounts outside the identity", () => {
    const result = computeNetDeposits({ txs: [], t212, usdCzk: 30, fxAt: (date) => date === "2024-01-02" ? 20 : 25,
      deposits: [{ broker: "T212", broker_account: "a", flow_date: "2024-01-02", amount_usd: 100 },
        { broker: "T212", broker_account: "a", flow_date: "2025-01-02", amount_usd: 50 },
        { broker: "T212", broker_account: "b", flow_date: day, amount_usd: 999 }] });
    expect(result).toEqual({ usd: 150, czk: 3250 });
  });
  it("marks an undated account identity as an estimate", () => {
    expect(computeNetDeposits({ txs: [], t212, usdCzk: 30, fxAt: () => 20 })).toEqual({ usd: 150, czk: 4500, estimated: true });
  });
  it("keeps known deposits dated even when the ledger is incomplete", () => {
    expect(computeNetDeposits({ txs: [], t212, usdCzk: 30, fxAt: () => 20,
      deposits: [{ broker: "T212", broker_account: "a", flow_date: day, amount_usd: 100 }] }))
      .toEqual({ usd: 150, czk: 3500, estimated: true });
  });
});
