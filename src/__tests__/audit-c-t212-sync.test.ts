import type { T212Client } from "../../supabase/functions/_shared/t212-types";
import { describe, it, expect, vi } from "vitest";
import {
  t212NextPage, rateNear, reconcileAvgUsd, tickersLinked, applyRenameGuard, isMissingRpc, syncCashFromApi,
  prepareReconcileHoldings,
} from "../../supabase/functions/_shared/t212";

// Minimal PostgREST-like mock: every builder method chains, awaiting yields `result(table, calls)`.
type Res = { data?: unknown; error?: { message?: string; code?: string } };
function mockSvc(opts: { tables?: (table: string, calls: [string, unknown[]][]) => Res; rpc?: (fn: string, args: Record<string, unknown>) => Res }) {
  const rpcCalls: [string, Record<string, unknown>][] = [];
  const updates: [string, Record<string, unknown>][] = [];
  const from = (table: string) => {
    const calls: [string, unknown[]][] = [];
    const b: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          const r = opts.tables?.(table, calls) ?? { data: null, error: null };
          return (ok: (value: Res) => unknown, ko: (reason: unknown) => unknown) => Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(ok, ko);
        }
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          if (prop === "update") updates.push([table, args[0] as Record<string, unknown>]);
          return b;
        };
      },
    });
    return b;
  };
  const svc = {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push([fn, args]);
      const r = opts.rpc?.(fn, args) ?? { data: null, error: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { svc: svc as unknown as T212Client, rpcCalls, updates };
}

describe("t212NextPage (finding 18)", () => {
  it("strips the /api/v0 prefix of the documented nextPagePath", () => {
    expect(t212NextPage("/api/v0/equity/history/dividends?limit=50&cursor=1760346100000", "/equity/history/dividends"))
      .toBe("/equity/history/dividends?limit=50&cursor=1760346100000");
  });
  it("keeps a path without the prefix and wraps a bare query string", () => {
    expect(t212NextPage("/equity/history/transactions?cursor=x", "/equity/history/transactions")).toBe("/equity/history/transactions?cursor=x");
    expect(t212NextPage("limit=50&cursor=7", "/equity/history/dividends")).toBe("/equity/history/dividends?limit=50&cursor=7");
  });
  it("ends paging on a missing/empty nextPagePath", () => {
    expect(t212NextPage(null, "/x")).toBeNull();
    expect(t212NextPage("", "/x")).toBeNull();
  });
});

describe("rateNear (finding 19)", () => {
  const fx = [{ date: "2024-01-02", close: 22.5 }, { date: "2024-01-03", close: 22.7 }, { date: "2026-10-16", close: 20.9 }];
  it("uses the rate of the flow's own day (or the last before it), not today's", () => {
    expect(rateNear(fx, "2024-01-03")).toBe(22.7);
    expect(rateNear(fx, "2024-06-01")).toBeNull();
    expect(rateNear(fx, "2026-10-19")).toBe(20.9);
  });
  it("does not use a future rate", () => {
    expect(rateNear(fx, "2023-12-01")).toBeNull();
  });
  it("returns null without any usable rate", () => {
    expect(rateNear([], "2024-01-01")).toBeNull();
    expect(rateNear([{ date: "2024-01-01", close: 0 }], "2024-01-01")).toBeNull();
  });
});

describe("reconcileAvgUsd (finding 9)", () => {
  it("scales the native average onto the USD price", () => {
    expect(reconcileAvgUsd({ ticker: "BARC", qty: 1, avg: 200, cur: 400 }, 5)).toBe(2.5);
  });
  it("never stores 400 GBX as $400 when the USD quote is missing", () => {
    expect(reconcileAvgUsd({ ticker: "BARC", qty: 1, avg: 400, cur: 410 }, undefined)).toBeNull();
    expect(reconcileAvgUsd({ ticker: "BARC", qty: 1, avg: 400, cur: 0 }, 5)).toBeNull();
  });
  it("keeps the broker average for a USD-quoted (_US_EQ) instrument", () => {
    expect(reconcileAvgUsd({ ticker: "AAPL", qty: 1, avg: 180, cur: 0, usdQuoted: true }, undefined)).toBe(180);
  });
});

describe("rename guard (finding 7)", () => {
  it("does NOT relabel MSFT as AAPL just because the share counts match", () => {
    const net = new Map([["AAPL", 10]]); // sell of AAPL not stored yet
    const out = applyRenameGuard([{ ticker: "MSFT", qty: 10 }], net, (a, b) => tickersLinked(a, b, []));
    expect(out).toEqual([{ ticker: "MSFT", qty: 10 }]);
  });
  it("relabels the T212 LSE form BARCL to the trades' BARC", () => {
    const out = applyRenameGuard([{ ticker: "BARCL", qty: 100 }], new Map([["BARC", 100]]), (a, b) => tickersLinked(a, b, []));
    expect(out[0].ticker).toBe("BARC");
  });
  it("relabels when ticker_alias links them (alias row or shared ISIN)", () => {
    const viaAlias = [{ alias: "AGC", canonical: "GRAB", isin: null }];
    expect(applyRenameGuard([{ ticker: "AGC", qty: 50 }], new Map([["GRAB", 50]]), (a, b) => tickersLinked(a, b, viaAlias))[0].ticker).toBe("GRAB");
    const viaIsin = [{ alias: "OLD", canonical: "OLD", isin: "KYG4124C1096" }, { alias: "NEW", canonical: "NEW", isin: "kyg4124c1096" }];
    expect(tickersLinked("OLD", "NEW", viaIsin)).toBe(true);
  });
  it("requires equal quantity even when linked", () => {
    const out = applyRenameGuard([{ ticker: "BARCL", qty: 90 }], new Map([["BARC", 100]]), () => true);
    expect(out[0].ticker).toBe("BARCL");
  });
});

describe("prepareReconcileHoldings", () => {
  it("prices from price_cache, falls back to the position's cost, applies the linked guard only", async () => {
    const { svc } = mockSvc({
      tables: (t, calls) => {
        if (t === "price_cache") return { data: [{ symbol: "BARC", price: 5 }] };
        if (t === "transactions") return { data: [{ ticker: "BARC", side: "BUY", shares: 100 }, { ticker: "AAPL", side: "BUY", shares: 10 }] };
        if (t === "ticker_alias") return { data: [] };
        if (t === "positions") {
          expect(calls.find(([m]) => m === "in")?.[1][1]).toEqual(["VUSA"]);
          return { data: [{ ticker: "VUSA", avg_cost_usd: 99 }] };
        }
        return { data: [] };
      },
    });
    const out = await prepareReconcileHoldings(svc, "u", "acc", [
      { ticker: "BARCL", qty: 100, avg: 200, cur: 400 },  // LSE form of BARC → relabelled
      { ticker: "MSFT", qty: 10, avg: 400, cur: 410, usdQuoted: true }, // NOT relabelled to AAPL
      { ticker: "VUSA", qty: 3, avg: 9000, cur: 9100 },  // no USD quote → position cost
    ]);
    expect(out).toEqual([
      { ticker: "BARC", qty: 100, avg: 2.5 }, // priced under the relabelled ticker: 5 × 200/400
      { ticker: "MSFT", qty: 10, avg: 400 },
      { ticker: "VUSA", qty: 3, avg: 99 },
    ]);
  });
  it("throws on a failed read instead of reconciling against a guess", async () => {
    const { svc } = mockSvc({ tables: (t) => (t === "transactions" ? { error: { message: "boom" } } : { data: [] }) });
    await expect(prepareReconcileHoldings(svc, "u", "acc", [{ ticker: "X", qty: 1, avg: 1 }])).rejects.toThrow(/boom/);
  });
});

describe("syncCashFromApi (findings 5 + 21)", () => {
  it("uses the single locked RPC and nothing else when it exists", async () => {
    const { svc, rpcCalls, updates } = mockSvc({});
    await syncCashFromApi(svc, "u", { free: 100, currency: "USD" });
    expect(rpcCalls).toEqual([["sync_t212_cash", { p_user_id: "u", p_free_usd: 100 }]]);
    expect(updates).toEqual([]);
  });
  it("falls back to the old path when the RPC is not deployed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { svc, rpcCalls, updates } = mockSvc({
      rpc: (fn) => (fn === "sync_t212_cash" ? { error: { code: "PGRST202", message: "Could not find the function" } } : {}),
      tables: (t) => (t === "broker_connections" ? { data: { cash_base_free_usd: 80 } } : { data: null }),
    });
    await syncCashFromApi(svc, "u", { free: 100, currency: "USD" });
    expect(rpcCalls[1]).toEqual(["apply_cash_delta", { p_user_id: "u", p_delta: 20 }]);
    expect(updates).toEqual([["broker_connections", { cash_base_free_usd: 100 }]]);
    warn.mockRestore();
  });
  it("throws and leaves the base alone when the delta could not be applied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { svc, updates } = mockSvc({
      rpc: (fn) => (fn === "sync_t212_cash" ? { error: { code: "PGRST202" } } : { error: { message: "denied" } }),
      tables: (t) => (t === "broker_connections" ? { data: { cash_base_free_usd: 80 } } : { data: null }),
    });
    await expect(syncCashFromApi(svc, "u", { free: 100, currency: "USD" })).rejects.toThrow(/apply_cash_delta failed/);
    expect(updates).toEqual([]);
    warn.mockRestore();
  });
  it("throws on a failed cash-base read instead of re-adopting the API value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { svc, rpcCalls } = mockSvc({
      rpc: () => ({ error: { code: "42883" } }),
      tables: (t) => (t === "broker_connections" ? { error: { message: "column cash_base_free_usd does not exist" } } : { data: null }),
    });
    await expect(syncCashFromApi(svc, "u", { free: 100, currency: "USD" })).rejects.toThrow(/cash base read failed/);
    expect(rpcCalls.map(([f]) => f)).toEqual(["sync_t212_cash"]);
    warn.mockRestore();
  });
  it("surfaces other RPC errors", async () => {
    const { svc } = mockSvc({ rpc: () => ({ error: { code: "P0001", message: "lock timeout" } }) });
    await expect(syncCashFromApi(svc, "u", { free: 1, currency: "USD" })).rejects.toThrow(/lock timeout/);
  });
  it("never touches cash for an unknown currency", async () => {
    const { svc, rpcCalls } = mockSvc({});
    await syncCashFromApi(svc, "u", { free: 100, currency: null });
    expect(rpcCalls).toEqual([]);
  });
  it("isMissingRpc recognises PostgREST and Postgres 'no such function'", () => {
    expect(isMissingRpc({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpc({ code: "42883" })).toBe(true);
    expect(isMissingRpc({ message: "Could not find the function public.sync_t212_cash" })).toBe(true);
    expect(isMissingRpc({ code: "P0001", message: "x" })).toBe(false);
    expect(isMissingRpc(null)).toBe(false);
  });
});
