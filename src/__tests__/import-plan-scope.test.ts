// Regression: a statement re-import must never reconcile against a scope that does not
// cover the rows the portfolio already counts. Getting this wrong doubled every Revolut
// position — the account-scoped reconcile could not see the pre-scoping (account-less)
// rows, decided the account was empty, and bought the whole snapshot on top.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let TX: Row[] = [];

// pdfjs only matters for reading files; importing it under jsdom needs canvas globals.
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(null) }) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

// Minimal PostgREST stand-in: enough of the builder chain for planImport's reads.
vi.mock("@/integrations/supabase/client", () => {
  const table = (rows: () => Row[]) => {
    const q = {
      select: () => q,
      eq: () => q,
      like: () => q,
      is: () => q,
      not: () => q,
      range: (from: number, to: number) => Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
      // No .range() => PostgREST's db-max-rows cap. Modelling it is the point of the
      // pagination test: without it an unpaged read looks like it returns everything.
      then: (res) => Promise.resolve({ data: rows().slice(0, 1000), error: null }).then(res),
    };
    return q;
  };
  return {
    supabase: {
      from: (name: string) => table(() => (name === "transactions" ? TX : [])),
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      rpc: async () => ({ data: 0, error: null }),
    },
  };
});

const { planImport } = await import("@/lib/statementImport");

const parsed = (rows: unknown[], holdings: unknown[], account?: string) => ({
  broker: "Revolut" as const, account, mode: "trades" as const, rows, holdings,
});
const trade = (o: Row = {}) => ({
  external_id: "revolut:x:trade", broker: "Revolut", kind: "TRADE", ticker: "RKLB",
  side: "BUY", shares: 59.95612322, price_usd: 40, executed_at: "2026-07-22T00:00:00.000Z",
  label: "", ...o,
});
const holding = (o: Row = {}) => ({
  external_id: "revolut:pos:RKLB", broker: "Revolut", kind: "HOLDING", ticker: "RKLB",
  shares: 59.95612322, price_usd: 69.12, executed_at: "2026-07-22T00:00:00.000Z", label: "", ...o,
});

beforeEach(() => { TX = []; });

describe("planImport account scope", () => {
  it("refuses to reconcile while rows of this broker have no account yet and another account exists", async () => {
    TX = [
      { id: "1", ticker: "RKLB", side: "BUY", shares: 59.95612322, executed_at: "2026-05-01T00:00:00+00:00", broker: "Revolut", broker_account: null, ext_id: "revolut:old:trade" },
      { id: "2", ticker: "NU", side: "BUY", shares: 10, executed_at: "2026-05-01T00:00:00+00:00", broker: "Revolut", broker_account: "99999999", ext_id: "revolut:other:trade" },
    ];
    const plan = await planImport(parsed([trade()], [holding()], "12345678") as import("@/lib/statementImport").ParsedStatement);
    expect(plan.legacyUnassigned).toBe(1);
    expect(plan.adoptLegacy).toBe(false);     // ambiguous — cannot claim them
    expect(plan.reconcileTo).toHaveLength(0); // …so no reconciliation at all
    expect(plan.blockedReconcile).toBe(true);
  });

  it("claims the account-less rows when this broker has only one account, then reconciles", async () => {
    TX = [
      { id: "1", ticker: "RKLB", side: "BUY", shares: 59.95612322, executed_at: "2026-05-01T00:00:00+00:00", broker: "Revolut", broker_account: null, ext_id: "revolut:old:trade" },
    ];
    const plan = await planImport(parsed([trade()], [holding()], "12345678") as import("@/lib/statementImport").ParsedStatement);
    expect(plan.adoptLegacy).toBe(true);
    expect(plan.reconcileTo).toHaveLength(1);
    expect(plan.blockedReconcile).toBe(false);
  });

  it("reconciles normally once every row already carries the account", async () => {
    TX = [
      { id: "1", ticker: "RKLB", side: "BUY", shares: 59.95612322, executed_at: "2026-05-01T00:00:00+00:00", broker: "Revolut", broker_account: "12345678", ext_id: "revolut:old:trade" },
    ];
    const plan = await planImport(parsed([trade()], [holding()], "12345678") as import("@/lib/statementImport").ParsedStatement);
    expect(plan.legacyUnassigned).toBe(0);
    expect(plan.adoptLegacy).toBe(false);
    expect(plan.reconcileTo).toHaveLength(1);
  });

  it("skips a statement that is older than what the account already has", async () => {
    TX = [
      { id: "1", ticker: "RKLB", side: "BUY", shares: 1, executed_at: "2026-12-01T00:00:00+00:00", broker: "Revolut", broker_account: "12345678", ext_id: "revolut:newer:trade" },
    ];
    const plan = await planImport(parsed([trade()], [holding()], "12345678") as import("@/lib/statementImport").ParsedStatement);
    expect(plan.reconcileTo).toHaveLength(0);
  });

  it("de-duplicates trades found beyond the first PostgREST page", async () => {
    // 1200 unrelated rows push the Revolut trade past the 1000-row cap. An unpaged read
    // missed it, so an already-imported trade looked new.
    TX = Array.from({ length: 1200 }, (_, i) => ({ id: `t${i}`, ticker: "NU", side: "BUY", shares: 1, executed_at: "2026-01-01T00:00:00+00:00", broker: "T212", broker_account: "1234567", ext_id: `t212:act:${i}` }));
    TX.push({ id: "rev", ticker: "RKLB", side: "BUY", shares: 59.95612322, executed_at: "2026-05-01T00:00:00+00:00", broker: "Revolut", broker_account: "12345678", ext_id: "revolut:x:trade" });
    const plan = await planImport(parsed([trade()], [], "12345678") as import("@/lib/statementImport").ParsedStatement);
    expect(plan.alreadyImported).toBe(1);
    expect(plan.toInsertTrades).toHaveLength(0);
  });
});
