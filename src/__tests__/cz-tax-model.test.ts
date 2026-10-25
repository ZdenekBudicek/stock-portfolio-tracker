import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTaxModel } from "@/hooks/useInsights";
import { createTaxFixture } from "@/test/agentPortfolioFixture";
import { DEFAULT_TAX_SETTINGS } from "@/lib/czTax";
import { computeCzTaxModel, type CzTaxModel } from "@/lib/czTaxModel";
import { createKindResolver, type InstrumentRegistry } from "@/lib/instrumentRegistry";

function originalFields<T extends object>(model: T & { loading?: boolean; error?: unknown }) {
  const { loading, error, ...original } = model;
  return original;
}

function inputFixture() {
  return { ...createTaxFixture(), transactions: state.transactions.data ?? [], positions: state.portfolio.positions,
    registry: { positions: state.positions.data ?? [], ...state.registry.data } as InstrumentRegistry };
}

function comparable(model: CzTaxModel & { loading?: boolean; error?: unknown }) {
  return { ...originalFields(model), kindOf: ["SYN", "LTC", "BTC", "UNKNOWN"].map(t => model.kindOf(t)) };
}

type Fixture = ReturnType<typeof createTaxFixture>;
type Query<T> = { data?: T; isLoading?: boolean; error?: unknown };

const state = vi.hoisted(() => ({ transactions: {} as Query<Fixture["transactions"]>, positions: {} as Query<InstrumentRegistry["positions"]>, portfolio: {} as { positions?: Fixture["positions"]; usdCzk?: number; loading?: boolean; error?: unknown }, registry: {} as Query<Partial<InstrumentRegistry>> }));
vi.mock("@/hooks/usePortfolio", () => ({ useTransactions: () => state.transactions, usePositions: () => state.positions,
  useComputedPortfolio: () => state.portfolio, fetchAllRows: vi.fn(), useLivePrices: vi.fn() }));
vi.mock("@/hooks/useExtras", () => ({ useDividends: vi.fn(), useEarnings: vi.fn(), useWatchlist: vi.fn() }));
vi.mock("@/hooks/useTaxResidence", () => ({ useJurisdiction: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => state.registry }));
vi.mock("@/lib/cnbRates", () => ({ usdCzkFor: (date: string, method: string) => date < "2000-01-01" ? null
  : { rate: method === "gfr-annual" ? 22 : 20, ref: method === "gfr-annual" ? `GFŘ ${date.slice(0, 4)}` : date } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const f = createTaxFixture();
  state.transactions = { data: f.transactions, isLoading: false, error: null };
  state.positions = { data: f.registry.positions, isLoading: false, error: null };
  state.portfolio = { positions: f.positions, usdCzk: f.usdCzk, loading: false, error: null };
  state.registry = { data: { aliases: [], profiles: [] }, isLoading: false, error: null };
});
afterEach(() => vi.useRealTimers());

describe("original Czech tax hook characterization", () => {
  it("captures every field, full report, FIFO, calendar and summary", () => {
    const { result } = renderHook(() => useTaxModel(2026));
    expect(originalFields(result.current)).toMatchSnapshot();
    expect(result.current.report.taxable.gainUsd).toBe(200);
    expect(result.current.fifo.openLots[0].shares).toBe(6);
    expect(result.current.calendar[0].firstDate).toBe("2027-01-03");
  });

  it("captures empty history", () => {
    state.transactions.data = [];
    state.positions.data = [];
    state.portfolio.positions = [];
    expect(originalFields(renderHook(() => useTaxModel(2026)).result.current)).toMatchSnapshot();
  });

  it.each([99999, 100001])("captures the securities limit at %s CZK", proceeds => {
    state.transactions.data[1].price_usd = proceeds / 4 / 20;
    const { result } = renderHook(() => useTaxModel(2026));
    expect(result.current.report).toMatchSnapshot();
    expect(result.current.limitState).toBe(proceeds > 100000 ? "over" : "under");
  });

  it("captures missing purchase FX and unmatched SELL without confirmed exemption", () => {
    state.transactions.data[0].executed_at = "1990-01-02";
    state.transactions.data.push({ ...state.transactions.data[1], id: "unmatched", ticker: "MISSING" });
    const { result } = renderHook(() => useTaxModel(2026));
    expect(originalFields(result.current)).toMatchSnapshot();
    expect(result.current.report.complete).toBe(false);
    expect(result.current.limitState).toBe("unknown");
    expect(result.current.overallState).toBe("unknown");
  });

  // Audit B11: the old "exclude exempt income" setting no longer changes the value test.
  it.each(["cnb-daily", "gfr-annual"] as const)("captures %s with the exempt-income setting ignored by the limit", fxMethod => {
    state.transactions.data[0].executed_at = "2020-01-02";
    state.transactions.data[1].price_usd = 2000;
    const { result } = renderHook(() => useTaxModel(2026, { ...DEFAULT_TAX_SETTINGS, fxMethod, limitIncludesExempt: false }));
    expect(originalFields(result.current)).toMatchSnapshot();
    expect(result.current.limitState).toBe("over");
  });
});

describe("shared Czech tax model", () => {
  it("matches the entire hook contract and does not mutate inputs", () => {
    const input = inputFixture();
    const before = structuredClone(input);
    expect(comparable(computeCzTaxModel(input))).toEqual(comparable(renderHook(() => useTaxModel(2026)).result.current));
    expect(input).toEqual(before);
  });

  it.each([99999, 100001])("preserves the complete securities report at %s CZK", proceeds => {
    state.transactions.data[1].price_usd = proceeds / 4 / 20;
    const out = computeCzTaxModel(inputFixture());
    expect(comparable(out)).toEqual(comparable(renderHook(() => useTaxModel(2026)).result.current));
    expect(out.limitState).toBe(proceeds > 100000 ? "over" : "under");
  });

  it.each(["2024-02-14", "2025-02-14", "2025-02-15", "2026-02-15"])("retains separate crypto limits and rule boundary on %s", date => {
    const input = inputFixture();
    input.year = Number(date.slice(0, 4));
    input.transactions = [
      { ...input.transactions[0], executed_at: "2023-01-02", shares: 10 },
      { ...input.transactions[1], executed_at: date, shares: 10, price_usd: 499.995 },
      { ...input.transactions[0], id: "coin-buy", ticker: "BTC", executed_at: "2023-01-02", shares: 10 },
      { ...input.transactions[1], id: "coin-sell", ticker: "BTC", executed_at: date, shares: 10, price_usd: 500.005 },
    ];
    const out = computeCzTaxModel(input);
    expect(out.limitState).toBe("under");
    expect(out.cryptoLimitState).toBe(date < "2025-02-15" ? "none" : "over");
    expect(out.report.crypto.noExemption.proceedsCzk).toBe(date < "2025-02-15" ? 100001 : 0);
    expect(out.report.cap.kinds).toEqual(input.year < 2025 ? [] : input.year === 2025 ? ["security", "crypto"] : ["crypto"]);
    state.transactions.data = input.transactions;
    expect(out.report).toEqual(renderHook(() => useTaxModel(input.year)).result.current.report);
  });

  it("keeps missing FX and unmatched warnings in the full report", () => {
    state.transactions.data[0].executed_at = "1990-01-02";
    state.transactions.data.push({ ...state.transactions.data[1], id: "unmatched", ticker: "MISSING" });
    const out = computeCzTaxModel(inputFixture());
    expect(comparable(out)).toEqual(comparable(renderHook(() => useTaxModel(2026)).result.current));
    expect(out.fifo.warnings[0].kind).toBe("unmatched-sell");
    expect(out.report.missingFx).toEqual(["1990-01-02"]);
    expect(out.report.rows[0].costCzk).toBeNull();
    expect(out.report.complete).toBe(false);
    expect(out.report.underLimit).toBe(false);
    expect(out.overallState).toBe("unknown");
  });

  it("keeps unheld lots only in allLots and excludes unpriceable held lots", () => {
    const input = inputFixture();
    input.transactions.push({ ...input.transactions[0], ticker: "UNHELD", id: "unheld" });
    input.positions[0].currentPrice = NaN;
    const out = computeCzTaxModel(input);
    expect(out.allLots.map(l => l.ticker)).toEqual(["SYN", "UNHELD"]);
    expect(out.lots).toEqual([]);
    expect(out.calendar).toEqual([]);
    expect(out.summary.exemptLots).toBe(0);
  });

  it.each(["positions", "aliases", "profiles"] as const)("recognizes sold LTC as a security through %s", source => {
    const input = inputFixture();
    input.transactions = input.transactions.map(t => ({ ...t, ticker: "LTC", shares: 10 }));
    input.positions = [];
    input.registry = { positions: [], aliases: [], profiles: [] };
    if (source === "positions") input.registry.positions = [{ ...createTaxFixture().registry.positions[0], ticker: "LTC", type: "ETF", shares: 0 }];
    if (source === "aliases") input.registry.aliases = [{ alias: "LTC", canonical: "SYN-ETF", yahoo_symbol: "SYN-ETF.L" }];
    if (source === "profiles") input.registry.profiles = [{ ticker: "LTC", asset_type: "ETF" }];
    expect(createKindResolver(input.registry)("LTC").kind).toBe("security");
    const out = computeCzTaxModel(input);
    expect(out.report.rows[0].assetKind).toBe("security");
    expect(out.report.crypto.rowCount).toBe(0);
    expect(out.report.complete).toBe(true);
  });

  it.each([true, false])("preserves both FX methods and limitIncludesExempt=%s independently of EUR display", limitIncludesExempt => {
    state.transactions.data[0].executed_at = "2020-01-02";
    state.transactions.data[1].price_usd = 2000;
    for (const fxMethod of ["cnb-daily", "gfr-annual"] as const) {
      const settings = { fxMethod, limitIncludesExempt };
      const input = { ...inputFixture(), settings };
      input.positions = input.positions.map(p => ({ ...p, valueCzk: p.valueCzk / 25, investedCzk: p.investedCzk / 25 }));
      const out = computeCzTaxModel(input);
      expect(out.report).toEqual(renderHook(() => useTaxModel(2026, settings)).result.current.report);
      expect(out.report.proceedsCzk).toBe(8000 * (fxMethod === "cnb-daily" ? 20 : 22));
      // Audit B11: exempt proceeds always count towards the 100 000 Kč test.
      expect(out.limitState).toBe("over");
    }
  });

  it("uses the injected date for lot exemption even when the wall clock differs", () => {
    const input = inputFixture();
    vi.setSystemTime(new Date("2040-01-01T12:00:00Z"));
    expect(computeCzTaxModel(input).lots[0].exempt).toBe(false);
    expect(computeCzTaxModel({ ...input, today: "2027-01-03" }).lots[0].exempt).toBe(true);
  });

  it.each(["transactions", "positions", "registry", "portfolio"] as const)("exposes %s failure without declaring empty history exempt", dependency => {
    const error = new Error("Synthetic query failed");
    state[dependency] = { ...state[dependency], data: undefined, error };
    const out = renderHook(() => useTaxModel(2026)).result.current;
    expect(out.error).toBe(error);
    expect(out.report.complete).toBe(false);
    expect(out.report.underLimit).toBe(false);
    expect(out.limitState).toBe("unknown");
    expect(out.overallState).toBe("unknown");
  });

  it.each(["transactions", "positions", "registry", "portfolio"] as const)("exposes pending %s and recovers", dependency => {
    const ready = state[dependency];
    Object.assign(state, { [dependency]: { ...ready, isLoading: true, loading: true } });
    const { result, rerender } = renderHook(() => useTaxModel(2026));
    expect(result.current.loading).toBe(true);
    expect(result.current.report.complete).toBe(false);
    Object.assign(state, { [dependency]: ready });
    rerender();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.report.complete).toBe(true);
  });
});
