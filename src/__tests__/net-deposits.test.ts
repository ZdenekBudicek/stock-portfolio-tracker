import { describe, it, expect } from "vitest";
import { computeNetDeposits, type DepositLedgerRow } from "@/lib/netDeposits";

const tx = (o: Partial<DepositLedgerRow> & Pick<DepositLedgerRow, "ticker" | "side" | "shares" | "price_usd">): DepositLedgerRow =>
  ({ executed_at: "2026-05-04T12:00:00Z", fee_usd: 0, ext_id: null, broker: "manual", broker_account: null, ...o });

const run = (txs: DepositLedgerRow[], t212: Parameters<typeof computeNetDeposits>[0]["t212"] = null, fx = 20) =>
  computeNetDeposits({ txs, t212, usdCzk: 22, fxAt: () => fx });

describe("computeNetDeposits", () => {
  it("does not read a sale at a broker without tracked cash as a loss", () => {
    // Revolut: $1 000 deposited, bought, sold for $1 100. The cash is not tracked, so Hodnota
    // is 0 and Vloženo must be the trade proxy (−$100), giving a profit of +$100.
    const txs = [
      tx({ ticker: "AAPL", side: "BUY", shares: 10, price_usd: 100, broker: "Revolut", ext_id: "revolut:t:1" }),
      tx({ ticker: "AAPL", side: "SELL", shares: 10, price_usd: 110, broker: "Revolut", ext_id: "revolut:t:2" }),
    ];
    const d = run(txs);
    expect(d.usd).toBe(-100);
    expect(0 - d.usd).toBe(100);
  });

  it("counts fees as money spent at untracked brokers", () => {
    const d = run([
      tx({ ticker: "MSFT", side: "BUY", shares: 1, price_usd: 400, fee_usd: 2, broker: "XTB" }),
      tx({ ticker: "MSFT", side: "SELL", shares: 1, price_usd: 450, fee_usd: 3, broker: "XTB" }),
    ]);
    expect(d.usd).toBe(400 + 2 - (450 - 3));
  });

  it("does not count a manual buy funded from a recorded deposit twice", () => {
    // Hotovost dialog: +$1 000, then a manual buy of $1 000 (the trigger takes it from CASH).
    const d = run([
      tx({ ticker: "CASH", side: "BUY", shares: 1_000, price_usd: 1 }),
      tx({ ticker: "NVDA", side: "BUY", shares: 5, price_usd: 200 }),
    ]);
    expect(d.usd).toBe(1_000);
  });

  it("books manual withdrawals as money out", () => {
    const d = run([
      tx({ ticker: "CASH", side: "BUY", shares: 1_000, price_usd: 1 }),
      tx({ ticker: "CASH", side: "SELL", shares: 300, price_usd: 1 }),
    ]);
    expect(d.usd).toBe(700);
  });

  it("replaces only the CONNECTED Trading 212 account's trades by its balance identity", () => {
    const t212 = { currency: "CZK", total: 300_000, ppl: 50_000, result: 30_000, account: "111" };
    const txs = [
      tx({ ticker: "AAPL", side: "BUY", shares: 10, price_usd: 100, broker: "T212", broker_account: "111", ext_id: "t212:ord:1" }),
      // A second T212 account known only from its statement: its cash is not tracked.
      tx({ ticker: "KO", side: "BUY", shares: 10, price_usd: 60, broker: "T212", broker_account: "222", ext_id: "t212:act:9" }),
    ];
    const d = run(txs, t212);
    expect(d.czk).toBeCloseTo(220_000 + 600 * 20, 6);
    expect(d.usd).toBeCloseTo(220_000 / 22 + 600, 6);
  });

  it("treats untagged T212 rows as the connected account only when no other account exists", () => {
    const t212 = { currency: "USD", total: 1_000, ppl: 100, result: 100, account: "111" };
    const legacy = tx({ ticker: "AAPL", side: "BUY", shares: 1, price_usd: 500, broker: "T212", ext_id: null });
    expect(run([legacy], t212).usd).toBe(800);
    const other = tx({ ticker: "KO", side: "BUY", shares: 1, price_usd: 50, broker: "T212", broker_account: "222" });
    expect(run([legacy, other], t212).usd).toBe(800 + 500 + 50);
  });

  it("keeps the trade proxy when the summary can't be trusted", () => {
    const row = tx({ ticker: "AAPL", side: "BUY", shares: 1, price_usd: 500, broker: "T212", broker_account: "111" });
    expect(run([row], { currency: "CZK", total: 0, ppl: 0, result: 0, account: "111" }).usd).toBe(500);
    expect(run([row], { currency: "EUR", total: 900, ppl: 100, result: 100, account: "111" }).usd).toBe(500);
    // Drawn-down profitable account: net deposits ≤ 0 → proxy.
    expect(run([row], { currency: "USD", total: 100, ppl: 0, result: 200, account: "111" }).usd).toBe(500);
  });

  it("applies the T212 identity to all T212 rows when the summary has no account (pre-scoping)", () => {
    const t212 = { currency: "USD", total: 1_000, ppl: 100, result: 100 };
    const d = run([tx({ ticker: "AAPL", side: "BUY", shares: 1, price_usd: 500, broker: "T212", broker_account: "222" })], t212);
    expect(d.usd).toBe(800);
  });

  it("includes reconciliation and holdings rows at untracked brokers — their shares are in Hodnota", () => {
    const d = run([
      tx({ ticker: "AAPL", side: "BUY", shares: 2, price_usd: 150, broker: "Revolut", ext_id: "revolut:pos:AAPL" }),
      tx({ ticker: "KO", side: "BUY", shares: 1, price_usd: 60, broker: "XTB", ext_id: "xtb:adj:-:KO" }),
    ]);
    expect(d.usd).toBe(360);
  });

  it("converts each flow at the FX of its own day", () => {
    const d = computeNetDeposits({
      txs: [
        tx({ ticker: "CASH", side: "BUY", shares: 100, price_usd: 1, executed_at: "2021-01-04T10:00:00Z" }),
        tx({ ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, broker: "XTB", executed_at: "2026-01-05T10:00:00Z" }),
      ],
      usdCzk: 22,
      fxAt: (d) => (d < "2025-01-01" ? 25 : 20),
    });
    expect(d.usd).toBe(200);
    expect(d.czk).toBe(100 * 25 + 100 * 20);
  });
});
