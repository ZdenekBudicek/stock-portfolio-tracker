import { describe, it, expect } from "vitest";
import { t212FillPriceUsd } from "../../supabase/functions/_shared/t212";

// Real fills from the T212 orders API (audit/t212-orders.json).
const usdCzk = (d: string) => (d.startsWith("2025-09") ? 20.8 : d.startsWith("2023-09") ? 23.05 : d.startsWith("2026-04") ? 21.2 : null);
const noClose = () => null;

describe("t212FillPriceUsd", () => {
  it("keeps fill.price for USD instruments", () => {
    expect(t212FillPriceUsd({ instrumentCurrency: "USD", price: 12.69, quantity: 1.97, walletCurrency: "CZK", walletNetValue: 560 }, usdCzk, noClose, "2025-09-09")).toBe(12.69);
  });
  it("prices a GBX fill from the CZK wallet amount, not 394.7 'dollars'", () => {
    const p = t212FillPriceUsd({ instrumentCurrency: "GBX", price: 394.7, quantity: 2.57013768, walletCurrency: "CZK", walletNetValue: 285.01 }, usdCzk, noClose, "2025-09-09")!;
    expect(p).toBeCloseTo(285.01 / 2.57013768 / 20.8, 6); // ≈ $5.33 = £3.947 × 1.35
    expect(p).toBeGreaterThan(5);
    expect(p).toBeLessThan(6);
  });
  it("prices GBP and EUR fills the same way (sells have positive netValue too)", () => {
    expect(t212FillPriceUsd({ instrumentCurrency: "GBP", price: 16.315, quantity: 4.313187, walletCurrency: "CZK", walletNetValue: 2001.12 }, usdCzk, noClose, "2023-09-13")!).toBeCloseTo(20.13, 2);
    expect(t212FillPriceUsd({ instrumentCurrency: "EUR", price: 41.52, quantity: 0.26556353, walletCurrency: "CZK", walletNetValue: -269.34 }, usdCzk, noClose, "2026-04-08")!).toBeCloseTo(269.34 / 0.26556353 / 21.2, 6);
  });
  it("uses a USD wallet amount directly", () => {
    expect(t212FillPriceUsd({ instrumentCurrency: "EUR", price: 40, quantity: 2, walletCurrency: "USD", walletNetValue: 90 }, usdCzk, noClose, "2026-04-08")).toBe(45);
  });
  it("requires execution conversion even when a market close exists", () => {
    expect(t212FillPriceUsd({ instrumentCurrency: "GBX", price: 395.5, quantity: 2.57, walletCurrency: "GBP", walletNetValue: 10.16 }, usdCzk, () => 5.31, "2025-09-09")).toBeNull();
    expect(t212FillPriceUsd({ instrumentCurrency: "GBX", price: 395.5, quantity: 2.57, walletCurrency: "GBP", walletNetValue: 10.16 }, usdCzk, noClose, "2025-09-09")).toBeNull();
    expect(t212FillPriceUsd({ instrumentCurrency: "EUR", price: 41, quantity: 1, walletCurrency: "CZK", walletNetValue: 900 }, () => null, noClose, "1999-01-01")).toBeNull();
  });
});

describe("t212FillPriceUsd — close fallback sanity", () => {
  it("rejects a split-adjusted close that does not match the as-traded price", () => {
    // pre-split fill at 400 pence; adjusted close $0.53 (10:1 later split) -> skip, not $0.53
    expect(t212FillPriceUsd({ instrumentCurrency: "GBX", price: 400, quantity: 1, walletCurrency: "GBP", walletNetValue: 4 }, () => null, () => 0.53, "2020-01-02")).toBeNull();
  });
  it("rejects a plausible market close when execution FX is missing", () => {
    expect(t212FillPriceUsd({ instrumentCurrency: "EUR", price: 41.5, quantity: 1, walletCurrency: "CZK", walletNetValue: 1000 }, () => null, () => 45.7, "2026-04-08")).toBeNull();
  });
});

describe("blockingUnpricedFills (Codex Astra review)", () => {
  const u = (executed_at: string, ext_id: string) => ({ executed_at, ext_id, label: ext_id });
  const statement = { statementMode: true, statementCutoff: "2026-06-16T12:00:00Z" };
  const apiOnly = { statementMode: false, statementCutoff: null };
  it("ignores a fill the statement already covers", async () => {
    const { blockingUnpricedFills } = await import("../../supabase/functions/_shared/t212");
    expect(blockingUnpricedFills([u("2026-05-01T10:00:00Z", "t212:ord:1")], [], statement, false)).toEqual([]);
  });
  it("ignores a fill already stored when the history is appended to", async () => {
    const { blockingUnpricedFills } = await import("../../supabase/functions/_shared/t212");
    expect(blockingUnpricedFills([u("2026-07-01T10:00:00Z", "t212:ord:2")], [{ ext_id: "t212:ord:2" }], statement, false)).toEqual([]);
  });
  it("blocks a stored fill when the batch REPLACES the history (it would be deleted)", async () => {
    const { blockingUnpricedFills } = await import("../../supabase/functions/_shared/t212");
    expect(blockingUnpricedFills([u("2026-07-01T10:00:00Z", "t212:ord:3")], [{ ext_id: "t212:ord:3" }], apiOnly, true)).toHaveLength(1);
  });
  it("blocks a new fill after the statement", async () => {
    const { blockingUnpricedFills } = await import("../../supabase/functions/_shared/t212");
    expect(blockingUnpricedFills([u("2026-07-01T10:00:00Z", "t212:ord:4")], [], statement, false)).toHaveLength(1);
  });
});
