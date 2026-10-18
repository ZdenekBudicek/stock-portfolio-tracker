import { describe, it, expect } from "vitest";
import { computeNetDeposits } from "@/lib/netDeposits";

const fxAt = () => 20;
const buy = (broker: string, usd: number, account: string | null = null) =>
  ({ ticker: "KO", side: "BUY" as const, shares: 1, price_usd: usd, executed_at: "2025-01-02T12:00:00Z", broker, broker_account: account });

describe("computeNetDeposits — dividends at brokers without tracked cash", () => {
  it("a Revolut dividend comes back out of Vloženo (the reinvested buy is no longer a fresh deposit)", () => {
    const r = computeNetDeposits({
      txs: [buy("Revolut", 1000), buy("Revolut", 10)],
      usdCzk: 20, fxAt,
      dividends: [{ broker: "Revolut", status: "paid", total_amount_usd: 10, ex_date: "2025-03-01", pay_date: "2025-03-10", ext_id: "revolut:div:1" }],
    });
    expect(r.usd).toBeCloseTo(1000, 9);
  });
  it("ignores estimated (auto), upcoming and ext_id-less rows", () => {
    const r = computeNetDeposits({
      txs: [buy("XTB", 500)], usdCzk: 20, fxAt,
      dividends: [
        { broker: "auto", status: "paid", total_amount_usd: 5, ex_date: "2025-03-01", ext_id: null },
        { broker: "XTB", status: "upcoming", total_amount_usd: 5, ex_date: "2025-03-01", ext_id: "xtb:dividend:1" },
        { broker: "XTB", status: "paid", total_amount_usd: 5, ex_date: "2025-03-01", ext_id: null },
      ],
    });
    expect(r.usd).toBe(500);
  });
  it("leaves the connected T212 account alone (its dividends sit in the tracked free cash)", () => {
    const r = computeNetDeposits({
      txs: [buy("T212", 1000, "1234567")], usdCzk: 20, fxAt,
      t212: { currency: "CZK", total: 30000, ppl: 4000, result: 6000, account: "1234567" },
      dividends: [{ broker: "T212", broker_account: "1234567", status: "paid", total_amount_usd: 7, ex_date: "2025-03-01", ext_id: "t212:div:1" }],
    });
    expect(r.usd).toBeCloseTo(20000 / 20, 9);
  });
});

describe("computeNetDeposits / computeTradeFlows — merger cash and XTB gross dividends (Codex Astra review)", () => {
  it("merger cash (0-share SELL, amount in price_usd) comes back out of Vloženo", () => {
    const r = computeNetDeposits({
      txs: [
        buy("Revolut", 240),
        { ticker: "AVLR", side: "SELL" as const, shares: 0, price_usd: 374, executed_at: "2022-10-20T05:12:52Z", broker: "Revolut", ext_id: "revolut:20 Oct 2022:mergercash:374.000000" },
      ],
      usdCzk: 20, fxAt,
    });
    expect(r.usd).toBeCloseTo(240 - 374, 9); // closed position: profit = 0 − (−134) = +134
  });
  it("an XTB dividend is counted net of the 15 % withholding", () => {
    const r = computeNetDeposits({
      txs: [buy("XTB", 1000)], usdCzk: 20, fxAt,
      dividends: [{ broker: "XTB", status: "paid", total_amount_usd: 100, ex_date: "2025-03-01", ext_id: "xtb:dividend:1" }],
    });
    expect(r.usd).toBeCloseTo(1000 - 85, 9);
  });
  it("computeTradeFlows books merger cash as money out", async () => {
    const { computeTradeFlows } = await import("@/hooks/usePortfolio");
    const m = computeTradeFlows([
      { id: "1", ticker: "AVLR", side: "SELL", shares: 0, price_usd: 374, fee_usd: 0, executed_at: "2022-10-20T05:12:52Z", note: null, ext_id: "revolut:20 Oct 2022:mergercash:374.000000" } as any,
    ]);
    expect(m.get("2022-10-20")).toBe(-374);
  });
});
