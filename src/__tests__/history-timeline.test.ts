import { describe, it, expect } from "vitest";
// Plain-ESM shared module: the nightly price worker (Node), the backfill edge function
// (Deno) and these tests all run this exact file.
import { createHoldingsTimeline, eachDay } from "../../supabase/functions/_shared/history.js";

const ev = (ticker: string, day: string, signed: number) => ({ ticker, day, signed });

/** Convenience: walk the timeline and read one ticker's share count on each day. */
const series = (tl: any, ticker: string, days: string[]) =>
  days.map((d) => tl.advanceTo(d).get(ticker) ?? 0);

describe("createHoldingsTimeline", () => {
  it("replays the ledger exactly when broker and ledger agree", () => {
    const tl = createHoldingsTimeline(
      [ev("NVDA", "2025-01-10", 10), ev("NVDA", "2025-03-05", 5)],
      new Map([["NVDA", 15]]),
    );
    expect(series(tl, "NVDA", ["2025-01-09", "2025-01-10", "2025-02-01", "2025-03-05", "2025-06-01"]))
      .toEqual([0, 10, 10, 15, 15]);
    expect(tl.clamped).toBe(0);
  });

  it("ends exactly on the broker's share count (no cliff at today)", () => {
    // The broker says 8, the ledger's raw net says 10 — a double-imported buy.
    const tl = createHoldingsTimeline(
      [ev("RKLB", "2024-02-01", 6), ev("RKLB", "2024-02-01", 4)],
      new Map([["RKLB", 8]]),
    );
    expect(tl.advanceTo("2026-08-03").get("RKLB")).toBe(8);
  });

  it("never scales a past holding: a small correction stays a small correction", () => {
    // The regression that put money in the chart the user never had. Bought 1000, sold 990,
    // holds 10; the broker says 12. The old code multiplied the WHOLE history by 12/10, so
    // the 1000-share period showed 1200 shares — hundreds of phantom dollars per share.
    const tl = createHoldingsTimeline(
      [ev("X", "2022-01-03", 1000), ev("X", "2025-06-01", -990)],
      new Map([["X", 12]]),
    );
    const [beforeBuy, whileLarge, afterSell] = series(tl, "X", ["2022-01-02", "2023-01-01", "2026-01-01"]);
    expect(beforeBuy).toBe(0);
    expect(whileLarge).toBe(1002); // 1000 held + the 2-share offset, NOT 1200
    expect(afterSell).toBe(12);
  });

  it("subtracts the offset when the broker holds FEWER shares than the ledger", () => {
    // The shape that inflated this portfolio's chart: reconciliation removed shares, but
    // the reconstruction ignored the reconciliation row and kept the ledger's count.
    const tl = createHoldingsTimeline(
      [ev("NU", "2023-05-01", 900), ev("NU", "2024-01-01", 110)],
      new Map([["NU", 100]]), // broker truth: 100, ledger net: 1010
    );
    expect(series(tl, "NU", ["2023-06-01", "2024-06-01"])).toEqual([0, 100]);
    expect(tl.clamped).toBeGreaterThan(0); // flagged: ledger and broker disagree badly
  });

  it("keeps a closed position visible while it was held, then drops to zero", () => {
    const tl = createHoldingsTimeline(
      [ev("LRCX", "2023-01-05", 20), ev("LRCX", "2024-07-01", -20)],
      new Map(), // no position row any more — fully closed
    );
    expect(series(tl, "LRCX", ["2023-01-04", "2023-06-01", "2024-07-01", "2025-01-01"]))
      .toEqual([0, 20, 0, 0]);
  });

  it("erases a ghost the broker does not hold instead of showing negative shares", () => {
    const tl = createHoldingsTimeline([ev("GHOST", "2024-01-01", 50)], new Map());
    expect(series(tl, "GHOST", ["2024-01-01", "2025-01-01"])).toEqual([0, 0]);
  });

  it("places a holding with no trades from its declared start date", () => {
    // Revolut "Portfolio breakdown" imports arrive as a `:pos:` snapshot, not as trades.
    const tl = createHoldingsTimeline([], new Map([["VUSA", 30]]), new Map([["VUSA", "2025-04-01"]]));
    expect(series(tl, "VUSA", ["2025-03-31", "2025-04-01", "2026-01-01"])).toEqual([0, 30, 30]);
    expect(tl.unknownStart).toEqual([]);
  });

  it("reports holdings it cannot date instead of silently spreading them over all history", () => {
    const tl = createHoldingsTimeline([], new Map([["MYSTERY", 5]]));
    expect(tl.advanceTo("2026-08-03").get("MYSTERY")).toBe(0);
    expect(tl.unknownStart).toEqual(["MYSTERY"]);
  });
});

describe("eachDay", () => {
  it("is inclusive on both ends and immune to DST", () => {
    const days = eachDay("2026-03-27", Date.parse("2026-03-31"));
    expect(days).toEqual(["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
  });
});
