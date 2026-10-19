import { describe, it, expect } from "vitest";
import { toBrokerSummary } from "@/hooks/useExtras";
import { computeNetDeposits } from "@/lib/netDeposits";

describe("toBrokerSummary keeps the connected T212 account", () => {
  it("passes account through (stringified) and null when absent", () => {
    const base = { currency: "USD", total: 100, free: 10, invested: 80, ppl: 5, result: 1 };
    expect(toBrokerSummary({ account_summary: { ...base, account: "123" } })?.account).toBe("123");
    expect(toBrokerSummary({ account_summary: { ...base, account: 456 } })?.account).toBe("456");
    expect(toBrokerSummary({ account_summary: base })?.account).toBeNull();
    expect(toBrokerSummary(null)).toBeNull();
  });

  it("lets computeNetDeposits tell the connected account from another T212 account", () => {
    const summary = toBrokerSummary({ account_summary: { currency: "USD", total: 1000, free: 0, invested: 900, ppl: 100, result: 0, account: "111" } });
    // A BUY on a DIFFERENT T212 account (imported from statements) is not part of the connected
    // account's balance identity, so it must not disappear into it.
    const txs = [
      { ticker: "AAPL", side: "BUY" as const, shares: 1, price_usd: 500, executed_at: "2025-01-02T10:00:00Z", broker: "T212", broker_account: "222" },
    ];
    const args = { txs, usdCzk: 23, fxAt: () => 23 };
    const withAccount = computeNetDeposits({ ...args, t212: summary });
    const withoutAccount = computeNetDeposits({ ...args, t212: { ...summary!, account: null } });
    expect(withAccount.usd).not.toBe(withoutAccount.usd);
  });
});
