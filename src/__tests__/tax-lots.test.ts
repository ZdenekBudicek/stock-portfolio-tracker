import { describe, expect, it } from "vitest";
import { runFifo, type FifoTx } from "@/lib/fifo";
import { exemptionCalendar, exemptSummary, lotStatuses, nextExemptionOf } from "@/lib/taxLots";
import { buildSalesReport, DEFAULT_TAX_SETTINGS } from "@/lib/czTax";
import { simulateSale } from "@/lib/saleSimulation";
import { cnbUsdCzk } from "@/lib/cnbRates";

const buy = (id: string, ticker: string, at: string, shares: number, price: number, fee = 0): FifoTx => ({
  id, ticker, side: "BUY", shares, price_usd: price, fee_usd: fee, executed_at: `${at}T15:00:00Z`, broker: "T212", broker_account: "A",
});
const sell = (id: string, ticker: string, at: string, shares: number, price: number): FifoTx => ({
  id, ticker, side: "SELL", shares, price_usd: price, executed_at: `${at}T15:00:00Z`, broker: "T212", broker_account: "A",
});

const TODAY = "2026-10-18";
const prices: Record<string, number> = { AAA: 20, BBB: 5 };
const priceOf = (t: string) => prices[t] ?? null;

describe("taxLots", () => {
  const txs = [
    buy("1", "AAA", "2022-05-10", 10, 10, 1),   // exempt since 2025-05-11
    buy("2", "AAA", "2024-03-01", 5, 12),       // exempt from 2027-03-02
    buy("3", "BBB", "2024-03-20", 100, 8),      // exempt from 2027-03-21, at a loss
    buy("4", "BBB", "2025-01-15", 10, 4),       // exempt from 2028-01-16
  ];
  const lots = lotStatuses(runFifo(txs).openLots, priceOf, TODAY);

  it("marks the time test per lot, the day after 3 years", () => {
    const a = lots.filter((l) => l.ticker === "AAA");
    expect(a.map((l) => [l.exemptFrom, l.exempt])).toEqual([["2025-05-11", true], ["2027-03-02", false]]);
    expect(a[0].costUsd).toBeCloseTo(101); // fee included
    expect(a[0].gainUsd).toBeCloseTo(99);
    expect(a[1].remainingDays).toBe(135);
  });

  it("groups the not-yet-exempt lots by month, soonest first, with values at today's price", () => {
    const cal = exemptionCalendar(lots);
    expect(cal.map((m) => m.month)).toEqual(["2027-03", "2028-01"]);
    expect(cal[0].tickers).toEqual(["AAA", "BBB"]);
    expect(cal[0].firstDate).toBe("2027-03-02");
    expect(cal[0].valueUsd).toBeCloseTo(5 * 20 + 100 * 5);
    expect(cal[0].gainUsd).toBeCloseTo(100 - 60 + 500 - 800);
  });

  it("a missing price makes the month's value unknown, not zero", () => {
    const noPrice = lotStatuses(runFifo(txs).openLots, (t) => (t === "BBB" ? null : priceOf(t)), TODAY);
    const cal = exemptionCalendar(noPrice);
    expect(cal[0].valueUsd).toBeNull();
    expect(cal[1].gainUsd).toBeNull();
  });

  it("summarises the exempt part and the next exemption", () => {
    const s = exemptSummary(lots);
    expect(s.exemptLots).toBe(1);
    expect(s.exemptValueUsd).toBeCloseTo(200);
    expect(s.exemptShareByTicker.get("AAA")).toBeCloseTo(10 / 15);
    expect(s.exemptShareByTicker.get("BBB")).toBe(0);
    expect(s.nextExemptFrom).toBe("2027-03-02");
    expect(nextExemptionOf(lots, "BBB")).toBe("2027-03-21");
  });

  it("partially sold lots keep their own date", () => {
    const l = lotStatuses(runFifo([...txs, sell("5", "AAA", "2026-01-05", 12, 15)]).openLots, priceOf, TODAY);
    const a = l.filter((x) => x.ticker === "AAA");
    expect(a).toHaveLength(1);
    expect(a[0].shares).toBeCloseTo(3);
    expect(a[0].exemptFrom).toBe("2027-03-02");
  });
});

describe("simulateSale", () => {
  const settings = DEFAULT_TAX_SETTINGS;
  // Purchases on days with a ČNB rate in the bundled table.
  const d1 = "2022-05-10", d2 = "2024-03-01";
  const fx1 = cnbUsdCzk(d1)!.rate, fx2 = cnbUsdCzk(d2)!.rate;
  const txs = [buy("1", "AAA", d1, 10, 10), buy("2", "AAA", d2, 10, 100)];
  const fifo = runFifo(txs);
  const before = buildSalesReport(fifo.disposals, 2026, settings, fifo.warnings);
  const base = { ticker: "AAA", broker: "T212", account: "A", priceUsd: 200, feeUsd: 0, at: "2026-10-18T12:00:00Z", saleFx: 21 };

  it("consumes the oldest lot first; an exempt lot adds no tax", () => {
    const r = simulateSale(txs, before, { ...base, shares: 10 }, settings);
    expect(r.pieces).toHaveLength(1);
    expect(r.pieces[0].exempt).toBe(true);
    expect(r.taxableGainCzk).toBeCloseTo(0);
    expect(r.extraTaxCzk).toBe(0);
    expect(r.gainCzk).toBeCloseTo(2000 * 21 - 100 * fx1);
  });

  it("a taxable piece over the limit adds 15 % of its CZK gain", () => {
    const r = simulateSale(txs, before, { ...base, shares: 20, priceUsd: 300 }, settings);
    expect(r.pieces.map((p) => p.exempt)).toEqual([true, false]);
    // limit base counts the exempt proceeds too (default setting): 6000 $ × 21 > 100 000 Kč
    expect(r.underLimitAfter).toBe(false);
    const taxable = 3000 * 21 - 1000 * fx2;
    expect(r.taxableGainCzk).toBeCloseTo(taxable);
    expect(r.extraTaxCzk).toBeCloseTo(taxable * 0.15);
  });

  it("stays tax-free under the 100 000 Kč limit", () => {
    const r = simulateSale(txs, before, { ...base, shares: 11, priceUsd: 300, saleFx: 20 }, { ...settings, limitIncludesExempt: false });
    // only the taxable piece (1 share × 300 $ × 20 = 6 000 Kč) counts against the limit
    expect(r.limitBaseAfterCzk).toBeCloseTo(6000);
    expect(r.underLimitAfter).toBe(true);
    expect(r.extraTaxCzk).toBe(0);
  });

  it("an incomplete year still gives the difference, flagged as approximate", () => {
    const r = simulateSale(txs, { ...before, complete: false }, { ...base, shares: 20, priceUsd: 300 }, settings);
    expect(r.complete).toBe(true);
    expect(r.yearComplete).toBe(false);
    expect(r.underLimitAfter).toBe(false);
    expect(r.extraTaxCzk).toBeCloseTo((3000 * 21 - 1000 * fx2) * 0.15);
  });

  it("flags selling more than the account holds and never mutates the input", () => {
    const copy = JSON.stringify(txs);
    const r = simulateSale(txs, before, { ...base, shares: 25 }, settings);
    expect(r.missingShares).toBeCloseTo(5);
    expect(r.complete).toBe(false);
    expect(r.extraTaxCzk).toBeNull();
    expect(JSON.stringify(txs)).toBe(copy);
  });
});
