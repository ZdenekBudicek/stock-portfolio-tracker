import { describe, it, expect } from "vitest";
import { computeHoldingCostFifo, type DbTransaction } from "@/hooks/usePortfolio";

const tx = (o: Partial<DbTransaction> & Record<string, unknown>): DbTransaction =>
  ({ id: Math.random().toString(36), ticker: "RKLB", side: "BUY", shares: 1, price_usd: 10,
     fee_usd: 0, executed_at: "2025-01-01T00:00:00Z", note: null, ...o }) as DbTransaction;

describe("computeHoldingCostFifo", () => {
  it("blends the same ticker held at several brokers instead of taking one broker's cost", () => {
    // The exact shape that made RKLB wrong: a big cheap Revolut lot plus a tiny expensive
    // Trading 212 leftover. The combined average must be the weighted blend of BOTH.
    const f = computeHoldingCostFifo([
      tx({ broker: "Revolut", broker_account: "12345678", shares: 59.95612322, price_usd: 40 }),
      tx({ broker: "T212", broker_account: "1234567", shares: 1.47496766, price_usd: 70.19 }),
    ]);
    const r = f.get("RKLB")!;
    expect(r.shares).toBeCloseTo(61.43109088, 6);
    expect(r.cost / r.shares).toBeCloseTo((59.95612322 * 40 + 1.47496766 * 70.19) / 61.43109088, 6);
  });

  it("keeps two accounts of the SAME broker apart when matching sells to lots", () => {
    // A sell on account A must consume account A's lot, not the cheaper lot of account B.
    const f = computeHoldingCostFifo([
      tx({ ticker: "NU", broker: "T212", broker_account: "1234567", shares: 10, price_usd: 5, executed_at: "2025-01-01T00:00:00Z" }),
      tx({ ticker: "NU", broker: "T212", broker_account: "5088414", shares: 10, price_usd: 15, executed_at: "2025-02-01T00:00:00Z" }),
      tx({ ticker: "NU", broker: "T212", broker_account: "5088414", side: "SELL", shares: 10, price_usd: 20, executed_at: "2025-03-01T00:00:00Z" }),
    ]);
    const r = f.get("NU")!;
    expect(r.shares).toBeCloseTo(10, 9);
    expect(r.cost / r.shares).toBeCloseTo(5, 9); // the $5 lot survives, not a mixed average
  });

  it("counts reconciliation rows so cost and quantity describe the same shares", () => {
    // `positions.shares` includes :adj: rows. If the cost basis skipped them, "investováno"
    // was computed from a different share count than the one displayed next to it.
    const f = computeHoldingCostFifo([
      tx({ ticker: "GOOGL", broker: "T212", broker_account: "1234567", shares: 29.32, price_usd: 150 }),
      tx({ ticker: "GOOGL", broker: "T212", broker_account: "1234567", shares: 0.72, price_usd: 154.26,
           ext_id: "t212:adj:1234567:GOOGL", executed_at: "2026-06-25T00:00:00Z" }),
    ]);
    const r = f.get("GOOGL")!;
    expect(r.shares).toBeCloseTo(30.04, 6);
    expect(r.cost).toBeCloseTo(29.32 * 150 + 0.72 * 154.26, 4);
  });

  it("falls back to the ext_id prefix when the broker column is missing (legacy rows)", () => {
    const f = computeHoldingCostFifo([
      tx({ ticker: "AMD", broker: undefined, ext_id: "xtb:ord:1", shares: 2, price_usd: 100 }),
      tx({ ticker: "AMD", broker: undefined, ext_id: "revolut:trade:1", shares: 2, price_usd: 200 }),
    ]);
    const r = f.get("AMD")!;
    expect(r.shares).toBeCloseTo(4, 9);
    expect(r.cost / r.shares).toBeCloseTo(150, 9);
  });
});
