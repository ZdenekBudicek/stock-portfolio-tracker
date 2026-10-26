// @vitest-environment node
import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { fetchAllRows, fetchRowsBySymbols } from "../../supabase/functions/_shared/price-providers";
import { parseFinnhubSplits } from "../../supabase/functions/detect-splits/parse";
import { t212AccountGuard } from "../../supabase/functions/_shared/t212-account";
import { syncCashFromApi, prepareReconcileHoldings, loadT212AccountTrades, planT212Append } from "../../supabase/functions/_shared/t212";

type Row = Record<string, unknown>;
function database(tables: Record<string, Row[]>, failedUsers: string[] = [], keys: Row[] = []) {
  const ranges: [string, number, number][] = [], writes: [string, unknown][] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "fixture-user" } } }) },
    functions: { invoke: async () => ({ data: {}, error: null }) },
    rpc: async () => ({ data: keys, error: null }),
    from(table: string) {
      const query = {
        select: () => query, order: () => query, neq: () => query, eq: () => query, in: () => query, is: () => query, not: () => query,
        update: (row: Row) => { writes.push([table, row]); return query; },
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
        maybeSingle: async () => ({ data: tables[table]?.[0] ?? null, error: null }),
        range: async (from: number, to: number) => {
          ranges.push([table, from, to]);
          return { data: (tables[table] ?? []).slice(from, to + 1), error: null };
        },
        upsert: async (rows: Row | Row[]) => {
          writes.push([table, rows]);
          return { error: !Array.isArray(rows) && failedUsers.includes(String(rows.user_id)) ? { message: "write rejected" } : null };
        },
      };
      return query;
    },
  };
  return { client, ranges, writes };
}

// Execute the actual handler with local ports; no credentials, provider calls or database access.
function handler(name: string, client: ReturnType<typeof database>["client"], fetchImpl = vi.fn(async (_url: string) => new Response("{}"))) {
  let serve: (req: Request) => Promise<Response>;
  const source = transpileModule(readFileSync(`supabase/functions/${name}/index.ts`, "utf8"), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText.replace(/^import .*;$/gm, "").replace(/^export \{\};$/gm, "");
  const ports = {
    Deno: { env: { get: () => "fixture" }, serve: (fn: typeof serve) => { serve = fn; } },
    createClient: () => client, fetchAllRows, fetchRowsBySymbols, parseFinnhubSplits, t212AccountGuard,
    syncCashFromApi, prepareReconcileHoldings, loadT212AccountTrades, planT212Append,
    isSchedulerToken: () => true, isCryptoTicker: () => false, fetch: fetchImpl,
    setTimeout: (fn: () => void) => { fn(); },
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  new Function(...Object.keys(ports), source)(...Object.values(ports));
  return (body: Row = {}) => serve(new Request("http://localhost", { method: "POST", body: JSON.stringify(body), headers: { Authorization: "Bearer fixture" } }));
}

describe("R6 snapshot write outcomes", () => {
  it.each([
    [[], 200, "success", 2, 0], [["B"], 500, "partial", 1, 1], [["A", "B"], 500, "failed", 0, 2],
  ] as const)("reports failures for %j", async (failed, http, status, count, failures) => {
    const db = database({ positions: ["A", "B"].map(user_id => ({ user_id, type: "Stock", ticker: "AAPL", shares: 2, avg_cost_usd: 5 })),
      price_cache: [{ symbol: "AAPL", price: 10 }, { symbol: "USDCZK", price: 22 }] }, [...failed]);
    const response = await handler("daily-snapshot-cron", db.client)();
    expect(response.status).toBe(http);
    expect(await response.json()).toMatchObject({ success: http === 200, status, count, failed: failures });
    expect(db.writes).toHaveLength(2);
  });
});

it("R6 pages both split inputs beyond 1000 and does not insert an existing split from page two", async () => {
  const db = database({ positions: Array.from({ length: 1001 }, (_, i) => ({ ticker: "AAPL", user_id: String(i) })),
    splits: Array.from({ length: 1001 }, (_, i) => ({ ticker: "AAPL", user_id: String(i), split_date: "2026-10-25" })) });
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ date: "2026-10-25", fromFactor: 1, toFactor: 4 }])));
  const response = await handler("detect-splits", db.client, fetchImpl)();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ detected: 0, tickers_checked: 1 });
  expect(db.ranges).toContainEqual(["positions", 1000, 1999]);
  expect(db.ranges).toContainEqual(["splits", 1000, 1999]);
  expect(db.writes).toHaveLength(0);
});

it("R6 enumerates all broker connections and keeps the per-account budget checks", async () => {
  const db = database({ broker_connections: Array.from({ length: 1001 }, (_, i) => ({ user_id: String(i), environment: "live" })) });
  const response = await handler("auto-sync", db.client)();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ users: 1001, skipped: 1001 });
  expect(db.ranges).toContainEqual(["broker_connections", 1000, 1999]);
  const source = readFileSync("supabase/functions/auto-sync/index.ts", "utf8");
  expect(source).toContain('Date.now() - started > ACCOUNTS_BUDGET_MS');
  expect(source).toContain('Date.now() - started < APPEND_BUDGET_MS');
  expect(source).toContain('.order("user_id").range(from, to)');
});

describe("R4 live account guard", () => {
  it.each(["sync-broker", "auto-sync"])("%s uses the key prefix on a throttled first sync and preserves a stored id", async name => {
    for (const stored of [null, "456"]) {
      const expected = stored ?? "123";
      const db = database({ broker_connections: [{ id: "connection", user_id: "fixture-user", environment: "live", account_id: stored }] }, [],
        [{ api_key: "123-secret", environment: "live", last_sync_cursor: null }]);
      const fetchImpl = vi.fn(async (url: string) => url.endsWith("/info") ? new Response("", { status: 429 })
        : new Response(JSON.stringify(url.endsWith("/portfolio") ? [] : { free: 12 })));
      const response = await handler(name, db.client, fetchImpl)({ test: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(name === "sync-broker" ? { ok: true, account: expected } : { synced: 1, failed: 0, skipped: 0 });
      expect(db.writes).toContainEqual(["broker_connections", expect.objectContaining({ account_id: expected, account_summary: expect.objectContaining({ account: expected }) })]);
      expect(db.writes.some(([, row]) => (row as Row).account_id === "123" && stored !== null)).toBe(false);
    }
  });
  it.each(["sync-broker", "auto-sync"])("%s still refuses an unknown account when the key has no prefix", async name => {
    const db = database({ broker_connections: [{ user_id: "fixture-user", environment: "live", account_id: null }] }, [],
      [{ api_key: "no-prefix", environment: "live", last_sync_cursor: null }]);
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/info") ? new Response("", { status: 429 }) : new Response('{"free":12}'));
    const response = await handler(name, db.client, fetchImpl)({ test: true });
    expect(await response.json()).toMatchObject(name === "sync-broker" ? { code: "account_unknown" } : { skipped: 1 });
    expect(db.writes).toEqual([]);
  });
  it.each(["sync-broker", "auto-sync"])("%s never fetches or writes practice data", async name => {
    const db = database({ broker_connections: [{ user_id: "fixture-user", environment: "demo", account_id: "A" }] }, [],
      [{ api_key: "fixture", environment: "demo", last_sync_cursor: "old" }]);
    const fetchImpl = vi.fn(async (_url: string) => new Response("{}"));
    const response = await handler(name, db.client, fetchImpl)();
    const body = await response.json();
    expect(name === "sync-broker" ? body.code : body.skipped).toBe(name === "sync-broker" ? "practice_account" : 1);
    expect(db.writes).toEqual([]);
    // auto-sync may still refresh shared sectors after the account loop.
    expect(fetchImpl.mock.calls.every(call => !String(call[0]).includes("trading212.com"))).toBe(true);
  });
  it.each(["sync-broker", "auto-sync"])("%s refuses a changed account before any write", async name => {
    const db = database({ broker_connections: [{ user_id: "fixture-user", environment: "live", account_id: "A", account_summary: { currency: "USD" } }] }, [],
      [{ api_key: "123-secret", environment: "live", last_sync_cursor: "old" }]);
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/info") ? { id: "B", currencyCode: "USD" } : { free: 12 })));
    const response = await handler(name, db.client, fetchImpl)();
    expect(await response.json()).toMatchObject(name === "sync-broker" ? { code: "account_changed", account: "B" } : { skipped: 1 });
    expect(db.writes).toEqual([]);
  });
  it("blocks every practice sync, even after confirmation or with the same account id", () => {
    expect(t212AccountGuard("demo", "A", "A", "A")).toBe("practice_account");
    expect(t212AccountGuard("demo", null, "B", "B")).toBe("practice_account");
  });
  it("fails closed on unknown accounts and requires the exact new live id", () => {
    expect(t212AccountGuard("live", "A", null)).toBe("account_unknown");
    expect(t212AccountGuard("live", "A", "B")).toBe("account_changed");
    expect(t212AccountGuard("live", "A", "B", "A")).toBe("account_changed");
    expect(t212AccountGuard("live", "A", "B", "B")).toBeNull();
    expect(t212AccountGuard("live", "A", "A")).toBeNull();
    expect(t212AccountGuard("live", null, "A")).toBeNull();
  });
  it("resets state on credential/environment/account changes with caller-only RPC access", () => {
    const sql = readFileSync("supabase/migrations/20261027100000_broker_account_reset.sql", "utf8");
    expect(sql).toContain("uid uuid := auth.uid()");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("from public, anon");
    expect(sql).toContain("new.environment is distinct from old.environment");
    expect(sql).toContain("new.account_id is distinct from old.account_id");
    for (const field of ["last_sync_cursor", "last_sync_at", "account_summary", "cash_base_free_usd", "cash_sync_state"]) {
      expect(sql).toContain(`${field} = null`);
      expect(sql).toContain(`new.${field} := null`);
    }
    expect(sql).not.toMatch(/delete from|truncate/i);
  });
  it.each(["sync-broker", "auto-sync"])("%s checks the account before its first account-summary write", name => {
    const source = readFileSync(`supabase/functions/${name}/index.ts`, "utf8");
    expect(source.indexOf("const guard = t212AccountGuard")).toBeLessThan(source.indexOf("update({ account_summary"));
    expect(source.indexOf('!== "live"')).toBeLessThan(source.indexOf('await t212("/equity/account/cash")'));
  });
});
