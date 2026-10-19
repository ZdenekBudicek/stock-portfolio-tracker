import { describe, it, expect } from "vitest";
import { isValidQuickTrade } from "@/components/QuickTradeDialog";

describe("isValidQuickTrade", () => {
  it("accepts a positive quantity and price with a non-negative fee", () => {
    expect(isValidQuickTrade("AAPL", 1.5, 190.2, 0)).toBe(true);
    expect(isValidQuickTrade("AAPL", 0.0001, 1, 1)).toBe(true);
  });
  it("rejects negative, zero and non-finite quantity / price, a negative fee, and an empty ticker", () => {
    expect(isValidQuickTrade("AAPL", -5, 100, 0)).toBe(false);
    expect(isValidQuickTrade("AAPL", 5, -100, 0)).toBe(false);
    expect(isValidQuickTrade("AAPL", 0, 100, 0)).toBe(false);
    expect(isValidQuickTrade("AAPL", 5, 0, 0)).toBe(false);
    expect(isValidQuickTrade("AAPL", Infinity, 100, 0)).toBe(false);
    expect(isValidQuickTrade("AAPL", 5, NaN, 0)).toBe(false);
    expect(isValidQuickTrade("AAPL", 5, 100, -1)).toBe(false);
    expect(isValidQuickTrade("  ", 5, 100, 0)).toBe(false);
  });
});
