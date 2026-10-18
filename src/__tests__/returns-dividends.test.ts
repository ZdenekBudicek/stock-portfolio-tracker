import { describe, expect, it } from "vitest";
import { chain, dailyReturns, monthlyNetFlows, monthlyReturns, twrBetween, yearlyReturns } from "@/lib/returns";
import { annualByTicker, dividendForecast, receivedLast12m, remainingThisMonth } from "@/lib/dividendAnalytics";

const p = (date: string, total: number, cumDep: number) => ({ date, total, cumDep });

describe("returns (TWR)", () => {
  it("a deposit at flat prices is 0 %", () => {
    const r = dailyReturns([p("2026-01-01", 100, 100), p("2026-01-02", 150, 150)]);
    expect(r[0].r).toBeCloseTo(0);
    expect(r[0].flow).toBe(50);
  });

  it("chains geometrically and ignores the size of later deposits", () => {
    const pts = [p("2026-01-01", 100, 100), p("2026-01-02", 110, 100), p("2026-01-03", 1110, 1100), p("2026-01-04", 1221, 1100)];
    expect(twrBetween(pts, "2026-01-01", "2026-01-04")).toBeCloseTo(1.1 * 1.1 - 1);
  });

  it("a withdrawal is not a loss", () => {
    const r = dailyReturns([p("2026-01-01", 1000, 1000), p("2026-01-02", 500, 500)]);
    expect(r[0].r).toBeCloseTo(0);
  });

  it("skips days without a base value instead of −100 %", () => {
    expect(dailyReturns([p("2026-01-01", 0, 0), p("2026-01-02", 100, 100)])).toHaveLength(0);
  });

  it("months chain from the previous close; a year is the product of its months", () => {
    const pts = [p("2025-12-31", 100, 100), p("2026-01-15", 110, 100), p("2026-01-31", 121, 100), p("2026-02-28", 108.9, 100)];
    const months = monthlyReturns(pts);
    expect(months.map((m) => m.key)).toEqual(["2026-01", "2026-02"]);
    expect(months[0].r).toBeCloseTo(0.21);
    expect(months[1].r).toBeCloseTo(-0.1);
    expect(months[0].partial).toBe(false);
    const year = yearlyReturns(months)[0];
    expect(year.r).toBeCloseTo(chain([0.21, -0.1]));
    expect(year.partial).toBe(true); // only 2 of 12 months
  });

  it("an unfinished last month is partial", () => {
    const m = monthlyReturns([p("2026-09-30", 100, 100), p("2026-10-16", 105, 100)]);
    expect(m[0]).toMatchObject({ key: "2026-10", partial: true });
  });

  it("net flows per month", () => {
    const f = monthlyNetFlows([p("2026-01-01", 100, 100), p("2026-01-05", 200, 200), p("2026-02-02", 150, 150)]);
    expect(f.get("2026-01")).toBe(200); // the first deposit (100) counts too
    expect(f.get("2026-02")).toBe(-50);
  });
});

describe("dividendAnalytics", () => {
  const today = "2026-10-18";
  const divs: any[] = [
    { ticker: "META", ex_date: "2026-12-14", pay_date: "2026-12-26", amount_per_share: 0.6, shares_held: 50, total_amount_usd: 30, status: "upcoming", broker: "auto" },
    { ticker: "META", ex_date: "2026-12-14", pay_date: "2026-12-26", amount_per_share: 0.6, shares_held: 10, total_amount_usd: 6, status: "upcoming", broker: "auto" },
    { ticker: "GOOGL", ex_date: "2026-12-08", pay_date: null, amount_per_share: 0.2, shares_held: 40, total_amount_usd: 8, status: "upcoming", broker: "manual" },
    { ticker: "GOOGL", ex_date: "2026-10-20", pay_date: "2026-10-27", amount_per_share: 0.2, shares_held: 40, total_amount_usd: 8, status: "upcoming", broker: "auto" },
    { ticker: "OLD", ex_date: "2028-01-01", pay_date: null, amount_per_share: 1, shares_held: 1, total_amount_usd: 1, status: "upcoming", broker: "auto" },
    { ticker: "MSFT", ex_date: "2026-03-01", pay_date: "2026-03-12", amount_per_share: 0.8, shares_held: 50, total_amount_usd: 34, status: "paid", broker: "T212", ext_id: "t212:div:1" },
    { ticker: "META", ex_date: "2026-06-01", pay_date: "2026-06-26", amount_per_share: 0.5, shares_held: 60, total_amount_usd: 30, status: "paid", broker: "auto" },
    { ticker: "META", ex_date: "2025-06-01", pay_date: "2025-06-26", amount_per_share: 0.5, shares_held: 60, total_amount_usd: 30, status: "paid", broker: "T212", ext_id: "t212:div:0" },
  ];

  it("groups the next 12 months by payment date and merges brokers", () => {
    const f = dividendForecast(divs, today);
    expect(f).toHaveLength(12);
    expect(f[0].month).toBe("2026-11");
    const dec = f.find((m) => m.month === "2026-12")!;
    expect(dec.amountUsd).toBe(44);
    expect(dec.items.map((i) => [i.ticker, i.amountUsd, i.kind])).toEqual([["GOOGL", 8, "declared"], ["META", 36, "estimate"]]);
    expect(dec.declared).toBe(false);
    expect(f.every((m) => !m.items.some((i) => i.ticker === "OLD"))).toBe(true);
  });

  it("this month's remaining payout is separate", () => {
    expect(remainingThisMonth(divs, today).map((i) => i.payDate)).toEqual(["2026-10-27"]);
  });

  it("received counts only recorded payouts, sold stocks included", () => {
    const r = receivedLast12m(divs, today);
    expect(r.byTicker).toEqual([{ ticker: "MSFT", amountUsd: 34 }]);
  });

  it("annual income per ticker", () => {
    const a = annualByTicker(dividendForecast(divs, today), remainingThisMonth(divs, today));
    expect(a.get("META")).toBe(36);
    expect(a.get("GOOGL")).toBe(16);
  });
});

import { squarify } from "@/lib/treemap";
describe("squarify", () => {
  it("tile areas are proportional to values and fill the box", () => {
    const vals = [30.6, 14.3, 14.0, 12.0, 11.2, 9.3, 8.5];
    const r = squarify(vals, (v) => v, 200, 100);
    expect(r).toHaveLength(7);
    const total = vals.reduce((a, b) => a + b, 0);
    for (const t of r) expect((t.w * t.h) / 20000).toBeCloseTo(t.item / total, 6);
    for (const t of r) { expect(t.x + t.w).toBeLessThanOrEqual(200 + 1e-6); expect(t.y + t.h).toBeLessThanOrEqual(100 + 1e-6); }
  });
  it("ignores zero and negative values", () => {
    expect(squarify([0, -1, 5], (v) => v, 10, 10)).toHaveLength(1);
  });
});
