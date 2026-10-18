import { describe, it, expect } from "vitest";
import { runFifo, realizedUsd, isRealTradeTx, type FifoTx } from "@/lib/fifo";
import { buildSalesReport, isTimeTestExempt, timeTestExemptFrom, pragueDate, DEFAULT_TAX_SETTINGS } from "@/lib/czTax";
import { cnbUsdCzk } from "@/lib/cnbRates";

let seq = 0;
const tx = (o: Partial<FifoTx>): FifoTx => ({
  id: `t${String(++seq).padStart(4, "0")}`, ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, fee_usd: 0,
  executed_at: "2025-01-02T15:00:00Z", broker: "T212", broker_account: "1", ext_id: null, ...o,
});

describe("runFifo — lots split per sale", () => {
  it("1 share from 2020 + 99 from 2025, sell 100: only the 2020 share passes the time test", () => {
    const r = runFifo([
      tx({ shares: 1, price_usd: 50, executed_at: "2020-03-02T15:00:00Z" }),
      tx({ shares: 99, price_usd: 200, executed_at: "2025-03-03T15:00:00Z" }),
      tx({ side: "SELL", shares: 100, price_usd: 210, executed_at: "2025-06-02T15:00:00Z" }),
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.disposals).toHaveLength(2);
    const [old, recent] = r.disposals;
    expect(old.shares).toBe(1);
    expect(old.gainUsd).toBeCloseTo(160, 9);
    expect(recent.shares).toBe(99);
    expect(recent.gainUsd).toBeCloseTo(99 * 10, 9);

    const rep = buildSalesReport(r.disposals, 2025);
    const exempt = rep.rows.filter((x) => x.exempt);
    const taxable = rep.rows.filter((x) => !x.exempt);
    expect(exempt.map((x) => x.shares)).toEqual([1]);
    expect(taxable.map((x) => x.shares)).toEqual([99]);
    expect(rep.taxable.gainUsd).toBeCloseTo(990, 9);
    expect(rep.exempt.gainUsd).toBeCloseTo(160, 9);
  });

  it("a hand-entered sell consumes the oldest lots of the same ticker at the real broker", () => {
    const r = runFifo([
      tx({ shares: 5, price_usd: 100, broker: "Revolut", broker_account: "R", executed_at: "2023-01-02T15:00:00Z" }),
      tx({ shares: 5, price_usd: 150, broker: "XTB", broker_account: "X", executed_at: "2024-01-02T15:00:00Z" }),
      tx({ ticker: "MSFT", shares: 3, price_usd: 300, broker: "Revolut", broker_account: "R", executed_at: "2022-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares: 7, price_usd: 200, broker: "manual", broker_account: null, executed_at: "2026-07-29T15:00:00Z" }),
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.disposals.map((d) => [d.broker, d.shares])).toEqual([["REVOLUT", 5], ["XTB", 2]]);
    expect(realizedUsd(r)).toBeCloseTo(5 * 100 + 2 * 50, 9);
    expect(r.openLots.map((l) => [l.ticker, l.broker, l.shares]).sort()).toEqual([["AAPL", "XTB", 3], ["MSFT", "REVOLUT", 3]]);
  });

  it("a broker sell still never borrows another broker's lots", () => {
    const r = runFifo([
      tx({ shares: 5, broker: "Revolut", broker_account: "R" }),
      tx({ side: "SELL", shares: 2, price_usd: 120, executed_at: "2025-02-02T15:00:00Z" }),
    ]);
    expect(r.disposals).toEqual([]);
    expect(r.warnings.map((w) => w.kind)).toEqual(["unmatched-sell"]);
  });

  it("includes the buy fee in the cost and the sell fee in the proceeds, pro rata", () => {
    const r = runFifo([
      tx({ shares: 10, price_usd: 100, fee_usd: 5, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares: 4, price_usd: 120, fee_usd: 2, executed_at: "2024-02-01T15:00:00Z" }),
      tx({ side: "SELL", shares: 6, price_usd: 130, fee_usd: 3, executed_at: "2024-03-01T15:00:00Z" }),
    ]);
    const [a, b] = r.disposals;
    expect(a.costUsd).toBeCloseTo(400 + 2, 9); // 4/10 of the $5 buy fee
    expect(a.sellFeeUsd).toBeCloseTo(2, 9);
    expect(a.gainUsd).toBeCloseTo(480 - 2 - 402, 9);
    expect(b.costUsd).toBeCloseTo(600 + 3, 9);
    expect(b.gainUsd).toBeCloseTo(780 - 3 - 603, 9);
    expect(realizedUsd(r)).toBeCloseTo(1260 - 5 - 1005, 9);
    expect(r.openLots).toEqual([]);
  });

  it("keeps two brokers with the same ticker apart", () => {
    const r = runFifo([
      tx({ broker: "Revolut", broker_account: "R1", shares: 10, price_usd: 50, executed_at: "2020-01-06T15:00:00Z" }),
      tx({ broker: "T212", broker_account: "1234567", shares: 10, price_usd: 100, executed_at: "2024-01-08T15:00:00Z" }),
      tx({ broker: "T212", broker_account: "1234567", side: "SELL", shares: 10, price_usd: 120, executed_at: "2025-01-08T15:00:00Z" }),
    ]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0]).toMatchObject({ broker: "T212", shares: 10, buyPriceUsd: 100 });
    expect(r.disposals[0].gainUsd).toBeCloseTo(200, 9);
    // The cheap, old Revolut lot is still open — and would not make the T212 sale exempt.
    expect(r.openLots).toHaveLength(1);
    expect(r.openLots[0]).toMatchObject({ broker: "REVOLUT", shares: 10, priceUsd: 50 });
    expect(buildSalesReport(r.disposals, 2025).rows[0].exempt).toBe(false);
  });

  it("orders a buy and a sell on the same day (same timestamp) BUY first, whatever the input order", () => {
    // T212 statement rows all carry 12:00:00Z, so the database order is arbitrary.
    const sell = tx({ id: "a-sell", side: "SELL", shares: 10, price_usd: 30, executed_at: "2025-05-05T12:00:00Z" });
    const buy = tx({ id: "z-buy", shares: 10, price_usd: 10, executed_at: "2025-05-05T12:00:00Z" });
    for (const input of [[sell, buy], [buy, sell]]) {
      const r = runFifo(input);
      expect(r.warnings).toEqual([]);
      expect(realizedUsd(r)).toBeCloseTo(200, 9);
    }
    // With an older lot present, the same-day sell still consumes the OLDEST lot (FIFO).
    const r2 = runFifo([sell, buy, tx({ shares: 10, price_usd: 20, executed_at: "2025-01-02T15:00:00Z" })]);
    expect(r2.disposals[0].buyPriceUsd).toBe(20);
    expect(r2.openLots[0]).toMatchObject({ priceUsd: 10, shares: 10 });
  });

  it("reports unmatched shares as a warning instead of booking them at zero cost", () => {
    const r = runFifo([
      tx({ shares: 3, price_usd: 100, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares: 5, price_usd: 150, executed_at: "2024-06-03T15:00:00Z" }),
    ]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0].shares).toBe(3);
    expect(realizedUsd(r)).toBeCloseTo(150, 9); // not 150 + 2 × 150
    expect(r.warnings).toEqual([expect.objectContaining({ kind: "unmatched-sell", shares: 2, amountUsd: 300 })]);
  });

  it("does not depend on the input order of rows with identical timestamps and sides", () => {
    const a = tx({ id: "b", shares: 1, price_usd: 10, executed_at: "2025-02-03T12:00:00Z" });
    const b = tx({ id: "a", shares: 1, price_usd: 20, executed_at: "2025-02-03T12:00:00Z" });
    const s = tx({ side: "SELL", shares: 1, price_usd: 30, executed_at: "2025-03-03T12:00:00Z" });
    expect(runFifo([a, b, s]).disposals[0].buyPriceUsd).toBe(20); // id "a" first
    expect(runFifo([b, a, s]).disposals[0].buyPriceUsd).toBe(20);
  });

  it("filters reconciliation and holdings-snapshot rows with isRealTradeTx", () => {
    const rows = [
      tx({ shares: 1 }),
      tx({ shares: 1, ext_id: "t212:adj:1:AAPL" }),
      tx({ shares: 1, ext_id: "revolut:pos:AAPL" }),
      tx({ ticker: "CASH", shares: 100 }),
    ];
    expect(rows.filter(isRealTradeTx)).toHaveLength(1);
  });
});

describe("runFifo — corporate actions", () => {
  it("a Revolut 10:1 split rescales the open lots and keeps the purchase date", () => {
    const r = runFifo([
      tx({ broker: "Revolut", broker_account: "R1", ticker: "NVDA", shares: 2, price_usd: 1000, fee_usd: 1, executed_at: "2020-01-10T15:00:00Z" }),
      // Revolut books the split as 18 extra shares at $0 on the split day.
      tx({ broker: "Revolut", broker_account: "R1", ticker: "NVDA", shares: 18, price_usd: 0, ext_id: "revolut:split:NVDA:10 Jun 2024 04:00:00", executed_at: "2024-06-10T04:00:00Z" }),
      tx({ broker: "Revolut", broker_account: "R1", ticker: "NVDA", side: "SELL", shares: 20, price_usd: 120, executed_at: "2024-07-01T15:00:00Z" }),
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.disposals).toHaveLength(1);
    const d = r.disposals[0];
    expect(d.shares).toBeCloseTo(20, 9);
    expect(d.buyPriceUsd).toBeCloseTo(100, 9);
    expect(d.costUsd).toBeCloseTo(2001, 9);
    expect(d.acquiredAt).toBe("2020-01-10T15:00:00Z");
    expect(d.gainUsd).toBeCloseTo(2400 - 2001, 9);
    // Held since 2020 → exempt, not "bought on the split day".
    expect(buildSalesReport(r.disposals, 2024).rows[0].exempt).toBe(true);
  });

  it("a split applied to several lots keeps each lot's own date", () => {
    const r = runFifo([
      tx({ ticker: "TSLA", broker: "Revolut", shares: 1, price_usd: 900, executed_at: "2021-02-25T16:00:00Z" }),
      tx({ ticker: "TSLA", broker: "Revolut", shares: 1, price_usd: 600, executed_at: "2022-05-02T16:00:00Z" }),
      tx({ ticker: "TSLA", broker: "Revolut", shares: 4, price_usd: 0, ext_id: "revolut:split:TSLA:25 Aug 2022 08:29:11", executed_at: "2022-08-25T08:29:11Z" }),
    ]);
    expect(r.openLots.map((l) => [l.shares, l.priceUsd, l.acquiredAt.slice(0, 10)])).toEqual([
      [3, 300, "2021-02-25"],
      [3, 200, "2022-05-02"],
    ]);
  });

  it("a stock merger moves cost and acquisition date to the new ticker", () => {
    const at = "2022-05-26T04:18:28Z";
    const r = runFifo([
      tx({ ticker: "ZNGA", broker: "Revolut", shares: 40, price_usd: 7, executed_at: "2019-05-02T15:00:00Z" }),
      tx({ ticker: "ZNGA", broker: "Revolut", side: "SELL", shares: 40, price_usd: 0, ext_id: "revolut:26 May 2022 04:18:28:merger:ZNGA:-40.000000", executed_at: at }),
      tx({ ticker: "TTWO", broker: "Revolut", shares: 2, price_usd: 0, ext_id: "revolut:26 May 2022 04:18:28:merger:TTWO:2.000000", executed_at: at }),
      tx({ ticker: "TTWO", broker: "Revolut", side: "SELL", shares: 2, price_usd: 150, executed_at: "2023-01-03T15:00:00Z" }),
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0]).toMatchObject({ ticker: "TTWO", acquiredAt: "2019-05-02T15:00:00Z" });
    expect(r.disposals[0].costUsd).toBeCloseTo(280, 9);
    expect(r.disposals[0].gainUsd).toBeCloseTo(300 - 280, 9);
  });

  it("a merged-in lot takes its place by acquisition date, ahead of a later buy of the new ticker", () => {
    const at = "2022-05-26T04:18:28Z";
    const r = runFifo([
      tx({ ticker: "ZNGA", broker: "Revolut", shares: 40, price_usd: 5, executed_at: "2020-01-02T15:00:00Z" }),
      tx({ ticker: "TTWO", broker: "Revolut", shares: 2, price_usd: 160, executed_at: "2021-06-01T15:00:00Z" }),
      tx({ ticker: "ZNGA", broker: "Revolut", side: "SELL", shares: 40, price_usd: 0, ext_id: "revolut:26 May 2022 04:18:28:merger:ZNGA:-40.000000", executed_at: at }),
      tx({ ticker: "TTWO", broker: "Revolut", shares: 2, price_usd: 0, ext_id: "revolut:26 May 2022 04:18:28:merger:TTWO:2.000000", executed_at: at }),
      tx({ ticker: "TTWO", broker: "Revolut", side: "SELL", shares: 2, price_usd: 200, executed_at: "2024-01-03T15:00:00Z" }),
    ]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0].acquiredAt).toBe("2020-01-02T15:00:00Z"); // the 2020 lot goes first
    expect(r.disposals[0].gainUsd).toBeCloseTo(400 - 200, 9);
  });

  it("a cash merger is a sale for the cash paid (not a deposit)", () => {
    const r = runFifo([
      tx({ ticker: "AVLR", broker: "Revolut", shares: 4, price_usd: 60, executed_at: "2021-03-01T15:00:00Z" }),
      tx({ ticker: "AVLR", broker: "Revolut", side: "SELL", shares: 4, price_usd: 0, ext_id: "revolut:20 Oct 2022 05:12:52:merger:AVLR:-4.000000", executed_at: "2022-10-20T05:12:52Z" }),
      tx({ ticker: "AVLR", broker: "Revolut", side: "SELL", shares: 0, price_usd: 374, ext_id: "revolut:20 Oct 2022 05:12:52:mergercash:374.000000", executed_at: "2022-10-20T05:12:52Z" }),
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0].proceedsUsd).toBeCloseTo(374, 9);
    expect(r.disposals[0].gainUsd).toBeCloseTo(374 - 240, 9);
  });

  it("flags a merger whose cash never reached the ledger (old imports stored it as a deposit)", () => {
    const r = runFifo([
      tx({ ticker: "AVLR", broker: "Revolut", shares: 4, price_usd: 60, executed_at: "2021-03-01T15:00:00Z" }),
      tx({ ticker: "AVLR", broker: "Revolut", side: "SELL", shares: 4, price_usd: 0, ext_id: "revolut:x:merger:AVLR:-4", executed_at: "2022-10-20T05:12:52Z" }),
    ]);
    expect(r.warnings.map((w) => w.kind)).toEqual(["merger-without-cash"]);
  });
});

describe("time test — calendar years in Europe/Prague", () => {
  it("is exempt only from the day AFTER acquisition + 3 years", () => {
    expect(timeTestExemptFrom("2021-03-15")).toBe("2024-03-16");
    expect(isTimeTestExempt("2021-03-15", "2024-03-15")).toBe(false);
    expect(isTimeTestExempt("2021-03-15", "2024-03-16")).toBe(true);
  });

  it("handles 29 February: the 3 years end on 28 February", () => {
    expect(timeTestExemptFrom("2020-02-29")).toBe("2023-03-01");
    expect(isTimeTestExempt("2020-02-29", "2023-02-28")).toBe(false);
    expect(isTimeTestExempt("2020-02-29", "2023-03-01")).toBe(true);
    // Bought 28. 2. 2021: the 3 years end 28. 2. 2024, so the leap day is already exempt.
    expect(isTimeTestExempt("2021-02-28", "2024-02-28")).toBe(false);
    expect(isTimeTestExempt("2021-02-28", "2024-02-29")).toBe(true);
  });

  it("1096 days is not enough when the period contains no leap day", () => {
    // 2021-03-02 + 1096 days = 2024-03-02, the old code's boundary; the law needs > 3 years.
    expect(isTimeTestExempt("2021-03-02", "2024-03-02")).toBe(false);
  });

  it("uses the Prague calendar date of the trade, not UTC", () => {
    expect(pragueDate("2023-02-28T23:30:00Z")).toBe("2023-03-01");
    const r = runFifo([
      tx({ shares: 1, price_usd: 10, executed_at: "2020-02-29T15:00:00Z" }),
      tx({ side: "SELL", shares: 1, price_usd: 20, executed_at: "2023-02-28T23:30:00Z" }),
    ]);
    expect(buildSalesReport(r.disposals, 2023).rows[0].exempt).toBe(true);
  });
});

describe("CZK conversion and the 100 000 Kč limit", () => {
  const rate = (d: string) => cnbUsdCzk(d)!.rate;

  it("converts cost at the purchase-date rate and proceeds at the sale-date rate", () => {
    const r = runFifo([
      tx({ shares: 10, price_usd: 100, fee_usd: 1, executed_at: "2022-10-20T15:00:00Z" }),
      tx({ side: "SELL", shares: 10, price_usd: 100, fee_usd: 1, executed_at: "2024-01-15T15:00:00Z" }),
    ]);
    const rep = buildSalesReport(r.disposals, 2024);
    const row = rep.rows[0];
    expect(row.fxBuy!.ref).toBe("2022-10-20");
    expect(row.fxSell!.ref).toBe("2024-01-15");
    expect(row.costCzk).toBeCloseTo(1001 * rate("2022-10-20"), 6);
    expect(row.proceedsCzk).toBeCloseTo(1000 * rate("2024-01-15"), 6);
    // Flat in USD (−$2 fees), but the dollar fell → a CZK loss, not "zero × today's rate".
    expect(row.gainUsd).toBeCloseTo(-2, 9);
    expect(row.gainCzk).toBeCloseTo(1000 * rate("2024-01-15") - 1 * rate("2024-01-15") - 1001 * rate("2022-10-20"), 6);
    expect(row.gainCzk!).toBeLessThan(-1000);
  });

  it("weekend trades use the last rate published before them", () => {
    expect(cnbUsdCzk("2024-01-13")!.ref).toBe("2024-01-12"); // Saturday → Friday
  });

  it("exempts all sales when the year's proceeds stay within 100 000 Kč", () => {
    const sellDay = "2024-03-15";
    const shares = Math.floor(99_000 / rate(sellDay) / 10); // proceeds just under 100k
    const r = runFifo([
      tx({ shares, price_usd: 5, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares, price_usd: 10, executed_at: `${sellDay}T15:00:00Z` }),
    ]);
    const rep = buildSalesReport(r.disposals, 2024);
    expect(rep.proceedsCzk).toBeLessThanOrEqual(100_000);
    expect(rep.taxable.gainCzk).toBeGreaterThan(0);
    expect(rep.underLimit).toBe(true);
    expect(rep.taxBaseCzk).toBe(0);
    expect(rep.estTaxCzk).toBe(0);
  });

  it("taxes the gain once proceeds exceed 100 000 Kč, and never a net loss", () => {
    const sellDay = "2024-03-15";
    const shares = Math.ceil(101_000 / rate(sellDay) / 10);
    const r = runFifo([
      tx({ shares, price_usd: 5, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares, price_usd: 10, executed_at: `${sellDay}T15:00:00Z` }),
    ]);
    const rep = buildSalesReport(r.disposals, 2024);
    expect(rep.underLimit).toBe(false);
    expect(rep.taxBaseCzk).toBeCloseTo(rep.taxable.gainCzk, 6);
    expect(rep.estTaxCzk).toBeCloseTo(rep.taxBaseCzk * 0.15, 6);

    const loss = runFifo([
      tx({ shares, price_usd: 20, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares, price_usd: 10, executed_at: `${sellDay}T15:00:00Z` }),
    ]);
    expect(buildSalesReport(loss.disposals, 2024).taxBaseCzk).toBe(0);
  });

  it("time-test-exempt proceeds count towards the limit only when the setting says so", () => {
    const sellDay = "2024-03-15";
    const exemptShares = Math.ceil(150_000 / rate(sellDay) / 10);
    const r = runFifo([
      tx({ shares: exemptShares, price_usd: 5, executed_at: "2019-01-02T15:00:00Z" }),
      tx({ shares: 10, price_usd: 5, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares: exemptShares + 10, price_usd: 10, executed_at: `${sellDay}T15:00:00Z` }),
    ]);
    const strict = buildSalesReport(r.disposals, 2024, DEFAULT_TAX_SETTINGS);
    expect(strict.limitBaseCzk).toBeGreaterThan(100_000);
    expect(strict.underLimit).toBe(false);
    expect(strict.taxBaseCzk).toBeGreaterThan(0);
    const lenient = buildSalesReport(r.disposals, 2024, { ...DEFAULT_TAX_SETTINGS, limitIncludesExempt: false });
    expect(lenient.limitBaseCzk).toBeLessThan(100_000);
    expect(lenient.underLimit).toBe(true);
    expect(lenient.taxBaseCzk).toBe(0);
  });

  it("marks the report incomplete instead of using today's rate when a rate is missing", () => {
    const r = runFifo([
      tx({ shares: 1, price_usd: 10, executed_at: "2024-01-02T15:00:00Z" }),
      tx({ side: "SELL", shares: 1, price_usd: 20, executed_at: "2099-03-02T15:00:00Z" }),
    ]);
    const rep = buildSalesReport(r.disposals, 2099);
    expect(rep.rows[0].proceedsCzk).toBeNull();
    expect(rep.rows[0].gainCzk).toBeNull();
    expect(rep.complete).toBe(false);
    expect(rep.missingFx).toEqual(["2099-03-02"]);
    expect(rep.underLimit).toBe(false);
  });

  it("GFŘ method converts with the unified rate of each year", () => {
    const r = runFifo([
      tx({ shares: 10, price_usd: 100, executed_at: "2022-06-01T15:00:00Z" }),
      tx({ side: "SELL", shares: 10, price_usd: 100, executed_at: "2024-06-03T15:00:00Z" }),
    ]);
    const row = buildSalesReport(r.disposals, 2024, { ...DEFAULT_TAX_SETTINGS, fxMethod: "gfr-annual" }).rows[0];
    expect(row.fxBuy).toEqual({ rate: 23.41, ref: "GFŘ 2022" });
    expect(row.fxSell).toEqual({ rate: 23.28, ref: "GFŘ 2024" });
    expect(row.gainCzk).toBeCloseTo(1000 * 23.28 - 1000 * 23.41, 6);
  });
});

describe("sales report — unmatched sells (Codex Astra review)", () => {
  it("counts an unmatched sale against the 100 000 Kč limit and marks the year incomplete", () => {
    const r = runFifo([
      tx({ shares: 1, price_usd: 100, executed_at: "2025-02-03T15:00:00Z" }),
      tx({ side: "SELL", shares: 10, price_usd: 1500, executed_at: "2025-06-02T15:00:00Z" }),
    ]);
    const rep = buildSalesReport(r.disposals, 2025, DEFAULT_TAX_SETTINGS, r.warnings);
    expect(rep.unmatchedProceedsCzk).toBeGreaterThan(9 * 1500 * 15);
    expect(rep.complete).toBe(false);
    expect(rep.underLimit).toBe(false);
  });
  it("puts an unmatched sale late on 31 Dec UTC into the Prague year it happened in", () => {
    const r = runFifo([tx({ side: "SELL", shares: 2, price_usd: 1000, executed_at: "2024-12-31T23:30:00Z" })]);
    expect(buildSalesReport(r.disposals, 2025, DEFAULT_TAX_SETTINGS, r.warnings).unmatchedProceedsCzk).toBeGreaterThan(0);
    expect(buildSalesReport(r.disposals, 2024, DEFAULT_TAX_SETTINGS, r.warnings).unmatchedProceedsCzk).toBe(0);
  });
});
