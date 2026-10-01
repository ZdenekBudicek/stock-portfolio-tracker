// Regression: importing the same broker statement twice must not double-count.
//
// What actually happened: Revolut's PDF was re-exported, pdfjs split one row into text items
// differently ("US$9,890.88 US$0.01" vs "US$9,890.88US$0.01"), and the external_id was built
// from that raw text — so the SAME fill looked like a brand-new trade. Nine Revolut trades
// landed twice. `positions` stayed right because broker reconciliation quietly cancelled them
// out with :adj: rows, but the history chart is built from the ledger, so it drew a phantom
// 25-share TSLA sell as a 34 % crash on 23. 2. 2026.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRevolutText } from "@/lib/statements";

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

/** The same Revolut sell, as the two PDF exports actually extracted it. */
const SPACED = "23 Feb 2026 18:42:29 GMT TSLA Trade - Market 25 US$395.64 Sell US$9,890.88 US$0.01 US$0";
const GLUED = "23 Feb 2026 18:42:29 GMT TSLA Trade - Market 25 US$395.64 Sell US$9,890.88US$0.01 US$0";

describe("Revolut external_id", () => {
  it("is identical for the same trade however pdfjs split the row", () => {
    const a = parseRevolutText(SPACED)[0];
    const b = parseRevolutText(GLUED)[0];
    expect(a.ticker).toBe("TSLA");
    expect(a.side).toBe("SELL");
    expect(a.shares).toBe(25);
    expect(b.external_id).toBe(a.external_id);
  });

  it("still separates genuinely different trades at the same second", () => {
    const both = parseRevolutText(
      "23 Feb 2026 18:42:29 GMT TSLA Trade - Market 25 US$395.64 Sell US$9,890.88 US$0.01 US$0\n" +
      "23 Feb 2026 18:42:29 GMT AMZN Trade - Market 24.41 US$203.95 Buy US$4,978.44 US$0 US$12.45",
    );
    expect(both).toHaveLength(2);
    expect(both[0].external_id).not.toBe(both[1].external_id);
  });
});

const parsed = (rows: any[]) => ({ broker: "Revolut" as const, account: "12345678", mode: "trades" as const, rows, holdings: [] });
const trade = (o: Row = {}) => ({
  external_id: "revolut:23 Feb 2026 18:42:29:trade:TSLA:SELL:25.000000", broker: "Revolut", account: "12345678",
  kind: "TRADE", ticker: "TSLA", side: "SELL", shares: 25, price_usd: 395.64,
  executed_at: "2026-02-23T18:42:29.000Z", label: "", ...o,
});
const stored = (o: Row = {}) => ({
  id: "1", ticker: "TSLA", side: "SELL", shares: 25, executed_at: "2026-02-23T18:42:29+00:00",
  broker: "Revolut", broker_account: "12345678", ext_id: "revolut:whatever-the-old-id-was", ...o,
});

beforeEach(() => { TX = []; });

describe("planImport duplicate guard", () => {
  it("skips a trade already stored under a DIFFERENT ext_id", async () => {
    TX = [stored()];
    const plan = await planImport(parsed([trade()]) as any);
    expect(plan.toInsertTrades).toHaveLength(0);
    expect(plan.alreadyImported).toBe(1);
  });

  it("still imports a second genuinely identical trade on the same day", async () => {
    // Two real fills of the same size — the database holds one, the file lists two, so
    // exactly one more must land. Presence-based matching would have dropped it.
    TX = [stored()];
    const plan = await planImport(parsed([trade(), trade({ external_id: "revolut:other:trade" })]) as any);
    expect(plan.toInsertTrades).toHaveLength(1);
    expect(plan.alreadyImported).toBe(1);
  });

  it("does not treat a reconciliation row as the trade it corrects", async () => {
    // The :adj: row cancelling the duplicate must not itself count as "already imported",
    // or a genuine re-import would silently drop a real trade.
    TX = [stored({ ext_id: "revolut:adj:12345678:TSLA", side: "BUY" })];
    const plan = await planImport(parsed([trade()]) as any);
    expect(plan.toInsertTrades).toHaveLength(1);
  });

  it("keeps the same trade at a different account of the same broker", async () => {
    TX = [stored({ broker_account: "99999999" })];
    const plan = await planImport(parsed([trade()]) as any);
    expect(plan.toInsertTrades).toHaveLength(1);
  });
});
