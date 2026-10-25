import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRealizedModel } from "@/hooks/useRealized";
import { createTaxFixture } from "@/test/agentPortfolioFixture";
import { computeRealized } from "@/lib/realizedModel";

function originalFields<T extends object>(model: T & { loading?: boolean; error?: unknown }) {
  const { loading, error, ...original } = model;
  return original;
}

const state = vi.hoisted(() => ({ transactions: {} as { data?: ReturnType<typeof createTaxFixture>["transactions"]; isLoading?: boolean; error?: unknown }, dividends: {} as { data?: ReturnType<typeof createTaxFixture>["dividends"]; isLoading?: boolean; error?: unknown }, currency: "USD" }));
vi.mock("@/hooks/usePortfolio", () => ({ useTransactions: () => state.transactions }));
vi.mock("@/hooks/useExtras", () => ({ useDividends: () => state.dividends }));
vi.mock("@/hooks/useTaxResidence", () => ({ useTaxResidence: () => ({ baseCurrency: state.currency }) }));
vi.mock("@/lib/cnbRates", () => ({ usdCzkFor: (date: string) => date < "2000-01-01" ? null : { rate: 20, ref: date } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const f = createTaxFixture();
  state.transactions = { data: f.transactions, isLoading: false, error: null };
  state.dividends = { data: f.dividends, isLoading: false, error: null };
  state.currency = "USD";
});
afterEach(() => vi.useRealTimers());

describe("original realized hook characterization", () => {
  it("keeps the 2024 purchase for a 2026 sale and every return field", () => {
    const { result } = renderHook(() => useRealizedModel(2026));
    expect(originalFields(result.current)).toMatchSnapshot();
    expect(result.current.report.net).toBe(200);
    expect(result.current.fifo.openLots[0].shares).toBe(6);
    expect(result.current.report.dividends.total).toBe(12);
  });

  it("captures empty history", () => {
    state.transactions.data = [];
    state.dividends.data = [];
    expect(originalFields(renderHook(() => useRealizedModel(2026)).result.current)).toMatchSnapshot();
  });

  it("retains warnings and missing purchase FX in CZK", () => {
    state.currency = "CZK";
    state.transactions.data[0].executed_at = "1990-01-02";
    state.transactions.data.push({ ...state.transactions.data[1], id: "unmatched", ticker: "MISSING" });
    const { result } = renderHook(() => useRealizedModel(2026));
    expect(originalFields(result.current)).toMatchSnapshot();
    expect(result.current.report.complete).toBe(false);
  });
});

describe("shared realized model", () => {
  it.each(["USD", "CZK", "EUR", "GBP", "PLN"] as const)("matches all hook fields in %s", currency => {
    state.currency = currency;
    const input = { ...createTaxFixture(), currency };
    const before = structuredClone(input);
    expect(computeRealized(input)).toEqual(originalFields(renderHook(() => useRealizedModel(2026)).result.current));
    expect(input).toEqual(before);
  });

  it("uses the injected date for paid dividends and available years", () => {
    const input = createTaxFixture();
    vi.setSystemTime(new Date("2040-01-01T12:00:00Z"));
    const early = computeRealized({ ...input, today: "2025-12-31" });
    expect(early.report.dividends.total).toBe(0);
    expect(early.years).toEqual([2026, 2025]);
    const out = computeRealized(input);
    expect(out.years).toEqual([2026]);
    expect(out.report.dividends.total).toBe(12);
  });

  it("filters adjustments and CASH, preserving all-history FIFO before year selection", () => {
    const input = createTaxFixture();
    input.transactions.push({ ...input.transactions[0], id: "adjust", ext_id: "fixture:adj:1" },
      { ...input.transactions[0], id: "cash", ticker: "CASH" });
    const out = computeRealized(input);
    expect(out.report.net).toBe(200);
    expect(out.fifo.openLots).toHaveLength(1);
    expect(out.fifo.openLots[0].shares).toBe(6);
    expect(computeRealized({ ...input, year: 2024 }).report.rows).toEqual([]);
  });

  it.each([false, true])("normalizes a split exactly once (already applied=%s)", applied => {
    const input = createTaxFixture();
    input.transactions[0] = { ...input.transactions[0], shares: applied ? 20 : 10, price_usd: applied ? 50 : 100 };
    input.transactions[1] = { ...input.transactions[1], shares: 8, price_usd: 75 };
    if (!applied) input.transactions.push({ ...input.transactions[0], id: "split", shares: 10, price_usd: 0,
      executed_at: "2025-01-02", ext_id: "fixture:split:2" });
    const out = computeRealized(input);
    expect(out.report.net).toBe(200);
    expect(out.fifo.openLots[0]).toMatchObject({ shares: 12, priceUsd: 50, acquiredAt: "2024-01-02T12:00:00Z" });
  });

  it("preserves cost and acquisition date through merger rows", () => {
    const input = createTaxFixture();
    const buy = input.transactions[0];
    input.transactions = [buy,
      { ...buy, id: "merger-out", side: "SELL", price_usd: 0, executed_at: "2025-01-02", ext_id: "fixture:merger:out" },
      { ...buy, id: "merger-in", ticker: "NEW", shares: 5, price_usd: 0, executed_at: "2025-01-02", ext_id: "fixture:merger:in" },
      { ...input.transactions[1], ticker: "NEW", shares: 2, price_usd: 300 }];
    const out = computeRealized(input);
    expect(out.report.net).toBe(200);
    expect(out.fifo.warnings).toEqual([]);
    expect(out.fifo.openLots[0]).toMatchObject({ ticker: "NEW", shares: 3, priceUsd: 200, acquiredAt: buy.executed_at });
  });

  it.each(["transactions", "dividends"] as const)("does not present failed %s as an empty complete report", dependency => {
    const error = new Error("Synthetic query failed");
    state[dependency] = { data: undefined, isLoading: false, error };
    const out = renderHook(() => useRealizedModel(2026)).result.current;
    expect(out.error).toBe(error);
    expect(out.report.complete).toBe(false);
    expect(out.loading).toBe(false);
  });

  it.each(["transactions", "dividends"] as const)("marks pending %s incomplete and recovers when loaded", dependency => {
    const data = state[dependency].data;
    state[dependency] = { data: undefined, isLoading: true, error: null };
    const { result, rerender } = renderHook(() => useRealizedModel(2026));
    expect(result.current.loading).toBe(true);
    expect(result.current.report.complete).toBe(false);
    Object.assign(state, { [dependency]: { data, isLoading: false, error: null } });
    rerender();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.report.complete).toBe(true);
    expect(result.current.report.net).toBe(200);
  });
});
