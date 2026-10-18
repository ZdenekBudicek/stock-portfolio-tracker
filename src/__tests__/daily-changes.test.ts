import { describe, it, expect } from "vitest";
import { computeDailyChanges, monthlyGrowthNetOfFlows } from "@/lib/dailyChanges";

const snap = (snapshot_date: string, value_usd: number, fx_rate = 20) => ({ snapshot_date, value_usd, value_czk: value_usd * fx_rate, fx_rate });

describe("computeDailyChanges", () => {
  it("does not show a purchase as the day's gain", () => {
    // $10 000 of positions, $2 000 more bought, the market up $100.
    const rows = computeDailyChanges([snap("2026-10-14", 10_000), snap("2026-10-15", 12_100)], new Map([["2026-10-15", 2_000]]));
    expect(rows[1].dayUsd).toBe(100);
    expect(rows[1].dayCzk).toBe(2_000);
    expect(rows[1].dayPct).toBeCloseTo((100 / 12_000) * 100, 6);
  });

  it("does not show a sale as the day's loss", () => {
    const rows = computeDailyChanges([snap("2026-10-14", 10_000), snap("2026-10-15", 5_000)], new Map([["2026-10-15", -5_000]]));
    expect(rows[1].dayUsd).toBe(0);
    expect(rows[1].dayPct).toBe(0);
  });

  it("keeps the plain market move on days without trades, in CZK including the rate change", () => {
    const rows = computeDailyChanges([snap("2026-10-15", 10_000, 20), snap("2026-10-14", 9_900, 21)], new Map());
    expect(rows.map((r) => r.snapshot_date)).toEqual(["2026-10-14", "2026-10-15"]);
    expect(rows[0].dayUsd).toBe(0);
    expect(rows[1].dayUsd).toBe(100);
    expect(rows[1].dayCzk).toBe(200_000 - 207_900);
    expect(rows[1].dayPct).toBeCloseTo((100 / 9_900) * 100, 6);
  });
});

describe("monthlyGrowthNetOfFlows", () => {
  it("does not count money put in as growth", () => {
    // Value doubles over 30 days only because $10 000 more was bought — the market is flat.
    const snaps = [snap("2026-09-01", 10_000), snap("2026-09-15", 20_000), snap("2026-10-01", 20_000)];
    expect(monthlyGrowthNetOfFlows(snaps, new Map([["2026-09-15", 10_000]]))).toBeCloseTo(0, 10);
  });

  it("compounds the market return over the real calendar span", () => {
    // +10 % in 60 days → (1.1)^(1/2) − 1 per 30 days.
    const snaps = [snap("2026-08-02", 10_000), snap("2026-10-01", 11_000)];
    expect(monthlyGrowthNetOfFlows(snaps, new Map())).toBeCloseTo(Math.sqrt(1.1) - 1, 10);
  });
});
