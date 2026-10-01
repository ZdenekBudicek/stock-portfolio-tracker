// Regression: ledgers store AS-TRADED quantities, price series are split-adjusted to today.
// Reconstructing history by multiplying one by the other undervalues every pre-split holding
// by the whole split ratio — GOOGL 0.0041 shares bought at $2,836 on 2022-01-13 priced at
// that day's adjusted close of $138.59 is 1/20 of what was really held.
import { describe, it, expect } from "vitest";
import { applySplitAdjustment, createHoldingsTimeline } from "../../supabase/functions/_shared/history.js";

const ev = (ticker: string, day: string, signed: number, price: number) => ({ ticker, day, signed, price });
/** Split-adjusted closes, as the shared price_history actually stores them. */
const closes: Record<string, Record<string, number>> = {
  GOOGL: { "2022-01-13": 138.587, "2022-08-16": 121.57, "2026-01-02": 300 },
  TSLA: { "2021-02-25": 239.13, "2026-01-02": 400 },
  REV: { "2024-01-10": 50, "2026-01-02": 60 },
};
const closeAt = (t: string, d: string) => closes[t]?.[d] ?? null;

describe("applySplitAdjustment", () => {
  it("scales pre-split trades up to today's terms (GOOGL 20:1)", () => {
    // 0.0041 as traded @ $2,836.71 == 0.082 in today's terms; the later lot is post-split.
    const truth = new Map([["GOOGL", 0.082 + 0.1432]]);
    const r = applySplitAdjustment(
      [ev("GOOGL", "2022-01-13", 0.0041, 2836.71), ev("GOOGL", "2022-08-16", 0.1432, 121.57)],
      closeAt, truth,
    );
    expect(r.adjusted.GOOGL).toBe(20);
    expect(r.trades.find((t) => t.day === "2022-01-13")!.signed).toBeCloseTo(0.082, 6);
    expect(r.trades.find((t) => t.day === "2022-08-16")!.signed).toBeCloseTo(0.1432, 6);
    expect(r.unverified).toEqual([]);
  });

  it("leaves an already-adjusted ledger alone (broker booked the split as extra shares)", () => {
    // Revolut books a split as an explicit "+N shares" row, so the quantities already match
    // the broker. Scaling them again would double-count — the broker check must reject it.
    const truth = new Map([["REV", 10]]);
    const r = applySplitAdjustment([ev("REV", "2024-01-10", 10, 50)], closeAt, truth);
    expect(r.adjusted.REV).toBeUndefined();
    expect(r.trades[0].signed).toBe(10);
  });

  it("does not invent a factor when the trade price matches the close", () => {
    const truth = new Map([["TSLA", 1]]);
    const r = applySplitAdjustment([ev("TSLA", "2021-02-25", 1, 239.13)], closeAt, truth);
    expect(r.adjusted.TSLA).toBeUndefined();
    expect(r.trades[0].signed).toBe(1);
  });

  it("flags a ticker whose ledger cannot be made to match the broker", () => {
    const truth = new Map([["GOOGL", 99]]); // nothing explains 99 shares
    const r = applySplitAdjustment([ev("GOOGL", "2022-08-16", 0.1432, 121.57)], closeAt, truth);
    expect(r.unverified).toContain("GOOGL");
  });

  it("feeds a timeline that ends on the broker's count and holds the right shares mid-history", () => {
    const truth = new Map([["GOOGL", 0.082 + 0.1432]]);
    const { trades } = applySplitAdjustment(
      [ev("GOOGL", "2022-01-13", 0.0041, 2836.71), ev("GOOGL", "2022-08-16", 0.1432, 121.57)],
      closeAt, truth,
    );
    const tl = createHoldingsTimeline(trades, truth);
    expect(tl.advanceTo("2022-01-13").get("GOOGL")).toBeCloseTo(0.082, 6); // not 0.0041
    expect(tl.advanceTo("2026-01-02").get("GOOGL")).toBeCloseTo(0.2252, 6);
  });
});
