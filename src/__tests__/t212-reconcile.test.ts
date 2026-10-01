import { describe, it, expect } from "vitest";
import { mapT212Ticker, normalizeOrder, matchManual } from "../../supabase/functions/_shared/t212";

describe("mapT212Ticker", () => {
  it("strips _US_EQ and _EQ suffixes", () => {
    expect(mapT212Ticker("AAPL_US_EQ", {})).toBe("AAPL");
    expect(mapT212Ticker("VWCE_EQ", {})).toBe("VWCE");
  });
  it("uses provided instrument map when available", () => {
    expect(mapT212Ticker("AAPL_US_EQ", { AAPL_US_EQ: "AAPL" })).toBe("AAPL");
  });
});

describe("normalizeOrder", () => {
  it("maps a filled buy order to a transaction shape", () => {
    const o = { id: 99, ticker: "AAPL_US_EQ", quantity: 3, fillPrice: 200, dateExecuted: "2026-06-01T10:00:00Z", type: "MARKET" };
    expect(normalizeOrder(o, {})).toEqual({
      t212_id: "99", ticker: "AAPL", side: "BUY", shares: 3, price_usd: 200, fee_usd: 0,
      executed_at: "2026-06-01T10:00:00Z",
    });
  });
  it("treats negative quantity as SELL with positive shares", () => {
    const o = { id: 7, ticker: "AAPL_US_EQ", quantity: -2, fillPrice: 210, dateExecuted: "2026-06-02T10:00:00Z" };
    const n = normalizeOrder(o, {});
    expect(n.side).toBe("SELL");
    expect(n.shares).toBe(2);
  });
});

describe("matchManual", () => {
  const tx = (o: any) => ({ id: "x", ticker: "AAPL", side: "BUY", shares: 3, executed_at: "2026-06-01T00:00:00Z", broker: "manual", t212_id: null, ...o });
  it("matches same ticker/side, shares within tolerance, date within 3 days", () => {
    const cand = { ticker: "AAPL", side: "BUY" as const, shares: 3.001, executed_at: "2026-06-03T10:00:00Z" };
    expect(matchManual(cand, [tx({})])?.id).toBe("x");
  });
  it("does not match a different broker", () => {
    const cand = { ticker: "AAPL", side: "BUY" as const, shares: 3, executed_at: "2026-06-01T10:00:00Z" };
    expect(matchManual(cand, [tx({ broker: "XTB" })])).toBeNull();
  });
  it("does not match an already-tagged tx", () => {
    const cand = { ticker: "AAPL", side: "BUY" as const, shares: 3, executed_at: "2026-06-01T10:00:00Z" };
    expect(matchManual(cand, [tx({ t212_id: "55" })])).toBeNull();
  });
  it("does not match outside the date window", () => {
    const cand = { ticker: "AAPL", side: "BUY" as const, shares: 3, executed_at: "2026-06-30T10:00:00Z" };
    expect(matchManual(cand, [tx({})])).toBeNull();
  });
});
