// Regression: a manual Trading 212 sync deleted the orders an earlier sync had pulled from
// the API, and never pulled them again.
//
// What happened: the first reconcile writes t212:adj:* rows. sync-broker counted those as
// "trades that did not come from the API", so from then on every account ran in statement
// mode — and the deletion cutoff was the newest NON-adjustment row, i.e. the newest API order.
// The button sends restart=true, so the sync deleted every t212:ord:* row up to that cutoff,
// stopped paging at the same cutoff and re-inserted nothing older. The reconcile then papered
// over the missing shares with an adjustment dated today: sells vanished from realized P&L,
// from the tax report and from the history chart.
import { describe, it, expect } from "vitest";
import {
  planT212History, selectT212OrdersToInsert, reachedPageStop, t212RowKind,
  type T212StoredTrade,
} from "../../supabase/functions/_shared/t212";

const ms = (s: string) => new Date(s).getTime();
// Statement rows carry the day at noon UTC (parseT212Activity); API fills the real fill time.
const act = (day: string, o: Partial<T212StoredTrade> = {}): T212StoredTrade => ({
  ext_id: `t212:act:${day}`, executed_at: `${day}T12:00:00.000Z`, ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, ...o,
});
const ord = (id: string, at: string, o: Partial<T212StoredTrade> = {}): T212StoredTrade => ({
  ext_id: `t212:ord:${id}`, executed_at: at, ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, ...o,
});
const adj = (at: string, o: Partial<T212StoredTrade> = {}): T212StoredTrade => ({
  ext_id: "t212:adj:111:AAPL", executed_at: at, ticker: "AAPL", side: "BUY", shares: 3, price_usd: 120, ...o,
});

/**
 * One sync-broker call against the stored rows of the account, step for step: delete the API
 * fills the statement covers (first batch only), page newest-first until the stop, replace the
 * whole API history for a pure-API account (first batch only), then insert the selection —
 * the import RPC skips ext_ids that are already stored (ON CONFLICT DO NOTHING).
 */
function runSync(
  stored: T212StoredTrade[], apiNewestFirst: T212StoredTrade[],
  { firstBatch = true, resuming = false } = {},
): T212StoredTrade[] {
  const plan = planT212History(stored, { resuming });
  let rows = stored;
  if (plan.statementMode && firstBatch && plan.statementCutoff) {
    const cut = ms(plan.statementCutoff);
    rows = rows.filter((r) => !(t212RowKind(r.ext_id) === "api" && ms(r.executed_at) <= cut));
  }
  const pulled: T212StoredTrade[] = [];
  for (const o of apiNewestFirst) {
    pulled.push(o);
    if (reachedPageStop([o.executed_at], plan)) break;
  }
  if (!plan.statementMode && firstBatch) rows = rows.filter((r) => !String(r.ext_id ?? "").startsWith("t212:"));
  const have = new Set(rows.map((r) => r.ext_id));
  return [...rows, ...selectT212OrdersToInsert(pulled, stored, plan).filter((r) => !have.has(r.ext_id))];
}
const ids = (rows: T212StoredTrade[]) => rows.map((r) => r.ext_id).filter((e) => String(e).startsWith("t212:ord:")).sort();

describe("t212RowKind", () => {
  it("tells reconcile adjustments, API fills and statement/manual rows apart", () => {
    expect(t212RowKind("t212:adj:111:AAPL")).toBe("adjustment");
    expect(t212RowKind("t212:adj:AAPL")).toBe("adjustment"); // pre-scoping auto-sync rows
    expect(t212RowKind("t212:ord:42")).toBe("api");
    expect(t212RowKind("t212:act:42")).toBe("statement");
    expect(t212RowKind(null)).toBe("statement"); // a manual entry
  });
});

describe("planT212History", () => {
  it("keeps a pure-API account in API mode after its first reconcile", () => {
    const stored = [ord("1", "2026-03-02T15:00:00Z"), ord("2", "2026-05-10T15:00:00Z"), adj("2026-10-01T08:00:00Z")];
    expect(planT212History(stored, { resuming: false })).toEqual({ statementMode: false, statementCutoff: null, pageStop: null });
  });

  it("takes the deletion cutoff from statement rows only, and the page stop from every non-adjustment row", () => {
    const stored = [act("2026-06-10"), act("2026-06-30"), ord("9", "2026-07-05T15:30:00Z"), adj("2026-10-17T08:00:00Z")];
    expect(planT212History(stored, { resuming: false })).toEqual({
      statementMode: true, statementCutoff: "2026-06-30T12:00:00.000Z", pageStop: "2026-07-05T15:30:00Z",
    });
  });

  it("treats manual rows as history the API must not overwrite", () => {
    const plan = planT212History([{ ext_id: null, executed_at: "2026-04-01T00:00:00+00:00" }], { resuming: false });
    expect(plan.statementMode).toBe(true);
    expect(plan.statementCutoff).toBe("2026-04-01T00:00:00+00:00");
  });

  it("compares instants, not strings — the DB returns +00:00, the API returns Z", () => {
    const plan = planT212History([act("2026-06-30"), ord("9", "2026-06-30T13:00:00+00:00")], { resuming: false });
    expect(plan.pageStop).toBe("2026-06-30T13:00:00+00:00");
  });

  it("pages down to the statement while an earlier run is unfinished", () => {
    // An interrupted run stored the NEWEST orders and stopped in the middle; the newest stored
    // order is no proof that everything older than it is there.
    const stored = [act("2026-06-30"), ord("9", "2026-09-20T15:00:00Z")];
    expect(planT212History(stored, { resuming: true }).pageStop).toBe("2026-06-30T12:00:00.000Z");
  });
});

describe("reachedPageStop", () => {
  const plan = planT212History([act("2026-06-30"), ord("9", "2026-07-05T15:30:00Z")], { resuming: false });
  it("stops at the first page that reaches the newest stored order", () => {
    expect(reachedPageStop(["2026-08-01T10:00:00Z", "2026-07-05T15:30:00.000Z"], plan)).toBe(true);
    expect(reachedPageStop(["2026-08-01T10:00:00Z", "2026-07-06T09:00:00Z"], plan)).toBe(false);
  });
  it("never stops a pure-API import early", () => {
    const api = planT212History([ord("1", "2026-03-02T15:00:00Z"), adj("2026-10-01T08:00:00Z")], { resuming: false });
    expect(reachedPageStop(["2020-01-01T00:00:00Z"], api)).toBe(false);
  });
});

describe("selectT212OrdersToInsert", () => {
  it("skips an order the statement already holds under a different id and time of day", () => {
    const stored = [act("2026-06-30", { ticker: "NU", shares: 910, price_usd: 12.34 })];
    const plan = planT212History(stored, { resuming: false });
    const sameFill = ord("77", "2026-06-30T15:42:00Z", { ticker: "NU", shares: 910, price_usd: 12.34 });
    const laterBuy = ord("78", "2026-06-30T16:00:00Z", { ticker: "NU", shares: 5, price_usd: 12.5 });
    expect(selectT212OrdersToInsert([laterBuy, sameFill], stored, plan)).toEqual([laterBuy]);
  });

  it("is not blocked by a reconcile adjustment that happens to look like the order", () => {
    const stored = [act("2026-06-30"), adj("2026-07-05T08:00:00Z", { shares: 1, price_usd: 100 })];
    const plan = planT212History(stored, { resuming: false });
    const o = ord("9", "2026-07-05T15:30:00Z");
    expect(selectT212OrdersToInsert([o], stored, plan)).toEqual([o]);
  });
});

describe("manual sync after a previous sync (restart=true)", () => {
  it("pure-API user after the first reconcile keeps every API order", () => {
    const api = [ord("3", "2026-08-01T15:00:00Z", { side: "SELL" }), ord("2", "2026-05-10T15:00:00Z"), ord("1", "2026-03-02T15:00:00Z")];
    const afterFirst = [...api, adj("2026-10-16T08:00:00Z")];
    const afterSecond = runSync(afterFirst, [ord("4", "2026-10-17T14:00:00Z"), ...api]);
    expect(ids(afterSecond)).toEqual(["t212:ord:1", "t212:ord:2", "t212:ord:3", "t212:ord:4"]);
  });

  it("statement to 30 June + API order on 5 July survives the second sync", () => {
    const statement = [act("2026-06-02"), act("2026-06-30", { side: "SELL" })];
    const july5 = ord("500", "2026-07-05T15:30:00Z");
    const sameAsStatement = ord("499", "2026-06-30T15:00:00Z", { side: "SELL" }); // = act 30.6
    const older = ord("100", "2026-06-02T14:00:00Z"); // = act 2.6

    const afterFirst = [...runSync(statement, [july5, sameAsStatement, older]), adj("2026-07-06T08:00:00Z")];
    expect(ids(afterFirst)).toEqual(["t212:ord:500"]);

    const aug = ord("600", "2026-08-12T15:00:00Z");
    const afterSecond = runSync(afterFirst, [aug, july5, sameAsStatement, older]);
    expect(ids(afterSecond)).toEqual(["t212:ord:500", "t212:ord:600"]);
    expect(afterSecond.filter((r) => t212RowKind(r.ext_id) === "statement")).toHaveLength(2);
  });

  it("refills the gap an interrupted run left behind", () => {
    // Run 1 stored the newest page (Sep) and was abandoned; Jul/Aug never landed.
    const stored = [act("2026-06-30"), ord("900", "2026-09-20T15:00:00Z")];
    const api = [ord("900", "2026-09-20T15:00:00Z"), ord("800", "2026-08-12T15:00:00Z"), ord("700", "2026-07-05T15:00:00Z")];
    expect(ids(runSync(stored, api, { resuming: true }))).toEqual(["t212:ord:700", "t212:ord:800", "t212:ord:900"]);
  });
});
