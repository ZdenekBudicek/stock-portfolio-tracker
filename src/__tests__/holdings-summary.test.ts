import { describe, it, expect } from "vitest";
import { summarizeHoldings, type LivePosition } from "@/hooks/usePortfolio";

const pos = (o: Partial<LivePosition>): LivePosition => ({
  ticker: "AAPL", name: "", type: "Stock", shares: 1, avgPrice: 0, currentPrice: 0,
  invested: 0, value: 0, profitUsd: 0, profitPct: 0,
  avgPriceCzk: 0, investedCzk: 0, valueCzk: 0, profitCzk: 0, profitPctCzk: 0,
  dailyChangeUsd: 0, dailyChangePct: 0, allocation: 0, ...o,
});

describe("summarizeHoldings", () => {
  it("keeps cash out of Investováno and the unrealized %", () => {
    const h = summarizeHoldings([
      pos({ ticker: "AAPL", invested: 1_000, value: 1_500, investedCzk: 25_000, valueCzk: 33_000 }),
      pos({ ticker: "CASH", type: "Cash", invested: 500, value: 500, investedCzk: 11_000, valueCzk: 11_000 }),
    ]);
    expect(h.invested).toBe(1_000);
    expect(h.profit).toBe(500);
    expect(h.profitPct).toBe(50); // with cash in the base it read 33,3 %
    expect(h.investedCzk).toBe(25_000);
    expect(h.profitCzk).toBe(8_000);
    expect(h.profitPctCzk).toBe(32); // koruna return, including the currency move
  });

  it("is zero, not NaN, without positions", () => {
    expect(summarizeHoldings([]).profitPct).toBe(0);
  });
});
