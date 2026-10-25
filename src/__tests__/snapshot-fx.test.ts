import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDailySnapshots } from "@/hooks/usePortfolio";
import { toDisplaySnapshots } from "@/lib/snapshotFx";
import { createPortfolioFixture } from "@/test/agentPortfolioFixture";

const state = vi.hoisted(() => ({ code: "EUR", k: 0.04, range: vi.fn() }));
vi.mock("@/contexts/CurrencyContext", () => ({ useLocalFxOptional: () => ({ code: state.code, perCzkAt: () => state.k, perCzkToday: state.k }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({ select: () => ({ order: () => ({ range: state.range }) }) }) } }));

describe("raw to display snapshot boundary", () => {
  it.each([["CZK", 1], ["EUR", 0.04], ["GBP", 0.03], ["PLN", 0.16]] as const)("converts %s exactly once, preserving USD and cash", (code, k) => {
    const rows = createPortfolioFixture().snapshots.map(s => ({ ...s, fxBasis: "raw-czk" as const }));
    const original = structuredClone(rows);
    const out = toDisplaySnapshots(rows, { code, perCzkAt: () => k, perCzkToday: 2 * k });
    expect(out[0]).toEqual({ ...rows[0], fxBasis: "display", displayCurrency: code, value_czk: 2000 * k, profit_czk: 200 * k, fx_rate: 20 * k });
    expect(rows).toEqual(original);
    expect(() => {
      // @ts-expect-error Display snapshots must never cross the raw boundary again.
      toDisplaySnapshots(out, { code, perCzkAt: () => k, perCzkToday: k });
    }).toThrow(/raw/i);
  });

  it("preserves missing FX and nullable cash instead of inventing a rate", () => {
    const rows = createPortfolioFixture().snapshots.map(s => ({ ...s, fxBasis: "raw-czk" as const, fx_rate: null, cash_usd: null }));
    expect(toDisplaySnapshots(rows, { code: "EUR", perCzkAt: () => 0.04, perCzkToday: 0.04 })[0]).toMatchObject({ fx_rate: null, cash_usd: null });
  });

  it("caches raw DB values while currency switches only reselect display values", async () => {
    const { fxBasis: _tag, ...row } = createPortfolioFixture().snapshots[0];
    state.range.mockResolvedValue({ data: [row], error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const { result, rerender, unmount } = renderHook(() => useDailySnapshots(), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });
    try {
      await waitFor(() => expect(result.current.data?.[0].value_czk).toBe(80));
      expect(client.getQueryData(["daily-snapshots"])).toEqual([{ ...row, fxBasis: "raw-czk" }]);
      state.code = "GBP";
      state.k = 0.03;
      rerender();
      expect(result.current.data?.[0]).toMatchObject({ value_czk: 60, displayCurrency: "GBP" });
      expect(state.range).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(["daily-snapshots"])).toEqual([{ ...row, fxBasis: "raw-czk" }]);
    } finally { unmount(); client.clear(); }
  });
});
