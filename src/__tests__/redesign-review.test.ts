// Regression tests for the Codex review of the V2 redesign.
import { describe, expect, it } from "vitest";
import { baseIndex, chain, dailyReturns, monthlyNetFlows } from "@/lib/returns";
import { dividendForecast, receivedLast12m, remainingThisMonth } from "@/lib/dividendAnalytics";
import { deriveAlerts, normalizeEarningsTime, type AlertInput } from "@/lib/alerts";
import { lotStatuses } from "@/lib/taxLots";
import { runFifo, type FifoTx } from "@/lib/fifo";
import { buildSalesReport, DEFAULT_TAX_SETTINGS } from "@/lib/czTax";
import { simulateSale } from "@/lib/saleSimulation";
import { cnbUsdCzk } from "@/lib/cnbRates";

const p = (date: string, total: number, cumDep: number) => ({ date, total, cumDep });

describe("returns — review fixes", () => {
  it("a first deposit into an empty portfolio is money in", () => {
    const f = monthlyNetFlows([p("2026-03-02", 1000, 1000), p("2026-03-03", 1010, 1000)]);
    expect(f.get("2026-03")).toBe(1000);
  });

  it("% and money of a period start from the same base point", () => {
    const pts = [p("2026-01-01", 1000, 1000), p("2026-01-10", 1100, 1000), p("2026-01-20", 1100, 1000)];
    const idx = baseIndex(pts, "2026-01-05"); // between snapshots → the 1 Jan point
    expect(pts[idx].date).toBe("2026-01-01");
    const twr = chain(dailyReturns(pts).filter((d) => d.date > pts[idx].date).map((d) => d.r));
    const money = (pts[2].total - pts[idx].total) - (pts[2].cumDep - pts[idx].cumDep);
    expect(twr).toBeCloseTo(0.1);
    expect(money).toBe(100);
  });
});

describe("dividendAnalytics — review fixes", () => {
  const today = "2026-10-18";
  it("a projection marked paid after its ex-date still counts until its pay date", () => {
    const divs = [{ ticker: "GOOGL", ex_date: "2026-10-10", pay_date: "2026-10-27", amount_per_share: 0.2, shares_held: 50, total_amount_usd: 10, status: "paid", broker: "auto" }] as import("@/lib/dividendTax").DividendRecord[];
    expect(remainingThisMonth(divs, today).map((i) => i.amountUsd)).toEqual([10]);
  });

  it("nothing held → no projections (an empty set is a filter, not 'no filter')", () => {
    const divs = [{ ticker: "META", ex_date: "2026-12-01", pay_date: "2026-12-20", amount_per_share: 1, shares_held: 10, total_amount_usd: 10, status: "upcoming", broker: "auto" }] as import("@/hooks/useExtras").DbDividendRow[];
    expect(dividendForecast(divs, today, new Set()).every((m) => m.items.length === 0)).toBe(true);
    expect(dividendForecast(divs, today).some((m) => m.items.length === 1)).toBe(true);
  });

  it("this month's payouts of one stock on two brokers merge", () => {
    const divs = [
      { ticker: "META", ex_date: "2026-10-20", pay_date: "2026-10-28", amount_per_share: 1, shares_held: 20, total_amount_usd: 20, status: "upcoming", broker: "auto" },
      { ticker: "META", ex_date: "2026-10-20", pay_date: "2026-10-28", amount_per_share: 1, shares_held: 30, total_amount_usd: 30, status: "upcoming", broker: "auto" },
    ] as import("@/hooks/useExtras").DbDividendRow[];
    expect(remainingThisMonth(divs, today)).toEqual([{ ticker: "META", payDate: "2026-10-28", amountUsd: 50, kind: "estimate" }]);
  });

  it("XTB stores gross: received counts the net amount", () => {
    const divs = [{ ticker: "KO", ex_date: "2026-06-01", pay_date: "2026-06-15", amount_per_share: 1, shares_held: 100, total_amount_usd: 100, status: "paid", broker: "XTB", ext_id: "xtb:div:1" }] as import("@/hooks/useExtras").DbDividendRow[];
    expect(receivedLast12m(divs, today).total).toBeCloseTo(85);
  });
});

describe("taxLots — CZK gain", () => {
  it("is today's value at today's rate minus the cost at the purchase-day rate", () => {
    const d = "2024-03-01";
    const fx = cnbUsdCzk(d)!.rate;
    const tx: FifoTx = { id: "1", ticker: "AAA", side: "BUY", shares: 100, price_usd: 100, executed_at: `${d}T15:00:00Z`, broker: "T212", broker_account: "A" };
    const [l] = lotStatuses(runFifo([tx]).openLots, () => 110, "2026-10-18", { rate: 20, fxAt: (x) => cnbUsdCzk(x)?.rate ?? null });
    expect(l.gainUsd).toBeCloseTo(1000);
    expect(l.gainCzk).toBeCloseTo(11000 * 20 - 10000 * fx); // negative when the koruna strengthened
  });
});

describe("simulateSale — crossing the limit", () => {
  it("taxes the year's earlier sales too, not just this sale", () => {
    const at = (d: string) => `${d}T15:00:00Z`;
    const txs: FifoTx[] = [
      { id: "b1", ticker: "AAA", side: "BUY", shares: 10, price_usd: 100, executed_at: at("2025-06-02"), broker: "T212", broker_account: "A" },
      { id: "s1", ticker: "AAA", side: "SELL", shares: 5, price_usd: 150, executed_at: at("2026-02-02"), broker: "T212", broker_account: "A" },
    ];
    const fifo = runFifo(txs);
    const before = buildSalesReport(fifo.disposals, 2026, DEFAULT_TAX_SETTINGS, fifo.warnings);
    expect(before.underLimit).toBe(true); // 750 $ of proceeds
    expect(before.estTaxCzk).toBe(0);
    const r = simulateSale(txs, before, { ticker: "AAA", broker: "T212", account: "A", shares: 5, priceUsd: 1000, feeUsd: 0, at: at("2026-10-18"), saleFx: 21 }, DEFAULT_TAX_SETTINGS);
    expect(r.underLimitAfter).toBe(false);
    // the earlier sale's gain is now taxable as well
    expect(r.extraTaxCzk!).toBeCloseTo((before.taxable.gainCzk + r.taxableGainCzk!) * 0.15);
    expect(r.extraTaxCzk!).toBeGreaterThan(r.taxableGainCzk! * 0.15);
  });
});

describe("deriveAlerts", () => {
  const base: AlertInput = {
    today: "2026-10-18", positions: [], moveThresholdPct: 7, watch: [], priceOf: () => null, tax: null,
    earnings: [], earningsDaysAhead: 3, held: new Set(), newlyExempt: [], pricesStale: false, pricesError: null,
  };
  it("big moves only with a previous close, above the threshold, ids stable per session", () => {
    const pos = [
      { ticker: "NBIS", name: "Nebius", dailyChangePct: -12.18, dailyChangeUsd: -2569, allocation: 11.2, hasPrevClose: true },
      { ticker: "NU", name: "Nu", dailyChangePct: -1.2, dailyChangeUsd: -179, allocation: 9.3, hasPrevClose: true },
      { ticker: "X", name: "X", dailyChangePct: -20, dailyChangeUsd: -1, allocation: 1, hasPrevClose: false },
    ];
    const a = deriveAlerts({ ...base, positions: pos });
    expect(a.map((x) => x.id)).toEqual(["move:NBIS:2026-10-18"]);
    expect(a[0]).toMatchObject({ code: 'move.down', params: { pct: -12.18, amountUsd: -2569, allocation: 11.2 }, priority: 76.09 });
    expect(a[0]).not.toHaveProperty('title');
    expect(a[0]).not.toHaveProperty('detail');
    expect(deriveAlerts({ ...base, positions: pos })[0].id).toBe(a[0].id);
  });
  it("watch target reached at or below the target", () => {
    const a = deriveAlerts({ ...base, watch: [{ ticker: "CRWV", target_price_usd: 80 }, { ticker: "DELL", target_price_usd: 100 }], priceOf: (t) => (t === "CRWV" ? 61.39 : 150) });
    expect(a.map((x) => x.ticker)).toEqual(["CRWV"]);
    expect(a[0]).toMatchObject({ id: 'watch:CRWV:80', code: 'watch.belowTarget', params: { price: 61.39, target: 80 }, priority: 60 });
    expect(a[0].params.belowPct).toBeCloseTo(23.2625);
  });
  it("earnings only for held stocks within the window", () => {
    const a = deriveAlerts({ ...base, held: new Set(["META"]), earnings: [
      { ticker: "META", earnings_date: "2026-10-21", time_of_day: "AMC" },
      { ticker: "SOFI", earnings_date: "2026-10-20", time_of_day: null },
      { ticker: "META", earnings_date: "2027-01-28", time_of_day: null },
    ] });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: 'earnings:META:2026-10-21', code: 'earnings.soon', params: { date: '2026-10-21', time: 'amc' }, priority: 50 });
  });
  it("tax limit, data problems first", () => {
    const a = deriveAlerts({ ...base, pricesError: "x", tax: { year: 2026, overLimit: true, complete: false, proceedsCzk: 3_000_000, estTaxCzk: 150_000 } });
    expect(a.map((x) => x.kind)).toEqual(["data", "tax-limit"]);
    expect(a[0]).toMatchObject({ code: 'data.pricesError', params: {}, priority: 100 });
    expect(a[1]).toMatchObject({ code: 'tax.limitOver', params: { year: 2026, proceedsCzk: 3_000_000, estTaxCzk: 150_000, complete: false }, priority: 80 });
  });

  it('normalizes earnings codes without display text', () => {
    expect(['AMC', 'amc', 'BMO', 'bmo', 'unknown', '', null, undefined].map(normalizeEarningsTime))
      .toEqual(['amc', 'amc', 'bmo', 'bmo', null, null, null, null]);
  });

  it('preserves raw positive moves and stale-price priority', () => {
    const a = deriveAlerts({ ...base, pricesStale: true, positions: [
      { ticker: 'META', name: 'Meta', dailyChangePct: 7.123, dailyChangeUsd: 2569.12, allocation: 11.234, hasPrevClose: true },
    ] });
    expect(a[0]).toMatchObject({ id: 'data:prices-stale', code: 'data.pricesStale', params: {}, priority: 90 });
    expect(a[1]).toMatchObject({ code: 'move.up', params: { pct: 7.123, amountUsd: 2569.12, allocation: 11.234 } });
    expect(deriveAlerts({ ...base, pricesStale: true, pricesError: 'failure' }).map((x) => x.code)).toEqual(['data.pricesError']);
  });

  it('groups exempt lots and preserves null for unknown values', () => {
    const a = deriveAlerts({ ...base, newlyExempt: [
      { ticker: 'META', exemptFrom: '2026-10-01', valueUsd: 123.45 },
      { ticker: 'META', exemptFrom: '2026-10-04', valueUsd: 10.12 },
      { ticker: 'NU', exemptFrom: '2026-10-02', valueUsd: 10 },
      { ticker: 'NU', exemptFrom: '2026-10-03', valueUsd: null },
    ] });
    expect(a[0]).toMatchObject({ id: 'exempt:META:2026-10-04', code: 'exempt.lots', params: { count: 2, from: '2026-10-04', valueUsd: 133.57 }, priority: 40 });
    expect(a[1].params).toEqual({ count: 2, from: '2026-10-03', valueUsd: null });
  });
});
