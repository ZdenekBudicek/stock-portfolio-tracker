// Pure pieces of the statement import's duplicate guard (planImport / executeImport in
// statementImport.ts), kept free of Supabase, pdfjs and xlsx so they can be tested directly.
import type { NormalizedRow } from "@/lib/statements";

/** A transaction as planImport reads it back from the database. */
export interface ExistingTx {
  id: string;
  ticker: string;
  side: string;
  shares: number;
  executed_at: string;
  broker: string;
  broker_account: string | null;
  t212_id: string | null;
  ext_id: string | null;
}

export interface StatementScope {
  broker: string;
  account?: string;
  /** The import claims this broker's account-less rows for `account` before anything else. */
  adoptLegacy: boolean;
  /** T212: API fills (t212:ord:*) of the account dated before this instant are replaced by the statement. */
  replaceApiFillsBefore: string | null;
  /**
   * T212: …and dated at or after this instant (the statement's first day). A statement covers
   * only its own period — a June statement must not replace January's API fills, which it does
   * not contain. Omitted/null = no lower bound.
   */
  replaceApiFillsFrom?: string | null;
}

const ms = (s: string) => new Date(s).getTime() || 0;

/**
 * Start of the UTC day after the statement's last row. The T212 statement is the full
 * history of every day it lists, so the API fills of those days are replaced by it — but
 * fills after its last day are not in it, and deleting them would lose them until the next
 * manual sync pulled them again. Whole days, because the statement stamps a trade with its
 * day at noon while the API carries the real fill time: a 15:00 fill on the last day is the
 * same trade as that day's statement row.
 */
export function apiFillsReplacedBefore(rows: Pick<NormalizedRow, "executed_at">[]): string | null {
  const last = rows.reduce((m, r) => Math.max(m, ms(r.executed_at)), 0);
  if (!last) return null;
  const d = new Date(last);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * Start of the UTC day of the statement's FIRST row — the lower bound of the API fills it
 * replaces. A statement covers only its own period: deleting with an upper bound alone made a
 * June statement wipe January's API fills, which it does not contain and so never re-inserts.
 * The first row (not the printed period start) is the conservative bound: it can only leave
 * more API fills in place, never delete one the statement lacks.
 */
export function apiFillsReplacedFrom(rows: Pick<NormalizedRow, "executed_at">[]): string | null {
  const first = rows.reduce((m, r) => { const t = ms(r.executed_at); return t > 0 && t < m ? t : m; }, Infinity);
  if (!Number.isFinite(first)) return null;
  const d = new Date(first);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * True for a stored row executeImport deletes before writing the statement: an API fill of
 * the statement's account (or an account-less one the import adopts for it) within the
 * statement's days. Must mirror the delete in executeImport exactly.
 */
export function replacedByStatement(t: ExistingTx, scope: StatementScope): boolean {
  if (scope.broker !== "T212" || t.broker !== "T212") return false;
  if (!String(t.ext_id ?? "").startsWith("t212:ord:")) return false;
  if (!scope.replaceApiFillsBefore || !(ms(t.executed_at) < ms(scope.replaceApiFillsBefore))) return false;
  if (scope.replaceApiFillsFrom && ms(t.executed_at) < ms(scope.replaceApiFillsFrom)) return false;
  return scope.account
    ? t.broker_account === scope.account || (scope.adoptLegacy && !t.broker_account)
    : !t.broker_account;
}

/** A holdings-snapshot row (ext_id "<broker>:pos:…") as read back from the database. */
export interface StoredHolding {
  id: string;
  ticker: string;
  ext_id: string;
  broker_account: string | null;
}

/**
 * Which stored snapshot rows a holdings-mode import updates and which it removes — scoped to
 * the statement's OWN account. Looking them up by broker alone let account B's breakdown
 * overwrite account A's rows (same "revolut:pos:TICKER" id) and delete every A ticker B does
 * not hold.
 *
 * Rows written before the id carried the account ("<broker>:pos:<TICKER>") still match their
 * holding, so a re-import updates them in place (and moves them to the new id) instead of
 * inserting a second copy. Account-less rows are claimed only while no other account has
 * snapshot rows at this broker — otherwise it is unknowable whose they are, and they stay.
 * A statement without an account number touches only account-less rows.
 */
export function planHoldingsSnapshot(
  stored: StoredHolding[],
  holdings: Pick<NormalizedRow, "external_id" | "ticker">[],
  broker: string,
  account?: string,
): { matchId: Map<string, string>; remove: { id: string; label: string }[] } {
  const otherAccount = stored.some((t) => t.broker_account && t.broker_account !== account);
  // Account-less snapshot rows next to another account's: whose they are is unknowable, and
  // keeping them beside this import's rows would count the holdings twice — stop instead.
  if (account && otherAccount && stored.some((t) => !t.broker_account)) {
    throw new Error("Ve výpisu pozic jsou starší řádky bez přiřazeného účtu vedle jiného účtu. Nejdřív je přiřaď k účtu (nebo je smaž), import se zastavil, aby nic nezdvojil.");
  }
  const mine = stored.filter((t) => (account
    ? t.broker_account === account || (!t.broker_account && !otherAccount)
    : !t.broker_account));
  const matchId = new Map<string, string>();
  const used = new Set<string>();
  const take = (ext: string) => {
    const hit = mine.find((t) => t.ext_id === ext && !used.has(t.id));
    if (hit) used.add(hit.id);
    return hit;
  };
  // Exact ids first, so a legacy row never steals the match from a row already migrated.
  for (const h of holdings) { const hit = take(h.external_id); if (hit) matchId.set(h.external_id, hit.id); }
  for (const h of holdings) {
    if (matchId.has(h.external_id) || !h.ticker) continue;
    const hit = take(`${broker.toLowerCase()}:pos:${h.ticker}`);
    if (hit) matchId.set(h.external_id, hit.id);
  }
  return { matchId, remove: mine.filter((t) => !used.has(t.id)).map((t) => ({ id: t.id, label: t.ticker })) };
}

const contentKey =(ticker: string, side: string, shares: number, isoDate: string, account: string | null) =>
  `${account ?? ""}|${ticker}|${side}|${Number(shares).toFixed(6)}|${isoDate.slice(0, 10)}`;

/**
 * Which of the statement's rows the database already holds.
 *
 * Content-based, independent of ext_id — the safety net that makes a re-import idempotent
 * even when the id scheme changes or the broker re-exports the same fill under a different
 * id. Revolut's PDF text extraction varies between exports, so an id derived from that text
 * let the SAME statement import twice: phantom buys and sells in the ledger, hidden in
 * `positions` by broker reconciliation, but drawn in full in the history chart.
 *
 * Matched by MULTIPLICITY, not presence: if the file lists a trade twice and the database
 * holds it once, the second copy still lands. Only copies already stored are skipped.
 *
 * Rows the import deletes first (see replacedByStatement) are not "stored": counting the API
 * fills as already there skipped the statement's copies, then executeImport deleted the API
 * fills, and the trades in the overlap were gone from both.
 */
export function createDuplicateGuard(existing: ExistingTx[], scope: StatementScope, incoming: NormalizedRow[] = []) {
  const kept = existing.filter((t) => !replacedByStatement(t, scope));
  const txExt = new Set(kept.filter((t) => t.ext_id).map((t) => `${t.broker}:${t.ext_id}`));
  const stored = new Map<string, number>();
  for (const t of kept) {
    if (t.broker !== scope.broker) continue;
    const ext = String(t.ext_id ?? "");
    if (ext.includes(":adj:") || ext.includes(":pos:")) continue; // corrections, not trades
    const acc = t.broker_account ?? (scope.adoptLegacy ? scope.account ?? null : null);
    const k = contentKey(t.ticker, t.side, t.shares, t.executed_at, acc);
    stored.set(k, (stored.get(k) ?? 0) + 1);
  }
  /** Consume one stored copy of this trade; true when one was already there. */
  const consumeStored = (r: NormalizedRow) => {
    const k = contentKey(r.ticker!, r.side!, r.shares!, r.executed_at, r.account ?? scope.account ?? null);
    const n = stored.get(k) ?? 0;
    if (n <= 0) return false;
    stored.set(k, n - 1);
    return true;
  };
  const hasExtId = (r: NormalizedRow) => txExt.has(`${r.broker}:${r.external_id}`);
  // Id matches are exact, content matches are a fallback — so the stored copies an id match
  // accounts for are reserved up front, before any content-only lookup. Otherwise the
  // outcome depended on file order: a second same-size buy of the ticker that day (other
  // time, price and id) listed BEFORE the stored one consumed its copy and was skipped as a
  // "duplicate", then the stored one matched by id — and the real second buy was lost.
  const reserved = new Map<NormalizedRow, boolean>();
  for (const r of incoming) {
    if (r.kind === "TRADE" && hasExtId(r)) reserved.set(r, consumeStored(r));
  }
  return {
    hasExtId,
    /** True when this trade is already stored, by id or by content. Consumes one stored copy. */
    tradeAlreadyStored(r: NormalizedRow): boolean {
      if (reserved.has(r)) return true; // matched by id; its stored copy was reserved above
      if (hasExtId(r)) { consumeStored(r); return true; }
      return consumeStored(r);
    },
  };
}
