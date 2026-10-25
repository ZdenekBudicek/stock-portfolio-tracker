// Regression: the nightly auto-sync reconciled share COUNTS only. A loss-harvest — sell and
// re-buy the same shares on one day — left the count unchanged, so the sale was never
// stored: the tax report did not move until the user pressed "Synchronizovat". auto-sync now
// appends the fills newer than the stored history (planT212Append & co.).
import { describe, it, expect } from "vitest";
import {
  planT212Append, reachedAppendStop, selectT212Appends, parseT212OrderItem, t212ItemTime,
  type T212StoredTrade,
} from "../../supabase/functions/_shared/t212";

const act = (day: string, o: Partial<T212StoredTrade> = {}): T212StoredTrade => ({
  ext_id: `t212:act:${day}`, executed_at: `${day}T12:00:00.000Z`, ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, ...o,
});
const ord = (id: string, at: string, o: Partial<T212StoredTrade> = {}): T212StoredTrade => ({
  ext_id: `t212:ord:${id}`, executed_at: at, ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, ...o,
});
const adj = (at: string): T212StoredTrade => ({ ext_id: "t212:adj:111:AAPL", executed_at: at, ticker: "AAPL", side: "BUY", shares: 3, price_usd: 120 });

describe("planT212Append", () => {
  it("stops at the newest stored trade — API fill or statement row, never an adjustment", () => {
    const stored = [act("2026-09-01"), ord("1", "2026-10-10T14:00:00Z"), adj("2026-10-22T02:00:00Z")];
    const p = planT212Append(stored, { resuming: false });
    expect(p.skip).toBeNull();
    expect(p.stopAt).toBe("2026-10-10T14:00:00Z");
    expect(p.history.statementMode).toBe(true);
  });

  it("pure-API accounts append too", () => {
    const p = planT212Append([ord("1", "2026-10-10T14:00:00Z"), adj("2026-10-22T02:00:00Z")], { resuming: false });
    expect(p.skip).toBeNull();
    expect(p.history.statementMode).toBe(false);
    expect(p.stopAt).toBe("2026-10-10T14:00:00Z");
  });

  it("leaves the first import and a running manual sync alone", () => {
    expect(planT212Append([], { resuming: false }).skip).toMatch(/no stored trades/);
    expect(planT212Append([adj("2026-10-22T02:00:00Z")], { resuming: false }).skip).toMatch(/no stored trades/);
    expect(planT212Append([ord("1", "2026-10-10T14:00:00Z")], { resuming: true }).skip).toMatch(/manual sync/);
  });
});

describe("reachedAppendStop", () => {
  it("is true once a newest-first page reaches the stored history", () => {
    const stop = "2026-10-10T14:00:00Z";
    expect(reachedAppendStop(["2026-10-21T15:00:00Z", "2026-10-21T14:59:00Z"], stop)).toBe(false);
    expect(reachedAppendStop(["2026-10-21T15:00:00Z", "2026-10-10T14:00:00Z"], stop)).toBe(true);
    expect(reachedAppendStop([null, "2026-09-01T00:00:00Z"], stop)).toBe(true);
  });
});

describe("selectT212Appends", () => {
  it("a same-day sell and re-buy are both appended; stored fills are not", () => {
    const stored = [ord("1", "2026-03-02T15:00:00Z", { shares: 10, price_usd: 200 })];
    const plan = planT212Append(stored, { resuming: false });
    const fetched = [
      ord("3", "2026-10-21T15:01:00Z", { shares: 10, price_usd: 150 }),
      ord("2", "2026-10-21T15:00:00Z", { side: "SELL", shares: 10, price_usd: 150 }),
      ord("1", "2026-03-02T15:00:00Z", { shares: 10, price_usd: 200 }),
    ];
    expect(selectT212Appends(fetched, stored, plan).map((r) => r.ext_id)).toEqual(["t212:ord:3", "t212:ord:2"]);
  });

  it("statement mode: a fill the statement already records under another id is not appended twice", () => {
    const stored = [act("2026-10-21", { side: "SELL", shares: 10, price_usd: 150 })];
    const plan = planT212Append(stored, { resuming: false });
    const fetched = [
      ord("9", "2026-10-21T15:00:00Z", { side: "SELL", shares: 10, price_usd: 150 }), // same trade as the statement row
      ord("10", "2026-10-22T15:00:00Z", { shares: 5, price_usd: 151 }),
    ];
    expect(selectT212Appends(fetched, stored, plan).map((r) => r.ext_id)).toEqual(["t212:ord:10"]);
  });
});

describe("parseT212OrderItem", () => {
  it("keeps only filled orders, with the sell side from the negative quantity", () => {
    const item = {
      order: { status: "FILLED", ticker: "AAPL_US_EQ", instrument: { isin: "US0378331005", name: "Apple", currency: "USD" } },
      fill: { id: 42, quantity: -3, price: 150.5, filledAt: "2026-10-21T15:00:00Z", walletImpact: { currency: "CZK", netValue: 9750 } },
    };
    expect(parseT212OrderItem(item)).toMatchObject({
      base: "AAPL", side: "SELL", shares: 3, price_usd: 150.5, inst_ccy: "USD", wallet_ccy: "CZK", wallet_net: 9750,
      executed_at: "2026-10-21T15:00:00Z", ext_id: "t212:ord:42",
    });
    expect(parseT212OrderItem({ order: { status: "CANCELLED" } })).toBeNull();
    expect(t212ItemTime({ order: { dateModified: "2026-10-21T10:00:00Z" } })).toBe("2026-10-21T10:00:00Z");
  });
});
