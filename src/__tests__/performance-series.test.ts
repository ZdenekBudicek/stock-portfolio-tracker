import { describe, it, expect } from "vitest";
import { buildPerformanceSeries, type SeriesSnapshot } from "@/lib/performanceSeries";
import { dailyReturns } from "@/lib/returns";

const snap = (snapshot_date: string, value_usd: number, fx_rate: number | null, cash_usd: number | null = null): SeriesSnapshot =>
  ({ snapshot_date, value_usd, value_czk: value_usd * (fx_rate ?? 0), fx_rate, cash_usd });

const build = (snapshots: SeriesSnapshot[], currency: "USD" | "CZK", flows: [string, number][] = [], bench: (d: string) => number | null = () => null) =>
  buildPerformanceSeries({ snapshots, tradeFlowsUsd: new Map(flows), benchAt: bench, currency, fallbackFx: 22 });

describe("buildPerformanceSeries", () => {
  it("counts all trades between snapshots once, including the current date", () => {
    const pts = build([
      snap("2026-08-03", 1000, 20), snap("2026-08-06", 2000, 20), snap("2026-08-07", 2000, 20),
    ], "USD", [["2026-08-06", 300], ["2026-08-03", 1000], ["2026-08-04", 800], ["2026-08-05", -100], ["2026-08-10", 900]]);
    expect(pts.map((p) => p.cumDep)).toEqual([1000, 2000, 2000]);
    expect(dailyReturns(pts).map((p) => p.r)).toEqual([0, 0]);
  });

  it("converts each intervening trade at its own rate, falling back to the snapshot", () => {
    const pts = buildPerformanceSeries({
      snapshots: [snap("2026-08-03", 1000, 20), snap("2026-08-06", 2000, 23)],
      tradeFlowsUsd: new Map([["2026-08-03", 1000], ["2026-08-04", 800], ["2026-08-05", -100], ["2026-08-06", 300]]),
      currency: "CZK", fallbackFx: 22, benchAt: () => 100,
      fxAt: (date) => date === "2026-08-04" ? 21 : date === "2026-08-05" ? 22 : null,
    });
    expect(pts[1].cumDep).toBe(20000 + 800 * 21 - 100 * 22 + 300 * 23);
    expect(pts[1].total).toBe(46000);
    expect(pts[1].benchVal).toBe(46000);
  });

  it("offsets gap-day purchases with tracked cash without inventing a deposit", () => {
    const pts = build([snap("2026-08-03", 1000, 20, 1000), snap("2026-08-06", 2000, 20, 0)], "USD", [["2026-08-04", 1000]]);
    expect(pts.map((p) => p.cumDep)).toEqual([1000, 1000]);
    expect(dailyReturns(pts)[0].r).toBe(0);
  });

  it("preserves CZK flow differences even when USD trades net to zero", () => {
    const pts = buildPerformanceSeries({
      snapshots: [snap("2026-08-03", 1000, 20), snap("2026-08-06", 1000, 22)],
      tradeFlowsUsd: new Map([["2026-08-04", 100], ["2026-08-05", -100]]),
      currency: "CZK", fallbackFx: 22, benchAt: () => null,
      fxAt: (date) => date === "2026-08-04" ? 20 : 21,
    });
    expect(pts[1].cumDep).toBe(-100);
  });

  // $1 000 bought at 25 Kč/$, the stock flat, the dollar down to 20 Kč.
  const history = [snap("2025-01-02", 1_000, 25), snap("2026-01-02", 1_000, 20)];
  const flows: [string, number][] = [["2025-01-02", 1_000]];

  it("values each day at its own rate in CZK, so the currency move shows", () => {
    const pts = build(history, "CZK", flows);
    expect(pts.map((p) => p.total)).toEqual([25_000, 20_000]);
    expect(pts[1].cumDep).toBe(25_000);
    expect(pts[1].total - pts[1].cumDep).toBe(-5_000); // a koruna loss, not a flat line
  });

  it("is unchanged in USD", () => {
    const pts = build(history, "USD", flows);
    expect(pts.map((p) => p.total)).toEqual([1_000, 1_000]);
    expect(pts[1].cumDep).toBe(1_000);
  });

  it("adds recorded cash at the day's rate and counts its change as money in", () => {
    const pts = build([snap("2026-08-03", 1_000, 20), snap("2026-08-04", 1_000, 21, 100)], "CZK");
    expect(pts[1].total).toBe(21_000 + 2_100);
    expect(pts[1].cumDep).toBe(2_100);
  });

  it("keeps the last known rate on a day without one", () => {
    const pts = build([snap("2026-08-03", 1_000, 20), { snapshot_date: "2026-08-04", value_usd: 0, value_czk: 0, fx_rate: null, cash_usd: 50 }], "CZK");
    expect(pts[1].total).toBe(50 * 20);
  });

  it("holds the matched S&P in koruny at each day's rate", () => {
    const spx = (d: string) => (d < "2026-01-01" ? 5_000 : 6_000);
    const pts = build(history, "CZK", flows, spx);
    // 0.2 units of the index: $1 200 at the end, at 20 Kč.
    expect(pts[1].benchVal).toBeCloseTo(1_200 * 20, 6);
    expect(build(history, "USD", flows, spx)[1].benchVal).toBeCloseTo(1_200, 6);
  });
});
