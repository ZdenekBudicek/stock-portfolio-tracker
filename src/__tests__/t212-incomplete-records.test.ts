import { describe, expect, it } from "vitest";
import { matchT212CashStatements, normalizeOrder, parseT212OrderItem, t212ExternalCashFlows } from "../../supabase/functions/_shared/t212";

describe("incomplete T212 records", () => {
  const at = "2026-10-25T12:00:00Z";

  it.each([
    { type: "WITHDRAW", currency: "CZK" },
    { type: "WITHDRAW", dateTime: at },
  ])("rejects an incomplete conversion leg instead of importing its deposit: %j", leg => {
    const deposit = { type: "DEPOSIT", currency: "USD", dateTime: at, amount: 100 };
    expect(() => t212ExternalCashFlows([deposit, leg], "USD", "2026-10-25")).toThrow(/missing dateTime or currency/);
  });

  it("refuses to link a matching statement without a database row id", () => {
    const flow = { flow_date: "2026-10-25", amount_usd: 100 };
    expect(() => matchT212CashStatements([{ ...flow, ext_id: "api:1" }], [
      { ...flow, ext_id: "statement:1", source: "statement", broker_account: "123" },
    ], "123")).toThrow(/no row id/);
  });

  it("rejects a filled order without a ticker or time instead of silently dropping it", () => {
    expect(() => parseT212OrderItem({ order: { status: "FILLED" }, fill: { id: 1, filledAt: at } })).toThrow(/missing ticker or execution time/);
    expect(() => parseT212OrderItem({ order: { status: "FILLED", ticker: "AAPL_US_EQ" }, fill: { id: 1 } })).toThrow(/missing ticker or execution time/);
  });

  it("uses the order timestamp fallback when the fill timestamp is absent", () => {
    expect(parseT212OrderItem({ order: { status: "FILLED", ticker: "AAPL_US_EQ", createdAt: at },
      fill: { id: 1, quantity: 1, price: 100 } })).toMatchObject({ base: "AAPL", executed_at: at });
  });

  it("requires a timestamp when normalizing an order and retains timestamp fallbacks", () => {
    expect(() => normalizeOrder({ ticker: "AAPL_US_EQ" }, {})).toThrow(/missing execution time/);
    expect(normalizeOrder({ ticker: "AAPL_US_EQ", dateModified: at }, {}).executed_at).toBe(at);
    expect(normalizeOrder({ ticker: "AAPL_US_EQ", dateCreated: at }, {}).executed_at).toBe(at);
  });
});
