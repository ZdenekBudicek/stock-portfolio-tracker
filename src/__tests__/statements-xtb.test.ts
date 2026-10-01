import { describe, it, expect } from "vitest";
import { excelDateToISO, stripSuffix, parseXtbTradeComment, parseXtbSplitComment, parseXtbRows, parseXtbHoldings } from "../lib/statements";

describe("parseXtbHoldings (bought - closed)", () => {
  const cash: any[][] = [
    ["Type", "Ticker", "Instrument", "Time", "Amount", "ID", "Comment", "Product"],
    ["Stock purchase", "AMD.US", "AMD", 45750, -85.92, "1", "OPEN BUY 0.8956 @ 95.94", "x"],
    ["Stock purchase", "ASML.US", "ASML", 45698, -99.57, "2", "OPEN BUY 0.135 @ 737.57", "x"],
    ["Stock purchase", "LRCX.US", "LRCX", 45698, -114.0, "3", "OPEN BUY 0.1144 @ 996.30", "x"],
  ];
  const closed: any[][] = [
    ["Instrument", "Category", "Ticker", "Type", "Volume", "Open Price"],
    ["ASML", "STOCK", "ASML.US", "BUY", 0.135, 737.57],
    ["LRCX", "STOCK", "LRCX.US", "BUY", 0.1144, 996.30],
  ];
  const h = parseXtbHoldings(cash, closed);
  it("keeps only positions not fully closed", () => {
    expect(h.map((x) => x.ticker).sort()).toEqual(["AMD"]);
    expect(h[0]).toMatchObject({ kind: "HOLDING", ticker: "AMD", shares: 0.8956, broker: "XTB", external_id: "xtb:pos:AMD" });
  });
});

describe("helpers", () => {
  it("excelDateToISO converts serial to UTC ISO", () => {
    // 45750.72286606482 ~ 2025-... ; check a known value: 44000 -> 2020-06-18
    expect(excelDateToISO(44000).slice(0, 10)).toBe("2020-06-18");
  });
  it("stripSuffix removes .US", () => {
    expect(stripSuffix("AMD.US")).toBe("AMD");
    expect(stripSuffix("ASML.US")).toBe("ASML");
  });
  it("parseXtbTradeComment handles plain and partial-fill forms", () => {
    expect(parseXtbTradeComment("OPEN BUY 0.8956 @ 95.94")).toEqual({ shares: 0.8956, price: 95.94 });
    expect(parseXtbTradeComment("OPEN BUY 3/3.2405 @ 234.15")).toEqual({ shares: 3, price: 234.15 });
    expect(parseXtbTradeComment("CLOSE BUY 0.135 @ 633.10")).toEqual({ shares: 0.135, price: 633.1 });
  });
  it("parseXtbSplitComment computes ratio", () => {
    expect(parseXtbSplitComment("LRCX.US split 10 for 1")).toBe(10);
  });
});

describe("parseXtbRows", () => {
  const rows: any[][] = [
    ["Account number", "7654321"],
    ["Cash Operations", ""],
    ["Date from (UTC)", 38718],
    ["Date to (UTC)", 46197],
    ["Type", "Ticker", "Instrument", "Time", "Amount", "ID", "Comment", "Product"],
    ["Stock purchase", "AMD.US", "AMD", 45750.72, -85.92, "700000001", "OPEN BUY 0.8956 @ 95.94", "My Trades"],
    ["Stock sell", "ASML.US", "ASML", 45750.72, 85.47, "700000002", "CLOSE BUY 0.135 @ 633.10", "My Trades"],
    ["Deposit", "", "", 45000, 107.89, "12602214", "PayPal deposit", "x"],
    ["Dividend", "ASML.US", "ASML", 45000, 0.21, "d1", "ASML.US USD 1.5855/ SHR", "x"],
    ["Fractional shares", "LRCX.US", "LRCX", 45000, 93.13, "s1", "LRCX.US split 10 for 1", "x"],
    ["Withholding tax", "ASML.US", "ASML", 45000, -0.03, "w1", "ASML.US USD WHT 15%", "x"],
    ["Total", "", "", "", 0.02],
  ];
  const parsed = parseXtbRows(rows);

  it("parses a buy trade", () => {
    const t = parsed.find((p) => p.external_id === "700000001")!;
    expect(t).toMatchObject({ kind: "TRADE", side: "BUY", ticker: "AMD", shares: 0.8956, price_usd: 95.94, broker: "XTB" });
  });
  it("parses a sell trade", () => {
    expect(parsed.find((p) => p.external_id === "700000002")).toMatchObject({ kind: "TRADE", side: "SELL", ticker: "ASML" });
  });
  it("parses deposit, dividend, split, fee", () => {
    expect(parsed.find((p) => p.external_id === "12602214")).toMatchObject({ kind: "DEPOSIT", amount_usd: 107.89 });
    expect(parsed.find((p) => p.external_id === "d1")).toMatchObject({ kind: "DIVIDEND", ticker: "ASML", amount_usd: 0.21 });
    expect(parsed.find((p) => p.external_id === "s1")).toMatchObject({ kind: "SPLIT", ratio: 10 });
    expect(parsed.find((p) => p.external_id === "w1")).toMatchObject({ kind: "FEE" });
  });
  it("skips the Total row", () => {
    expect(parsed.some((p) => p.label.includes("Total"))).toBe(false);
  });
});
