// Audit B regressions for the broker statement import (T212 / Revolut / XTB).
// Runs planImport + executeImport against an in-memory PostgREST stand-in that really applies
// the filters (eq/like/is/lt/gte/in), so a delete or update that reaches too far shows up.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRevolutHoldings, parseRevolutText, parseT212Activity, parseXtbTrades, type NormalizedRow } from "@/lib/statements";
import { createDuplicateGuard, planHoldingsSnapshot, type ExistingTx } from "@/lib/statementDedup";

type Row = Record<string, unknown>;
const DB: Record<string, Row[]> = { transactions: [], deposits: [], dividends: [] };
let nextId = 0;
let failTable: string | null = null;
let failReplacement = false;
const rpcCalls: string[] = [];
const seedBatches: number[] = [];

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(null) }) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@/integrations/supabase/client", () => {
  const ms = (s: unknown) => new Date(String(s)).getTime();
  const table = (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { type: "select" | "delete" | "update" | "insert" | "upsert"; payload?: Row | Row[] } = { type: "select" };
    const rows = () => (DB[name] ??= []);
    const match = () => rows().filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (name === failTable && op.type !== "select") return { data: null, error: { message: "write rejected" } };
      if (op.type === "select") return { data: match(), error: null };
      if (op.type === "delete") { const hit = new Set(match()); DB[name] = rows().filter((r) => !hit.has(r)); return { data: null, error: null }; }
      if (op.type === "update") { for (const r of match()) Object.assign(r, op.payload); return { data: null, error: null }; }
      const list = Array.isArray(op.payload) ? op.payload : [op.payload];
      const added: Row[] = [];
      for (const p of list) {
        const clash = name === "transactions" && rows().some((r) => r.user_id === p.user_id && r.broker === p.broker && r.ext_id === p.ext_id);
        if (clash) { if (op.type === "insert") return { data: null, error: { message: "duplicate key" } }; continue; }
        const row = { id: `n${++nextId}`, ...p };
        rows().push(row); added.push(row);
      }
      return { data: added, error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      like: (c: string, p: string) => {
        const re = new RegExp("^" + p.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
        return (filters.push((r) => re.test(String(r[c] ?? ""))), q);
      },
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), q),
      lt: (c: string, v: string) => (filters.push((r) => ms(r[c]) < ms(v)), q),
      gte: (c: string, v: string) => (filters.push((r) => ms(r[c]) >= ms(v)), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      order: () => q,
      delete: () => ((op = { type: "delete" }), q),
      update: (p: Row) => ((op = { type: "update", payload: p }), q),
      insert: (p: Row | Row[]) => ((op = { type: "insert", payload: p }), q),
      upsert: (p: Row[]) => ((op = { type: "upsert", payload: p }), q),
      range: (from: number, to: number) => Promise.resolve({ data: match().slice(from, to + 1), error: null }),
      then: (res: (value: ReturnType<typeof exec>) => unknown, rej: (reason: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  };
  return {
    supabase: {
      from: (name: string) => table(name),
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      rpc: async (name: string, args: { p_account: string; p_from: string; p_before: string; p_rows: Row[] }) => {
        rpcCalls.push(name);
        if (name === "seed_ticker_aliases") seedBatches.push(args.p_rows.length);
        if (name !== "replace_statement_trades") return { data: 0, error: null };
        if (failReplacement) return { data: null, error: { message: "replacement rejected" } };
        const keep = DB.transactions.filter((r) => !(r.user_id === "u1" && r.broker === "T212"
          && (r.broker_account ?? null) === args.p_account && (r.ext_id as string)?.startsWith("t212:ord:")
          && ms(r.executed_at) >= ms(args.p_from) && ms(r.executed_at) < ms(args.p_before)));
        const fresh = args.p_rows.filter((r: Row) => !keep.some((old) => old.user_id === "u1" && old.broker === "T212" && old.ext_id === r.ext_id));
        DB.transactions = [...keep, ...fresh];
        return { data: { inserted: fresh.length, corrected: 0 }, error: null };
      },
    },
  };
});

const { planImport, executeImport, t212PriceUsd, convertT212, parseStatementFile, MAX_STATEMENT_BYTES } = await import("@/lib/statementImport");

beforeEach(() => { DB.transactions = []; DB.deposits = []; DB.dividends = []; nextId = 0; failTable = null; failReplacement = false; rpcCalls.length = 0; seedBatches.length = 0; });

const tx = (o: Row): Row => ({ id: `s${++nextId}`, user_id: "u1", side: "BUY", shares: 1, broker_account: null, t212_id: null, ...o });

it("C1 reimports a European XTB trade over the legacy ticker without creating a second holding", async () => {
  const rows = parseXtbTrades([
    ["Account number", "12345"], ["Account currency", "CZK"],
    ["Type", "Ticker", "Instrument", "Time", "Amount", "ID", "Comment"],
    ["Stock purchase", "SAP.DE", "SAP", 45719, -2500, "reexported", "OPEN BUY 1 @ 100"],
    ["Stock purchase", "SAP.DE", "SAP", 45720, -2500, "new", "OPEN BUY 1 @ 100"],
  ]);
  DB.transactions = [tx({ ticker: "SAP", broker: "XTB", broker_account: "12345", ext_id: "legacy",
    executed_at: rows[0].executed_at, price_usd: rows[0].price_usd })];
  const parsed = { broker: "XTB" as const, account: "12345", mode: "trades" as const, rows, holdings: [] };
  const plan = await planImport(parsed);
  expect(plan.toInsertTrades.map(r => r.external_id)).toEqual(["xtb:ord:new"]);
  await executeImport(plan);
  expect(DB.transactions.map(r => r.ticker)).toEqual(["SAP", "SAP"]);
  expect((await planImport(parsed)).toInsertTrades).toEqual([]);
});

// ── #3 T212: a shorter statement must not delete API fills outside its period ─────────────
describe("T212 statement replaces only the API fills of its own period", () => {
  const stmt = (day: string, ticker: string, id: string): NormalizedRow => ({
    external_id: `t212:act:${id}`, broker: "T212", account: "111", kind: "TRADE", ticker, side: "BUY",
    shares: 2, price_usd: 50, fee_usd: 0, executed_at: `${day}T12:00:00.000Z`, label: "",
  });
  const june = () => [stmt("2026-06-02", "NVDA", "9001"), stmt("2026-06-10", "MSFT", "9002")];

  it("keeps January API fills when a June statement is imported", async () => {
    DB.transactions = [
      tx({ ticker: "AAPL", broker: "T212", broker_account: "111", ext_id: "t212:ord:1", executed_at: "2026-01-15T15:00:00+00:00", shares: 2 }),
      tx({ ticker: "NVDA", broker: "T212", broker_account: "111", ext_id: "t212:ord:2", executed_at: "2026-06-02T15:30:00+00:00", shares: 2 }),
      tx({ ticker: "AMD", broker: "T212", broker_account: "111", ext_id: "t212:ord:3", executed_at: "2026-07-02T14:00:00+00:00", shares: 2 }),
    ];
    const plan = await planImport({ broker: "T212", account: "111", mode: "trades", rows: june(), holdings: [] });
    expect(plan.replaceApiFillsFrom).toBe("2026-06-02T00:00:00.000Z");
    expect(plan.toInsertTrades).toHaveLength(2);
    await executeImport(plan);
    const ext = DB.transactions.map((t) => t.ext_id).sort();
    // January (before the statement) and July (after it) survive; the June fill is replaced.
    expect(ext).toEqual(["t212:act:9001", "t212:act:9002", "t212:ord:1", "t212:ord:3"]);
  });

  it("re-importing the same statement adds nothing", async () => {
    const plan = await planImport({ broker: "T212", account: "111", mode: "trades", rows: june(), holdings: [] });
    await executeImport(plan);
    const again = await planImport({ broker: "T212", account: "111", mode: "trades", rows: june(), holdings: [] });
    expect(again.toInsertTrades).toHaveLength(0);
    expect(again.alreadyImported).toBe(2);
  });

  it("keeps API fills and skips reconciliation when the atomic replacement fails", async () => {
    DB.transactions = [tx({ ticker: "NVDA", broker: "T212", broker_account: "111", ext_id: "t212:ord:2", executed_at: "2026-06-02T15:30:00Z" })];
    const before = structuredClone(DB.transactions);
    const plan = await planImport({ broker: "T212", account: "111", mode: "trades", rows: june(), holdings: [] });
    plan.reconcileTo = [{ ...june()[0], kind: "HOLDING" }];
    failReplacement = true;
    await expect(executeImport(plan)).rejects.toMatchObject({ message: "replacement rejected" });
    expect(DB.transactions).toEqual(before);
    expect(rpcCalls).not.toContain("reconcile_broker_account");
  });

  it.each(["transactions", "deposits", "dividends"])("stops before reconciliation on a failed %s write", async (table) => {
    const base = { ...june()[0], broker: "XTB" as const };
    const rows: NormalizedRow[] = [base, { ...base, kind: "DEPOSIT", external_id: "deposit", amount_usd: 1 }, { ...base, kind: "DIVIDEND", external_id: "dividend", amount_usd: 1 }];
    const plan = await planImport({ broker: "XTB", mode: "trades", rows, holdings: [] });
    plan.reconcileTo = [{ ...base, kind: "HOLDING" }];
    failTable = table;
    await expect(executeImport(plan)).rejects.toMatchObject({ message: "write rejected" });
    expect(rpcCalls).not.toContain("reconcile_broker_account");
  });
});

it("B9 rejects oversized workbooks before allocating or parsing their contents", async () => {
  const arrayBuffer = vi.fn();
  await expect(parseStatementFile({ name: "large.xlsx", size: MAX_STATEMENT_BYTES + 1, arrayBuffer } as unknown as File)).rejects.toThrow(/10 MiB/);
  expect(arrayBuffer).not.toHaveBeenCalled();
});

it("B4 persists original gross and actual withholding", async () => {
  const row: NormalizedRow = { broker: "XTB", kind: "DIVIDEND", external_id: "actual-dividend", ticker: "AAPL", executed_at: "2025-03-03T12:00:00Z", label: "", amount_usd: 10, gross_amount_usd: 10, withholding_tax_usd: 3, original_currency: "CZK", gross_amount: 230, withholding_tax: 69 };
  await executeImport(await planImport({ broker: "XTB", mode: "trades", rows: [row], holdings: [] }));
  expect(DB.dividends[0]).toMatchObject({ gross_amount_usd: 10, withholding_tax_usd: 3, original_currency: "CZK", gross_amount: 230, withholding_tax: 69 });
  await executeImport(await planImport({ broker: "XTB", mode: "trades", rows: [{ ...row, withholding_tax_usd: 2 }], holdings: [] }));
  expect(DB.dividends).toHaveLength(1);
  expect(DB.dividends[0].withholding_tax_usd).toBe(2);
});

it("B5 marks missing dated FX for review and prevents incomplete T212 replacement", async () => {
  const row: NormalizedRow = { broker: "T212", kind: "TRADE", external_id: "t212:act:missing", ticker: "SAP", executed_at: "2040-01-01T12:00:00Z", label: "SAP", ccy: "EUR", price_ccy: 100, shares: 1, side: "BUY", czk: 2500 };
  const converted = await convertT212([row]);
  expect(converted[0]).toMatchObject({ kind: "SKIP", needs_review: true });
  await expect(planImport({ broker: "T212", mode: "trades", rows: converted, holdings: [] })).rejects.toThrow();
});

// ── #4 Revolut holdings mode is scoped to the statement's account ──────────────────────────
const breakdown = (account: string, lines: string[]) => [
  `Account number   ${account}`,
  "USD Portfolio breakdown",
  "Symbol Company ISIN Quantity Price Value % of Portfolio",
  ...lines,
  "Positions Value US$1 100%",
].join("\n");
const AAPL = (q: number) => `AAPL Apple US0378331005 ${q} US$200.00 US$1.00 1%`;
const MSFT = (q: number) => `MSFT Microsoft US5949181045 ${q} US$400.00 US$1.00 1%`;
const holdingsParsed = (account: string, lines: string[]) => {
  const rows = parseRevolutHoldings(breakdown(account, lines));
  return { broker: "Revolut" as const, account, mode: "holdings" as const, rows, holdings: rows };
};

describe("Revolut holdings mode", () => {
  it("qualifies the snapshot id with the account", () => {
    expect(holdingsParsed("11111111", [AAPL(1)]).rows[0].external_id).toBe("revolut:pos:11111111:AAPL");
  });

  it("account B's statement neither overwrites nor deletes account A's rows (legacy ids)", async () => {
    DB.transactions = [
      tx({ ticker: "AAPL", broker: "Revolut", broker_account: "11111111", ext_id: "revolut:pos:AAPL", shares: 5, executed_at: "2026-01-01T00:00:00Z" }),
      tx({ ticker: "MSFT", broker: "Revolut", broker_account: "11111111", ext_id: "revolut:pos:MSFT", shares: 3, executed_at: "2026-01-01T00:00:00Z" }),
    ];
    const plan = await planImport(holdingsParsed("22222222", [AAPL(7)]));
    expect(plan.holdingsRemove).toEqual([]);
    await executeImport(plan);
    const a = DB.transactions.filter((t) => t.broker_account === "11111111");
    expect(a.map((t) => [t.ext_id, t.shares])).toEqual([["revolut:pos:AAPL", 5], ["revolut:pos:MSFT", 3]]);
    expect(DB.transactions.filter((t) => t.broker_account === "22222222").map((t) => [t.ext_id, t.shares])).toEqual([["revolut:pos:22222222:AAPL", 7]]);
  });

  it("re-importing account A updates its legacy rows in place — no second copy", async () => {
    DB.transactions = [
      tx({ ticker: "AAPL", broker: "Revolut", broker_account: "11111111", ext_id: "revolut:pos:AAPL", shares: 5, executed_at: "2026-01-01T00:00:00Z" }),
      tx({ ticker: "MSFT", broker: "Revolut", broker_account: "11111111", ext_id: "revolut:pos:MSFT", shares: 3, executed_at: "2026-01-01T00:00:00Z" }),
      tx({ ticker: "AAPL", broker: "Revolut", broker_account: "22222222", ext_id: "revolut:pos:22222222:AAPL", shares: 7, executed_at: "2026-01-01T00:00:00Z" }),
    ];
    const plan = await planImport(holdingsParsed("11111111", [AAPL(6)]));
    expect(plan.holdingsRemove.map((r) => r.label)).toEqual(["MSFT"]); // A sold MSFT; B untouched
    await executeImport(plan);
    const rows = () => DB.transactions.map((t) => [t.broker_account, t.ext_id, t.shares]);
    expect(rows()).toEqual([["11111111", "revolut:pos:11111111:AAPL", 6], ["22222222", "revolut:pos:22222222:AAPL", 7]]);
    await executeImport(await planImport(holdingsParsed("11111111", [AAPL(6)])));
    expect(rows()).toEqual([["11111111", "revolut:pos:11111111:AAPL", 6], ["22222222", "revolut:pos:22222222:AAPL", 7]]);
  });

  it("claims account-less rows while no other account has snapshot rows, and stops when it is ambiguous", () => {
    const legacy = { id: "1", ticker: "AAPL", ext_id: "revolut:pos:AAPL", broker_account: null };
    const h = [{ external_id: "revolut:pos:11111111:AAPL", ticker: "AAPL" }];
    expect(planHoldingsSnapshot([legacy], h, "Revolut", "11111111").matchId.get("revolut:pos:11111111:AAPL")).toBe("1");
    const other = { id: "2", ticker: "TSLA", ext_id: "revolut:pos:22222222:TSLA", broker_account: "22222222" };
    // Ambiguous: keeping the legacy row next to this import would count AAPL twice — stop.
    expect(() => planHoldingsSnapshot([legacy, other], h, "Revolut", "11111111")).toThrow(/bez přiřazeného účtu/);
  });
});

// ── #10 T212 non-USD instrument settled in USD ─────────────────────────────────────────────
describe("T212 EUR instrument settled in USD", () => {
  const head = "Výpis aktivit\n Číslo účtu: 1234567\n";
  const line = "2025-03-03 10:00:00   ASML   NL0010273215   EUR   123456   Koupit   2   650.00   1300.00   Trh   XETRA   Běžné hodiny   1.08   USD   -   -   -   1404.00";
  it("carries the USD total and prices the buy from it instead of $0", () => {
    const r = parseT212Activity(head + line)[0];
    expect(r).toMatchObject({ ccy: "EUR", czk: undefined, usd_total: 1404 });
    expect(t212PriceUsd(r, 23)).toBeCloseTo(702, 6);
  });
  it("keeps the existing paths: USD instrument price, CZK conversion", () => {
    expect(t212PriceUsd({ ccy: "USD", price_ccy: 776.19, shares: 1, czk: 99 } as NormalizedRow, 23)).toBe(776.19);
    expect(t212PriceUsd({ ccy: "EUR", shares: 2, czk: 4600 } as NormalizedRow, 23)).toBeCloseTo(100, 6);
  });
});

// ── #14 content dedup must not depend on file order ────────────────────────────────────────
describe("duplicate guard: two same-size buys on one day", () => {
  const ex = (o: Partial<ExistingTx>): ExistingTx => ({ id: "1", ticker: "AAPL", side: "BUY", shares: 1, executed_at: "2026-03-02T15:00:00+00:00", broker: "Revolut", broker_account: "111", t212_id: null, ext_id: "revolut:X", ...o });
  const row = (id: string, at: string): NormalizedRow => ({ external_id: id, broker: "Revolut", account: "111", kind: "TRADE", ticker: "AAPL", side: "BUY", shares: 1, price_usd: 1, executed_at: at, label: "" });
  const scope = { broker: "Revolut", account: "111", adoptLegacy: false, replaceApiFillsBefore: null };

  it("imports the new buy even when it is listed before the stored one", () => {
    const y = row("revolut:Y", "2026-03-02T18:00:00.000Z"), x = row("revolut:X", "2026-03-02T15:00:00.000Z");
    const guard = createDuplicateGuard([ex({})], scope, [y, x]);
    expect(guard.tradeAlreadyStored(y)).toBe(false);
    expect(guard.tradeAlreadyStored(x)).toBe(true);
  });

  it("still recognises a stored trade under a different id (re-export)", () => {
    const z = row("revolut:Z", "2026-03-02T15:00:00.000Z");
    expect(createDuplicateGuard([ex({})], scope, [z]).tradeAlreadyStored(z)).toBe(true);
  });
});

// ── #15 T212: two equal deposits on one day ────────────────────────────────────────────────
describe("T212 equal deposits on the same day", () => {
  const head = "Výpis aktivit\n Číslo účtu: 1234567\n";
  const dep1 = "2025-02-03 09:00:00   Bankovní převod   CZK   1000.00   CZK   5000.00";
  const dep2 = "2025-02-03 15:00:00   Bankovní převod   CZK   1000.00   CZK   6000.00";

  it("keeps both, the first under the id earlier imports stored", () => {
    const ids = parseT212Activity(head + [dep1, dep2].join("\n")).map((r) => r.external_id);
    expect(ids).toEqual(["t212:dep:1234567:2025-02-03:1000", "t212:dep:1234567:2025-02-03:1000:2"]);
  });

  it("does not turn a verbatim repeated line into a second deposit", () => {
    expect(parseT212Activity(head + [dep1, dep1].join("\n"))).toHaveLength(1);
  });

  it("a re-import over the old data adds only the missing second deposit", async () => {
    DB.deposits = [{ id: "d1", user_id: "u1", broker: "T212", ext_id: "t212:dep:1234567:2025-02-03:1000", amount_usd: 43 }];
    const rows = parseT212Activity(head + [dep1, dep2].join("\n")).map((r) => ({ ...r, amount_usd: 43 }));
    const plan = await planImport({ broker: "T212", account: "1234567", mode: "trades", rows, holdings: [] });
    expect(plan.deposits.map((r) => r.external_id)).toEqual(["t212:dep:1234567:2025-02-03:1000:2"]);
    const s = await executeImport(plan);
    expect(s.deposits).toBe(1);
    expect(DB.deposits).toHaveLength(2);
  });
});

// ── #17 Revolut fallback price must not include the fee ────────────────────────────────────
describe("Revolut fallback price (value / quantity)", () => {
  it("takes the commission out of a buy's net value", () => {
    // Printed price glued away (unusable) → fallback. 1001 USD paid incl. a 1 USD fee.
    const r = parseRevolutText("25 Feb 2021 16:21:12 GMT AAPL Trade - Market 10 US$1,001.00Buy US$1,001.00 US$0 US$1.00")[0];
    expect(r.fee_usd).toBe(1);
    expect(r.price_usd).toBeCloseTo(100, 6);
    expect(r.shares! * r.price_usd! + r.fee_usd!).toBeCloseTo(1001, 6);
  });
  it("adds the fee back to a sell's net value", () => {
    const r = parseRevolutText("25 Feb 2021 16:21:12 GMT TSLA Trade - Market 10 US$999.00Sell US$999.00 US$0 US$1.00")[0];
    expect(r.price_usd).toBeCloseTo(100, 6);
    expect(r.shares! * r.price_usd! - r.fee_usd!).toBeCloseTo(999, 6);
  });
});

it("seeds shared aliases in batches of 500 from every traded instrument, also on a re-import (codex review)", async () => {
  const rows: NormalizedRow[] = Array.from({ length: 501 }, (_, i) => ({
    external_id: `xtb:ord:${i}`, broker: "XTB", account: "777", kind: "TRADE", ticker: `T${i}`, side: "BUY", shares: 1, price_usd: 10, fee_usd: 0,
    executed_at: "2026-03-02T12:00:00.000Z", label: "", isin: `US${String(i).padStart(9, "0")}0`,
  }));
  const parsed = { broker: "XTB" as const, account: "777", mode: "trades" as const, rows, holdings: [] };
  await executeImport(await planImport(parsed));
  expect(seedBatches).toEqual([500, 1]);
  seedBatches.length = 0;
  const again = await planImport(parsed);
  expect(again.toInsertTrades).toEqual([]);
  await executeImport(again);
  expect(seedBatches).toEqual([500, 1]);
});
