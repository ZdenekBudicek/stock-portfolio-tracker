import { describe, it, expect } from "vitest";
import { computeYearlyGrowth, type GrowthSnapshot } from "@/lib/yearlyGrowth";

const snap = (snapshot_date: string, value_czk: number, fx_rate: number, cash_usd: number | null = null): GrowthSnapshot =>
  ({ snapshot_date, value_czk, fx_rate, cash_usd });

const run = (snapshots: GrowthSnapshot[], opts: Partial<Parameters<typeof computeYearlyGrowth>[0]> = {}) =>
  computeYearlyGrowth({ snapshots, tradeFlowsUsd: new Map(), live: null, goalPct: 20, nowYear: 2026, fallbackFx: 20, ...opts });

const year = (out: ReturnType<typeof computeYearlyGrowth>, y: number) => out.find((d) => d.year === y)!;

describe("computeYearlyGrowth", () => {
  it("ends the current year on the header's value — positions AND cash, at live prices and FX", () => {
    // The stored snapshot is positions only, at the last close. The header shows positions
    // plus the cash balance at live prices — that is the number the card must end on.
    const out = run(
      [snap("2025-12-31", 1_000_000, 20), snap("2026-09-24", 1_470_000, 21, 5_000)],
      { live: { date: "2026-09-25", holdingsUsd: 72_000, cashUsd: 6_000, usdCzk: 21.5 } },
    );
    expect(year(out, 2026).endValueCzk).toBeCloseTo((72_000 + 6_000) * 21.5, 6);
  });

  it("replaces today's stored snapshot with the live value instead of adding a second point", () => {
    const out = run(
      [snap("2025-12-31", 1_000_000, 20), snap("2026-09-25", 1_400_000, 21, 5_000)],
      { live: { date: "2026-09-25", holdingsUsd: 70_000, cashUsd: 6_000, usdCzk: 21 } },
    );
    const y = year(out, 2026);
    expect(y.endValueCzk).toBeCloseTo(76_000 * 21, 6);
    const sept = y.monthly.filter((m) => m.month === 9);
    expect(sept).toHaveLength(1);
    expect(sept[0].totalValueCzk).toBeCloseTo(76_000 * 21, 6);
  });

  it("counts recorded cash in every day's value, not just the live one", () => {
    const out = run([snap("2025-12-31", 400_000, 20), snap("2026-06-30", 300_000, 20, 5_000)]);
    expect(year(out, 2026).endValueCzk).toBe(300_000 + 5_000 * 20);
  });

  it("does not read a sale whose proceeds stay in cash as a loss or as a withdrawal", () => {
    // $20 000 of stock, then $5 000 of it sold and kept as cash. Nothing left the portfolio.
    const out = run(
      [snap("2025-12-31", 400_000, 20, 0), snap("2026-06-30", 300_000, 20, 5_000)],
      { tradeFlowsUsd: new Map([["2026-06-30", -5_000]]) },
    );
    const y = year(out, 2026);
    expect(y.endValueCzk).toBe(400_000);
    expect(y.depositsCzk).toBe(0);
    expect(y.growthCzk).toBe(0);
    expect(y.growthPct).toBe(0);
  });

  it("books the first recorded cash balance as money in, not as market growth", () => {
    // Cash tracking starts mid-year: the value steps up by the balance on that day, and the
    // money-in baseline must step up by the same amount, or the card invents a gain.
    const out = run([snap("2025-12-31", 400_000, 20), snap("2026-08-04", 440_000, 20, 3_000)]);
    const y = year(out, 2026);
    expect(y.endValueCzk).toBe(440_000 + 60_000);
    expect(y.depositsCzk).toBe(60_000);
    expect(y.growthCzk).toBe(40_000);
    expect(y.growthPct).toBeCloseTo((40_000 / 460_000) * 100, 2);
  });

  it("leaves years without any recorded cash on the positions-only value", () => {
    const out = run(
      [snap("2024-01-02", 100_000, 23), snap("2024-12-31", 150_000, 23), snap("2025-12-31", 200_000, 22)],
      { tradeFlowsUsd: new Map([["2025-03-10", 1_000]]) },
    );
    const y24 = year(out, 2024), y25 = year(out, 2025);
    expect(y24.startValueCzk).toBe(100_000);
    expect(y24.endValueCzk).toBe(150_000);
    expect(y25.startValueCzk).toBe(150_000);
    expect(y25.endValueCzk).toBe(200_000);
    expect(y25.depositsCzk).toBe(1_000 * 23); // at the FX of its own day, from the nearest snapshot
    expect(y25.growthCzk).toBe(200_000 - 150_000 - 23_000);
  });

  it("carries the year-end cash into the next year's start value", () => {
    const out = run(
      [snap("2026-12-31", 400_000, 20, 1_000), snap("2027-03-31", 400_000, 20, 1_000)],
      { nowYear: 2027 },
    );
    const y27 = year(out, 2027);
    expect(y27.startValueCzk).toBe(420_000);
    expect(y27.depositsCzk).toBe(0);
    expect(y27.growthCzk).toBe(0);
  });

  it("marks only the current year as running and lists the newest year first", () => {
    const out = run([snap("2025-12-31", 100_000, 20), snap("2026-01-05", 110_000, 20)]);
    expect(out.map((d) => [d.year, d.isCurrent])).toEqual([[2026, true], [2025, false]]);
  });

  it("starts a new year from the live point alone when no snapshot exists for it yet", () => {
    const out = run(
      [snap("2026-12-31", 400_000, 20)],
      { nowYear: 2027, live: { date: "2027-01-01", holdingsUsd: 20_000, cashUsd: 500, usdCzk: 20 } },
    );
    const y27 = year(out, 2027);
    expect(y27.startValueCzk).toBe(400_000);
    expect(y27.endValueCzk).toBe(410_000);
    expect(y27.depositsCzk).toBe(10_000); // first recorded cash
    expect(y27.growthCzk).toBe(0);
  });

  it("returns nothing without history or a live value", () => {
    expect(run([])).toEqual([]);
  });
});
