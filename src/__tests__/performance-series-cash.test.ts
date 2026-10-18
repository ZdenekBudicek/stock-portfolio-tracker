import { describe, it, expect } from "vitest";
import { buildPerformanceSeries } from "@/lib/performanceSeries";

describe("buildPerformanceSeries — missed cash day", () => {
  it("does not dip or book a withdrawal when one day has no recorded cash", () => {
    const snaps = [
      { snapshot_date: "2026-08-04", value_usd: 1000, value_czk: 20000, fx_rate: 20, cash_usd: 500 },
      { snapshot_date: "2026-08-05", value_usd: 1000, value_czk: 20000, fx_rate: 20, cash_usd: null },
      { snapshot_date: "2026-08-06", value_usd: 1000, value_czk: 20000, fx_rate: 20, cash_usd: 500 },
    ];
    const pts = buildPerformanceSeries({ snapshots: snaps, tradeFlowsUsd: new Map(), benchAt: () => null, currency: "USD", fallbackFx: 20 });
    expect(pts.map((p) => p.total)).toEqual([1500, 1500, 1500]);
    expect(pts.map((p) => p.cumDep)).toEqual([500, 500, 500]);
  });
  it("still treats days before tracking began as no cash", () => {
    const snaps = [
      { snapshot_date: "2026-08-01", value_usd: 1000, value_czk: 20000, fx_rate: 20, cash_usd: null },
      { snapshot_date: "2026-08-04", value_usd: 1000, value_czk: 20000, fx_rate: 20, cash_usd: 500 },
    ];
    const pts = buildPerformanceSeries({ snapshots: snaps, tradeFlowsUsd: new Map(), benchAt: () => null, currency: "USD", fallbackFx: 20 });
    expect(pts.map((p) => p.total)).toEqual([1000, 1500]);
  });
});

describe("buildPerformanceSeries — dividends are return, not deposits", () => {
  it("a dividend credited to cash raises the value without adding to money put in", () => {
    const snaps = [
      { snapshot_date: "2026-01-01", value_usd: 1990, value_czk: 0, cash_usd: 10 },
      { snapshot_date: "2026-01-02", value_usd: 1990, value_czk: 0, cash_usd: 20 },
    ];
    const pts = buildPerformanceSeries({ snapshots: snaps, tradeFlowsUsd: new Map(), incomeUsd: new Map([["2026-01-02", 10]]), benchAt: () => null, currency: "USD", fallbackFx: 20 });
    expect(pts[1].total - pts[0].total).toBe(10);
    expect(pts[1].cumDep - pts[0].cumDep).toBe(0);
  });
});
