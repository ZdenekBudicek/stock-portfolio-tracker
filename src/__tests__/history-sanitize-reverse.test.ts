import { describe, it, expect } from "vitest";
import { applySplitAdjustment, sanitizeSeries } from "../../supabase/functions/_shared/history.js";

describe("applySplitAdjustment — reverse splits", () => {
  it("scales a pre reverse-split holding down (1-for-10), verified against the broker", () => {
    // 100 shares bought at $1; a later 1-for-10 makes the adjusted close $10 on that day.
    const trades = [{ ticker: "XBIO", day: "2023-01-03", signed: 100, price: 1 }];
    const closeAt = () => 10;
    const r = applySplitAdjustment(trades, closeAt, new Map([["XBIO", 10]]));
    expect(r.trades[0].signed).toBeCloseTo(10, 9);
    expect(r.adjusted.XBIO).toBeCloseTo(0.1, 9);
    expect(r.unverified).toEqual([]);
  });
  it("still leaves an unsplit ledger alone", () => {
    const r = applySplitAdjustment([{ ticker: "AAPL", day: "2024-01-02", signed: 5, price: 185 }], () => 184, new Map([["AAPL", 5]]));
    expect(r.trades[0].signed).toBe(5);
    expect(r.adjusted.AAPL).toBeUndefined();
  });
});

describe("sanitizeSeries", () => {
  const m = (pairs: [string, number][]) => new Map(pairs);
  it("drops a one-day spike that comes straight back", () => {
    const out = sanitizeSeries(m([["2024-01-01", 10], ["2024-01-02", 100], ["2024-01-03", 10.5]]));
    expect([...out.keys()]).toEqual(["2024-01-01", "2024-01-03"]);
  });
  it("keeps a real -85 % crash and everything after it (no frozen history)", () => {
    const out = sanitizeSeries(m([["2024-01-01", 10], ["2024-01-02", 1.5], ["2024-01-03", 1.4], ["2024-01-04", 1.6]]));
    expect([...out.values()]).toEqual([10, 1.5, 1.4, 1.6]);
  });
  it("keeps a real 6x rally", () => {
    const out = sanitizeSeries(m([["2024-01-01", 1], ["2024-01-02", 6], ["2024-01-03", 6.2]]));
    expect(out.size).toBe(3);
  });
  it("ignores non-positive closes", () => {
    expect(sanitizeSeries(m([["2024-01-01", 0], ["2024-01-02", 5]])).size).toBe(1);
  });
});

describe("applySplitAdjustment — Codex review cases", () => {
  it("a trailing sell with no close inherits the PREVIOUS factor, not 1", () => {
    // buy 100 @ $1 (adjusted close $10 -> factor 0.1), sell 20 the next day (no close) — both pre-split
    const closes: Record<string, number> = { "2023-01-03": 10 };
    const r = applySplitAdjustment(
      [{ ticker: "XBIO", day: "2023-01-03", signed: 100, price: 1 }, { ticker: "XBIO", day: "2023-01-04", signed: -20, price: 1 }],
      (_t: string, d: string) => closes[d] ?? null, new Map([["XBIO", 8]]),
    );
    expect(r.trades.map((t) => t.signed)).toEqual([10, -2]);
  });
});

describe("applySplitAdjustment — gap after a split (Codex review 5)", () => {
  it("a sell after a reverse split, without a same-day close, is NOT rescaled", () => {
    // buy 100 @ $1 (adjusted close $10 -> 0.1); 1-for-10; sell 5 @ $10 with only a close 2 days earlier
    const closes: Record<string, number> = { "2023-01-03": 10, "2024-06-03": 10 };
    const r = applySplitAdjustment(
      [{ ticker: "XBIO", day: "2023-01-03", signed: 100, price: 1 }, { ticker: "XBIO", day: "2024-06-05", signed: -5, price: 10 }],
      (_t: string, d: string) => closes[d] ?? null, new Map([["XBIO", 5]]),
    );
    expect(r.trades.map((t) => t.signed)).toEqual([10, -5]);
    expect(r.unverified).toEqual([]);
  });
});
