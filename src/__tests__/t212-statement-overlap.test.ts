// Regression: importing a T212 statement after an API sync lost every trade in the overlap.
//
// The duplicate guard counted the API fills (t212:ord:*) as "already stored", so the same
// trades in the statement were skipped — and executeImport then deleted all t212:ord:* rows
// of the account. Neither copy survived. Rows the import is about to delete must not count
// as stored, and API fills after the statement's last day are not the statement's to delete.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFillsReplacedBefore, replacedByStatement, createDuplicateGuard, type ExistingTx } from "@/lib/statementDedup";

type Row = Record<string, unknown>;
let TX: Row[] = [];

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(null) }) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@/integrations/supabase/client", () => {
  const table = (rows: () => Row[]) => {
    const q: any = {
      select: () => q, eq: () => q, like: () => q, is: () => q, not: () => q,
      range: (from: number, to: number) => Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
      then: (res: any) => Promise.resolve({ data: rows().slice(0, 1000), error: null }).then(res),
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

const ACCOUNT = "111";
let seq = 0;
/** A trade as the T212 statement parser emits it: the day at noon UTC. */
const stmt = (day: string, ticker: string, o: Row = {}) => ({
  external_id: `t212:act:${day}:${ticker}`, broker: "T212", account: ACCOUNT, kind: "TRADE", ticker,
  side: "BUY", shares: 2, price_usd: 50, executed_at: `${day}T12:00:00.000Z`, label: "", ...o,
});
/** A stored row as planImport reads it back from the database. */
const db = (ext: string, at: string, ticker: string, o: Row = {}): ExistingTx => ({
  id: String(++seq), ticker, side: "BUY", shares: 2, executed_at: at, broker: "T212",
  broker_account: ACCOUNT, t212_id: null, ext_id: ext, ...o,
} as ExistingTx);
const parsed = (rows: Row[], holdings: Row[] = []) => ({ broker: "T212" as const, account: ACCOUNT, mode: "trades" as const, rows, holdings });

beforeEach(() => { TX = []; seq = 0; });

describe("apiFillsReplacedBefore", () => {
  it("is the start of the UTC day after the statement's last row", () => {
    expect(apiFillsReplacedBefore([stmt("2026-04-02", "A"), stmt("2026-06-30", "B")])).toBe("2026-07-01T00:00:00.000Z");
  });
  it("is null for an empty statement — nothing to replace", () => {
    expect(apiFillsReplacedBefore([])).toBeNull();
  });
});

describe("replacedByStatement", () => {
  const scope = { broker: "T212", account: ACCOUNT, adoptLegacy: false, replaceApiFillsBefore: "2026-07-01T00:00:00.000Z" };
  it("covers this account's API fills up to the statement's last day", () => {
    expect(replacedByStatement(db("t212:ord:1", "2026-06-30T15:00:00+00:00", "A"), scope)).toBe(true);
    expect(replacedByStatement(db("t212:ord:2", "2026-07-01T00:00:00+00:00", "A"), scope)).toBe(false);
  });
  it("never covers statement rows, adjustments, another account or another broker", () => {
    expect(replacedByStatement(db("t212:act:1", "2026-05-01T12:00:00+00:00", "A"), scope)).toBe(false);
    expect(replacedByStatement(db("t212:adj:111:A", "2026-05-01T12:00:00+00:00", "A"), scope)).toBe(false);
    expect(replacedByStatement(db("t212:ord:3", "2026-05-01T15:00:00+00:00", "A", { broker_account: "222" }), scope)).toBe(false);
    expect(replacedByStatement(db("revolut:x", "2026-05-01T15:00:00+00:00", "A", { broker: "Revolut" }), { ...scope, broker: "Revolut" })).toBe(false);
  });
  it("covers account-less API fills only when the import adopts them for this account", () => {
    const legacy = db("t212:ord:4", "2026-05-01T15:00:00+00:00", "A", { broker_account: null });
    expect(replacedByStatement(legacy, scope)).toBe(false);
    expect(replacedByStatement(legacy, { ...scope, adoptLegacy: true })).toBe(true);
  });
});

describe("createDuplicateGuard", () => {
  it("does not count rows the import deletes as already stored", () => {
    const scope = { broker: "T212", account: ACCOUNT, adoptLegacy: false, replaceApiFillsBefore: "2026-07-01T00:00:00.000Z" };
    const guard = createDuplicateGuard([db("t212:ord:1", "2026-05-04T15:00:00+00:00", "NVDA")], scope);
    expect(guard.tradeAlreadyStored(stmt("2026-05-04", "NVDA") as any)).toBe(false);
  });
});

describe("planImport — statement B after an API sync", () => {
  // Statement A (Jan–Mar) imported, then the API sync appended April–July. Statement B covers
  // April–June, i.e. the same trades as the API fills of April–June, under other ids.
  const history = () => [
    db("t212:act:2026-02-10:AAPL", "2026-02-10T12:00:00+00:00", "AAPL"),
    db("t212:ord:1001", "2026-04-02T14:31:00+00:00", "NVDA"),
    db("t212:ord:1002", "2026-05-20T15:02:00+00:00", "MSFT", { side: "SELL" }),
    db("t212:ord:1003", "2026-06-30T19:45:00+00:00", "NVDA"),
    db("t212:adj:111:NVDA", "2026-07-01T08:00:00+00:00", "NVDA", { shares: 1 }),
  ];
  const statementB = () => [stmt("2026-04-02", "NVDA"), stmt("2026-05-20", "MSFT", { side: "SELL" }), stmt("2026-06-30", "NVDA")];

  it("inserts every overlapping trade instead of skipping it", async () => {
    TX = history() as any;
    const plan = await planImport(parsed(statementB()) as any);
    expect(plan.toInsertTrades.map((r) => r.ticker)).toEqual(["NVDA", "MSFT", "NVDA"]);
    expect(plan.alreadyImported).toBe(0);
    expect(plan.replaceApiFillsBefore).toBe("2026-07-01T00:00:00.000Z");
  });

  it("leaves API fills after the statement's last day alone", async () => {
    // B ends on 30 June. The 2 July fill is not in B, so deleting it would lose it until the
    // next manual sync pulled it again.
    const july = db("t212:ord:1005", "2026-07-02T14:00:00+00:00", "AMD");
    TX = [...history(), july] as any;
    const plan = await planImport(parsed(statementB()) as any);
    expect(plan.toInsertTrades).toHaveLength(3);
    expect(replacedByStatement(july, { broker: "T212", account: ACCOUNT, adoptLegacy: plan.adoptLegacy, replaceApiFillsBefore: plan.replaceApiFillsBefore })).toBe(false);
  });

  it("stays idempotent once B is stored", async () => {
    TX = [
      ...history().filter((t) => !String(t.ext_id).startsWith("t212:ord:")),
      ...statementB().map((r) => db(r.external_id, (r.executed_at as string).replace(".000Z", "+00:00"), r.ticker, { side: r.side })),
    ] as any;
    const plan = await planImport(parsed(statementB()) as any);
    expect(plan.toInsertTrades).toHaveLength(0);
    expect(plan.alreadyImported).toBe(3);
  });

  it("reconciles to B's snapshot when only replaced API fills are newer than B", async () => {
    // The 30 June fill at 19:45 is later than B's noon timestamp but is deleted by the import,
    // so B is the newest data the account will hold.
    TX = history() as any;
    const holdings = [{ external_id: "t212:pos:111:NVDA", broker: "T212", account: ACCOUNT, kind: "HOLDING", ticker: "NVDA", shares: 4, executed_at: "2026-06-30T12:00:00.000Z", label: "" }];
    const plan = await planImport(parsed(statementB(), holdings) as any);
    expect(plan.reconcileTo).toHaveLength(1);

    TX = [...history(), db("t212:ord:1005", "2026-07-02T14:00:00+00:00", "AMD")] as any;
    const later = await planImport(parsed(statementB(), holdings) as any);
    expect(later.reconcileTo).toHaveLength(0); // a kept fill is newer — B's snapshot is stale
  });
});
