import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useComputedPortfolio } from "@/hooks/usePortfolio";
import { createPortfolioFixture, portfolioGolden } from "@/test/agentPortfolioFixture";
import { computePortfolio, computeHoldingCostFifo, computeTradeFlows, isCashPosition, summarizeHoldings, visibleHoldings, DUST_USD } from "@/lib/portfolioModel";
import { toDisplaySnapshots } from "@/lib/snapshotFx";
import { toBrokerSummary } from "@/lib/brokerSummary";
import { computeAllocationModel } from "@/lib/allocationModel";
import { computePerformanceModel } from "@/lib/performanceModel";
import { deriveAlerts } from "@/lib/alerts";

function inputFixture() {
  const f = createPortfolioFixture();
  return { positions: f.positions, transactions: f.transactions, prices: f.livePrices.prices,
    snapshots: toDisplaySnapshots(f.snapshots.map(s => ({ ...s, fxBasis: "raw-czk" as const })), f.fx),
    fx: f.fx, usdCzk: 25, t212Summary: null, dividends: [] };
}

const state = vi.hoisted(() => ({ queries: {} as Record<string, { data?: unknown; isLoading?: boolean; error?: unknown }>, fx: null as unknown }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "synthetic" } }) }));
vi.mock("@/contexts/CurrencyContext", () => ({ useLocalFxOptional: () => state.fx }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: { queryKey: string[]; select?: (rows: unknown) => unknown }) => {
  const query = state.queries[options.queryKey[0]] ?? { data: null, isLoading: false };
  return { ...query, data: options.select && query.data ? options.select(query.data) : query.data };
} }));

beforeEach(() => {
  const fixture = createPortfolioFixture();
  state.fx = fixture.fx;
  state.queries = Object.fromEntries(Object.entries({ positions: fixture.positions, transactions: fixture.transactions,
    "live-prices": fixture.livePrices, "daily-snapshots": fixture.snapshots, "broker-summary": null, dividends: [], deposits: [] })
    .map(([key, data]) => [key, { data, isLoading: false }]));
});

describe("shared portfolio model", () => {
  it("matches the independent original hook constants without mutating inputs", () => {
    const input = inputFixture();
    const before = structuredClone({ ...input, fx: undefined });
    expect(computePortfolio(input)).toEqual(portfolioGolden);
    expect({ ...input, fx: undefined }).toEqual(before);
  });

  it("C4 hides dust in display consumers but keeps its value, cost and daily/total returns", () => {
    const input = inputFixture();
    input.positions = [
      { ...input.positions[0], ticker: "DUST", shares: 1, avg_cost_usd: 5, sector: "Energy" },
      { ...input.positions[0], ticker: "KEEP", shares: 1, avg_cost_usd: 10 },
      { ...input.positions[1], shares: 0.01 },
    ];
    input.transactions = [];
    input.prices = { DUST: { price: 9.99, prevClose: 5, changePct: 99.8 } };
    const out = computePortfolio(input);
    expect(out.positions.map(p => p.ticker)).toEqual(["KEEP", "CASH"]);
    expect(out.totalValue).toBeCloseTo(20);
    expect(out.totalInvested).toBe(15);
    expect(out.totalInvestedCzk).toBe(375);
    expect(out.unrealizedProfit).toBeCloseTo(4.99);
    expect(out.dailyReturn).toBeCloseTo(4.99);
    expect(out.totalProfit).toBeCloseTo(4.99);
    expect(out.totalReturnPct).toBeCloseTo(4.99 / 15 * 100);
    expect(out.positions.find(p => p.ticker === "KEEP")?.allocation).toBe(50);

    const allocation = computeAllocationModel({ positions: out.positions, dbPositions: input.positions, profiles: new Map(), quoteCurrencies: {} });
    expect(allocation.top5.map(p => p.ticker)).toEqual(["KEEP"]);
    expect(allocation.sectors.map(s => s.name)).not.toContain("Energy");
    expect(deriveAlerts({ today: "2025-03-03", positions: out.positions.map(p => ({ ...p, hasPrevClose: true })),
      moveThresholdPct: 5, watch: [], priceOf: () => null, tax: null, earnings: [], earningsDaysAhead: 7,
      held: new Set(out.positions.map(p => p.ticker)), newlyExempt: [], pricesStale: false, pricesError: null })).toEqual([]);
    const performance = computePerformanceModel({ snapshots: [], portfolio: out, transactions: [], dividends: [], benchmark: [], currency: "USD", today: "2025-03-03" });
    expect(performance.holdingsUsd).toBeCloseTo(19.99);
    expect(performance.points.at(-1)?.total).toBeCloseTo(20); // return series includes cash
  });

  it("C4 shares the inclusive USD threshold and preserves small cash balances without mutation", () => {
    expect(DUST_USD).toBe(10);
    const rows = [
      { ticker: "DUST", value: 9.99 }, { ticker: "ZERO", value: 0 }, { ticker: "KEEP", value: 10 },
      { ticker: "CASH", value: 0.01 }, { ticker: "OTHER-CASH", type: "Cash", value: 0 },
    ];
    expect(visibleHoldings(rows).map(p => p.ticker)).toEqual(["KEEP", "CASH", "OTHER-CASH"]);
    expect(rows).toHaveLength(5);
  });

  it("C5 does not flag holdings-only imports or dated FIFO costs as estimated", () => {
    const input = inputFixture();
    expect(computePortfolio({ ...input, transactions: [] }).fxEstimated).toBeUndefined();
    expect(computePortfolio(input).fxEstimated).toBeUndefined();
    expect(computePortfolio({ ...input, snapshots: [] }).fxEstimated).toBeUndefined();
  });

  it("C5 flags an undated deposit identity, but clears the flag for a complete dated ledger", () => {
    const input = inputFixture();
    const t212Summary = toBrokerSummary({ account_summary: { currency: "USD", total: 100, ppl: 0, result: 0, account: "a" } });
    expect(computePortfolio({ ...input, t212Summary }).fxEstimated).toBe(true);
    expect(computePortfolio({ ...input, t212Summary, deposits: [
      { broker: "T212", broker_account: "a", flow_date: "2024-01-02", amount_usd: 100 },
    ] }).fxEstimated).toBeUndefined();
  });

  it("C5 flags a deposit that actually uses the current-rate FX fallback without FIFO trades", () => {
    const input = inputFixture();
    input.transactions = [{ ...input.transactions[0], ticker: "CASH", shares: 1, price_usd: 100, executed_at: "1990-01-01" }];
    const out = computePortfolio({ ...input, snapshots: [] });
    expect(out.fxEstimated).toBe(true);
    expect(out.netDepositsCzk).toBe(2500);
  });

  it("keeps another T212 account outside the connected identity", () => {
    const input = inputFixture();
    const summary = toBrokerSummary({ account_summary: { currency: "USD", total: 1000, ppl: 100, result: 50, account: "connected" } });
    input.transactions = [
      { ...input.transactions[0], broker: "T212", broker_account: "connected" },
      { ...input.transactions[0], id: "other", shares: 2, broker: "T212", broker_account: "other" },
    ];
    expect(computePortfolio({ ...input, t212Summary: summary }).netDepositsUsd).toBe(1050);
    expect(computePortfolio({ ...input, transactions: input.transactions.slice(0, 1), t212Summary: summary }).netDepositsUsd).toBe(850);
  });

  it("includes synthetic adjustments in holding cost but not realized profit or trade flows", () => {
    const input = inputFixture();
    input.transactions.push({ ...input.transactions[0], id: "adjust", shares: 2, price_usd: 50, executed_at: "2024-03-01", ext_id: "fixture:adj:1" });
    input.positions[0].shares = 8;
    const out = computePortfolio(input);
    expect(out.totalInvested).toBe(700);
    expect(out.realizedProfit).toBe(200);
    expect(computeHoldingCostFifo(input.transactions).get("SYN")).toEqual({ shares: 8, cost: 700, costCzk: 700 });
    expect([...computeTradeFlows(input.transactions)]).toEqual([["2024-01-02", 1000], ["2024-02-02", -600]]);
  });

  it("uses historical EUR cost and today's EUR value", () => {
    const input = inputFixture();
    const fx = { code: "EUR" as const, perCzkAt: () => 0.04, perCzkToday: 0.04 };
    input.positions = [{ ...input.positions[0], shares: 1 }];
    input.transactions = [{ ...input.transactions[0], shares: 1 }];
    input.prices.SYN.price = 100;
    const snapshots = toDisplaySnapshots(createPortfolioFixture().snapshots.map(s => ({ ...s, fxBasis: "raw-czk" as const })), fx);
    const out = computePortfolio({ ...input, fx, snapshots });
    expect(out.totalInvestedCzk).toBe(80);
    expect(out.positions[0].valueCzk).toBe(100);
    expect(out.unrealizedProfitCzk).toBe(20);
  });

  it("uses the earlier snapshot's USD/CZK and the actual purchase day's local rate", () => {
    const input = inputFixture();
    const fx = { code: "EUR" as const, perCzkAt: (date: string) => date === "2024-01-02" ? 0.04 : 0.05, perCzkToday: 0.04 };
    input.transactions[0].executed_at = "2024-01-03";
    const snapshots = toDisplaySnapshots(createPortfolioFixture().snapshots.map(s => ({ ...s, fxBasis: "raw-czk" as const })), fx);
    expect(computePortfolio({ ...input, fx, snapshots }).totalInvestedCzk).toBe(600);
    expect(computePortfolio({ ...input, fx, snapshots: [] }).totalInvestedCzk).toBeCloseTo(678);
  });

  it("preserves missing price, FX, deposits and empty portfolio fallbacks", () => {
    const input = inputFixture();
    const out = computePortfolio({ ...input, prices: {}, snapshots: [] });
    expect(out.totalValue).toBe(900);
    expect(out.totalInvestedCzk).toBeCloseTo(13515.6);
    expect(out.dailyReturn).toBe(0);
    expect(out.netDepositsUsd).toBeNull();
    const empty = computePortfolio({ ...input, positions: [], transactions: [], snapshots: [] });
    expect(empty.totalValue).toBe(0);
    expect(empty.totalReturnPct).toBe(0);
    expect(empty.positions).toEqual([]);
  });

  it("keeps manual CASH deposits separate from trades and paid dividends", () => {
    const input = inputFixture();
    input.transactions.push({ ...input.transactions[0], id: "deposit", ticker: "CASH", shares: 1, price_usd: 1000 });
    const dividend = { id: "dividend", pay_date: null, ticker: "SYN", amount_per_share: 10, shares_held: 1, total_amount_usd: 10, ex_date: "2024-01-02", status: "paid", broker: "manual", ext_id: "synthetic-div" };
    const out = computePortfolio({ ...input, dividends: [dividend] });
    expect(out.netDepositsUsd).toBe(1000);
    expect(out.totalValue).toBe(1500);
    expect(out.totalProfit).toBe(500);
    expect(computePortfolio({ ...input, dividends: [{ ...dividend, broker: "Revolut" }] }).netDepositsUsd).toBe(990);
  });

  it("exposes the original cash and holdings helpers", () => {
    expect(isCashPosition({ ticker: "CASH" })).toBe(true);
    expect(isCashPosition({ ticker: "OTHER", type: "Cash" })).toBe(true);
    expect(summarizeHoldings(portfolioGolden.positions)).toEqual({ value: 1200, invested: 600, profit: 600, profitPct: 100,
      valueCzk: 30000, investedCzk: 12000, profitCzk: 18000, profitPctCzk: 150 });
  });
});

describe("original portfolio hook contract", () => {
  it("captures every returned key and position field before extraction", () => {
    const { result } = renderHook(() => useComputedPortfolio());
    expect(result.current).toEqual({ ...portfolioGolden, loading: false, stale: false, fetchedAt: "2025-01-02T12:00:00Z", error: null });
    expect(result.current.positions.every(p => !("weight" in p))).toBe(true);
  });

  it.each(["positions", "transactions", "live-prices", "daily-snapshots", "broker-summary", "dividends", "deposits"])("waits for %s", key => {
    state.queries[key].isLoading = true;
    expect(renderHook(() => useComputedPortfolio()).result.current.loading).toBe(true);
  });

  it("C3 keeps cached prices and FX usable after a transient query error", () => {
    const error = new Error("synthetic failure");
    state.queries["live-prices"] = { data: createPortfolioFixture().livePrices, error };
    expect(renderHook(() => useComputedPortfolio()).result.current).toMatchObject({ ...portfolioGolden, stale: true, fetchedAt: "2025-01-02T12:00:00Z", error: null });
  });

  it("C3 keeps a price payload error non-blocking when USD/CZK is available", () => {
    state.queries["live-prices"] = { data: { ...createPortfolioFixture().livePrices, prices: {}, error: "provider unavailable" } };
    expect(renderHook(() => useComputedPortfolio()).result.current).toMatchObject({ totalValue: 900, stale: true, error: null });
  });

  it("C3 blocks a failed first price fetch when no USD/CZK is cached", () => {
    state.queries["live-prices"] = { error: new Error("network unavailable") };
    expect(renderHook(() => useComputedPortfolio()).result.current.error).toMatchObject({ message: "USD/CZK unavailable" });
  });

  it.each(["positions", "transactions", "daily-snapshots", "broker-summary", "dividends", "deposits"])("B13 propagates a failed required %s query", (key) => {
    const error = new Error("read rejected");
    state.queries[key] = { error, isLoading: false };
    expect(renderHook(() => useComputedPortfolio()).result.current.error).toBe(error);
  });

  it("B13 reports missing FX as unavailable", () => {
    state.queries["live-prices"] = { data: { ...createPortfolioFixture().livePrices, usdCzk: null } };
    const { result } = renderHook(() => useComputedPortfolio());
    expect(result.current.usdCzk).toBeNaN();
    expect(result.current.error).toMatchObject({ message: "USD/CZK unavailable" });
  });

  it("B12 marks current-rate historical costs as estimated", () => {
    const input = inputFixture();
    input.transactions = input.transactions.map((r) => ({ ...r, executed_at: "1990-01-01" }));
    expect(computePortfolio({ ...input, snapshots: [] }).fxEstimated).toBe(true);
  });

  it.each([["USD", "CZK", 1], ["CZK", "CZK", 1], ["EUR", "EUR", 0.04], ["GBP", "GBP", 0.03], ["PLN", "PLN", 0.16]])("preserves %s view figures", (_display, code, k) => {
    state.fx = { code, perCzkAt: () => k, perCzkToday: k };
    const out = renderHook(() => useComputedPortfolio()).result.current;
    expect(out.totalValue).toBe(1500);
    expect(out.totalInvestedCzk).toBeCloseTo(12000 * Number(k), 10);
    expect(out.unrealizedProfitCzk).toBeCloseTo(18000 * Number(k), 10);
    expect(out.totalProfitCzk).toBeCloseTo(20000 * Number(k), 10);
    expect(out.usdCzk).toBe(25);
    expect(out.usdLocal).toBe(25 * Number(k));
  });
});
