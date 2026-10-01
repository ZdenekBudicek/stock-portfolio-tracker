import { describe, it, expect } from "vitest";
import { computeTradeFlows, type DbTransaction } from "@/hooks/usePortfolio";

const tx = (o: Partial<DbTransaction>): DbTransaction =>
  ({ id: Math.random().toString(36), ticker: "NVDA", side: "BUY", shares: 1, price_usd: 100,
     fee_usd: 0, executed_at: "2026-01-15T10:00:00Z", note: null, ...o }) as DbTransaction;

describe("computeTradeFlows", () => {
  it("adds buys and subtracts sells on the trade date", () => {
    const f = computeTradeFlows([
      tx({ shares: 10, price_usd: 100, executed_at: "2026-01-15T10:00:00Z" }),
      tx({ shares: 4, price_usd: 150, side: "SELL", executed_at: "2026-02-20T10:00:00Z" }),
    ]);
    expect(f.get("2026-01-15")).toBeCloseTo(1000, 9);
    expect(f.get("2026-02-20")).toBeCloseTo(-600, 9);
  });

  it("nets several trades on the same day into one entry", () => {
    const f = computeTradeFlows([
      tx({ shares: 2, price_usd: 50 }),
      tx({ ticker: "AMD", shares: 1, price_usd: 30, side: "SELL" }),
    ]);
    expect([...f.keys()]).toEqual(["2026-01-15"]);
    expect(f.get("2026-01-15")).toBeCloseTo(70, 9);
  });

  it("ignores reconciliation and holdings-snapshot rows", () => {
    // `:adj:` corrections and `:pos:` snapshots are bookkeeping, not purchases — counting
    // them as money-in inflates the baseline and understates the return.
    const f = computeTradeFlows([
      tx({ shares: 5, price_usd: 20, ext_id: "t212:adj:1234567:NVDA" }),
      tx({ shares: 5, price_usd: 20, ext_id: "revolut:pos:NVDA" }),
    ]);
    expect(f.size).toBe(0);
  });

  it("ignores CASH movements — they never enter a position", () => {
    const f = computeTradeFlows([tx({ ticker: "CASH", shares: 5000, price_usd: 1 })]);
    expect(f.size).toBe(0);
  });

  it("makes a sale neutral: value out of the positions equals baseline out", () => {
    // The property that stops a sale from reading as a loss. Holdings drop by the proceeds
    // and so does the cumulative baseline, so (Δvalue − Δbaseline) is 0.
    const flows = computeTradeFlows([tx({ shares: 3, price_usd: 200, side: "SELL" })]);
    const proceeds = 3 * 200;
    expect(flows.get("2026-01-15")).toBeCloseTo(-proceeds, 9);
  });
});
