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
 * True for a stored row executeImport deletes before writing the statement: an API fill of
 * the statement's account (or an account-less one the import adopts for it) within the
 * statement's days. Must mirror the delete in executeImport exactly.
 */
export function replacedByStatement(t: ExistingTx, scope: StatementScope): boolean {
  if (scope.broker !== "T212" || t.broker !== "T212") return false;
  if (!String(t.ext_id ?? "").startsWith("t212:ord:")) return false;
  if (!scope.replaceApiFillsBefore || !(ms(t.executed_at) < ms(scope.replaceApiFillsBefore))) return false;
  return scope.account
    ? t.broker_account === scope.account || (scope.adoptLegacy && !t.broker_account)
    : !t.broker_account;
}

const contentKey = (ticker: string, side: string, shares: number, isoDate: string, account: string | null) =>
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
export function createDuplicateGuard(existing: ExistingTx[], scope: StatementScope) {
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
  return {
    hasExtId,
    /** True when this trade is already stored, by id or by content. Consumes one stored copy. */
    tradeAlreadyStored(r: NormalizedRow): boolean {
      if (hasExtId(r)) { consumeStored(r); return true; }
      return consumeStored(r);
    },
  };
}
