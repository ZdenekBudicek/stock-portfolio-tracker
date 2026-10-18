import { describe, it, expect } from "vitest";
import { parseRevolutDate, parseUsd, parseRevolutText, parseRevolutHoldings } from "../lib/statements";

describe("parseRevolutHoldings (portfolio breakdown snapshot)", () => {
  const text = [
    "USD Portfolio breakdown",
    "Symbol Company ISIN Quantity Price Value % of Portfolio",
    "AMD Advanced Micro Devices US0079031078 45.1853983 US$519.85 US$23,489.63 33.13%",
    "TSLA Tesla US88160R1014 47.08421402 US$381.61 US$17,967.81 25.34%",
    "GOOGL Alphabet (Class A) US02079K3059 28.38797254 US$346.13 US$9,825.93 13.86%",
    "Positions Value US$70,904.90 100%",
    "USD Transactions",
  ].join("\n");
  const h = parseRevolutHoldings(text);
  it("extracts ticker + shares from breakdown rows", () => {
    expect(h.find((r) => r.ticker === "AMD")).toMatchObject({ kind: "HOLDING", shares: 45.1853983, price_usd: 519.85, broker: "Revolut", external_id: "revolut:pos:AMD" });
    expect(h.find((r) => r.ticker === "TSLA")?.shares).toBe(47.08421402);
    expect(h.find((r) => r.ticker === "GOOGL")?.shares).toBe(28.38797254);
  });
  it("stops at Positions Value (no summary rows)", () => {
    expect(h.length).toBe(3);
  });
});

describe("revolut helpers", () => {
  it("parseRevolutDate -> ISO", () => {
    expect(parseRevolutDate("25 Feb 2021 16:21:12")).toBe("2021-02-25T16:21:12.000Z");
  });
  it("parseUsd strips commas", () => {
    expect(parseUsd("1,106.51")).toBe(1106.51);
  });
});

describe("parseRevolutText", () => {
  const text = [
    "25 Feb 2021 16:20:35 GMT        Cash top-up                          US$46.76 US$0 US$0",
    "25 Feb 2021 16:21:12 GMT TSLA Trade - Market    0.0651789 US$717.41 Buy US$46.76 US$0 US$0",
    "01 Mar 2021 14:30:12 GMT AAPL Trade - Market    9.27096461 US$123.78 Buy US$1,148.85 US$0 US$1.29",
    "05 Apr 2021 04:53:38 GMT KO Dividend            US$6.94 US$0 US$0",
    "22 Mar 2021 11:01:08 GMT  Cash withdrawal       -US$1,176.11 US$0 US$0",
    "01 Mar 2021 00:04:14 GMT        Custody fee     -US$0.02 US$0 US$0",
    "Some header line without a date",
  ].join("\n");
  const p = parseRevolutText(text);

  // Revolut's "Value" column is the NET CASH of the trade: quantity × price + commission on
  // a buy, − fees on a sell. Deriving the per-share price from it therefore folded the fee
  // into the price, and the fee was then added to the cost basis a second time. The printed
  // per-share price (the US$ amount right before Buy/Sell) is the one to use.
  it("parses a buy trade with fee + comma value, price excludes the commission", () => {
    const aapl = p.find((r) => r.ticker === "AAPL")!;
    expect(aapl).toMatchObject({ kind: "TRADE", side: "BUY", shares: 9.27096461, fee_usd: 1.29, broker: "Revolut" });
    expect(aapl.price_usd).toBeCloseTo(123.78, 6);
    expect(aapl.shares! * aapl.price_usd! + aapl.fee_usd!).toBeCloseTo(1148.85, 1);
  });
  it("parses tsla buy", () => {
    const tsla = p.find((r) => r.ticker === "TSLA")!;
    expect(tsla).toMatchObject({ kind: "TRADE", side: "BUY", shares: 0.0651789 });
    expect(tsla.price_usd).toBeCloseTo(717.41, 6);
  });
  it("falls back to value/quantity when the printed price is unusable", () => {
    // pdfjs sometimes glues the VALUE onto the side ("US$3,099.55Sell"), so the number found
    // before the side is not always the price — a sanity check against quantity catches it.
    const glued = parseRevolutText("25 Feb 2021 16:21:12 GMT TSLA Trade - Market 10 US$3,099.55Sell US$3,099.55 US$0 US$0");
    expect(glued[0].price_usd).toBeCloseTo(309.955, 3);
  });
  it("parses deposit, withdrawal, dividend, fee", () => {
    expect(p.filter((r) => r.kind === "DEPOSIT")[0]).toMatchObject({ amount_usd: 46.76 });
    expect(p.find((r) => r.kind === "WITHDRAWAL")).toMatchObject({ amount_usd: 1176.11 });
    expect(p.find((r) => r.kind === "DIVIDEND")).toMatchObject({ ticker: "KO", amount_usd: 6.94 });
    expect(p.find((r) => r.kind === "FEE")).toMatchObject({ amount_usd: -0.02 });
  });
  it("ignores non-dated lines", () => {
    expect(p.every((r) => !!r.executed_at)).toBe(true);
  });
});

describe("Revolut corporate actions", () => {
  const text = [
    "26 May 2022 04:18:28 GMT ZNGA Merger - stock  -40.58194566 US$0 US$0 US$0",
    "26 May 2022 04:18:28 GMT TTWO Merger - stock  1.64762699 US$0 US$0 US$0",
    "20 Oct 2022 05:12:52 GMT AVLR Merger - cash US$340.83 US$0 US$0",
    "25 Aug 2022 08:29:11 GMT TSLA Stock split 4.16447036 US$0 US$0 US$0",
    "25 Jun 2023 12:51:25 GMT MSFT Transfer from Revolut Trading Ltd to Revolut Securities Europe 10.66 US$0 US$0 US$0",
  ].join("\n");
  const p = parseRevolutText(text);
  it("merger-stock negative => SELL (remove)", () => {
    expect(p.find((r) => r.ticker === "ZNGA")).toMatchObject({ kind: "TRADE", side: "SELL", shares: 40.58194566, price_usd: 0 });
  });
  it("merger-stock positive => BUY (receive)", () => {
    expect(p.find((r) => r.ticker === "TTWO")).toMatchObject({ kind: "TRADE", side: "BUY", shares: 1.64762699 });
  });
  it("merger-cash => sale proceeds of the old ticker, not a deposit", () => {
    expect(p.find((r) => r.kind === "DEPOSIT")).toBeUndefined();
    expect(p.find((r) => r.external_id.includes(":mergercash:"))).toMatchObject({
      kind: "TRADE", ticker: "AVLR", side: "SELL", shares: 0, price_usd: 340.83,
    });
  });
  it("stock split => BUY at price 0", () => {
    expect(p.find((r) => r.ticker === "TSLA")).toMatchObject({ kind: "TRADE", side: "BUY", shares: 4.16447036, price_usd: 0 });
  });
  it("inter-entity transfer is ignored", () => {
    expect(p.find((r) => r.ticker === "MSFT")).toBeUndefined();
  });
});
