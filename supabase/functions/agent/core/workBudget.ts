import type { CpuPolicy } from './calculations.ts';
import { ToolInputError } from './types.ts';

// Request-level CPU budget (Běh 18). Synchronous models cannot be interrupted by a timer or an
// AbortSignal once they start, so every tool of one request asks this ledger BEFORE starting one:
// the estimated cost of all models already run plus the next one must stay within the request
// budget, otherwise the tool is refused with a human message. History is never truncated.

/** One unit of synchronous model work, priced by the measured cost model in docs/ai-assistant/cpu-policy.json. */
export const WORK_KINDS = ['fifo_real', 'fifo_all', 'portfolio', 'realized_year', 'cz_tax', 'cz_sale', 'foreign_tax', 'foreign_sale',
  'performance', 'dividend_forecast', 'allocation'] as const;
export type WorkKind = typeof WORK_KINDS[number];
// Snapshot-dependent models (daily history) also carry a per-1,000-snapshot term.
export type WorkCost = { fixedMs: number; per1000TransactionsMs: number; per1000SnapshotsMs?: number };
export interface WorkPolicy extends CpuPolicy { requestWorkMs: number; costs: Record<WorkKind, WorkCost> }
export type WorkSize = { transactions: number; snapshots: number };

// FIFO runs at most once per request through the calculation cache, so it is charged once.
const SHARED: ReadonlySet<WorkKind> = new Set<WorkKind>(['fifo_real', 'fifo_all']);
export const HISTORY_LIMIT_MESSAGE = 'Tuto rozsáhlou historii teď nedokážu bezpečně dopočítat, otevři přehled v Trackoře.';
export const WORK_LIMIT_MESSAGE = 'Na jednu otázku je to teď příliš mnoho výpočtů. Zeptej se prosím zvlášť nebo na kratší období, '
  + 'případně otevři přehled v Trackoře.';

const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: number, max: number) => Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(max) && max >= 0 && value <= max;

function validPolicy(policy: WorkPolicy): boolean {
  return !!policy && nonNegative(policy.requestWorkMs) && !!policy.costs
    && WORK_KINDS.every(kind => nonNegative(policy.costs[kind]?.fixedMs) && nonNegative(policy.costs[kind]?.per1000TransactionsMs)
      && nonNegative(policy.costs[kind]?.per1000SnapshotsMs ?? 0));
}

export function estimateWorkMs(policy: WorkPolicy, kind: WorkKind, size: WorkSize): number {
  const cost = policy.costs[kind];
  return cost.fixedMs + (cost.per1000TransactionsMs * size.transactions + (cost.per1000SnapshotsMs ?? 0) * size.snapshots) / 1000;
}

export type WorkLedger = {
  readonly policy: WorkPolicy;
  spentMs(): number;
  /**
   * Runs `work` once per `key` in this request. Before it starts, the estimate of `kinds` over the
   * full history is added to what the request already spent; over budget → refused, nothing runs.
   */
  run<T>(key: string, size: WorkSize, kinds: readonly WorkKind[], work: () => T): T;
};

/** One ledger per chat request; never shared between requests or users. */
export function createWorkLedger(policy: WorkPolicy): WorkLedger {
  const results = new Map<string, unknown>(), charged = new Set<WorkKind>();
  let spent = 0;
  return {
    policy,
    spentMs: () => spent,
    run<T>(key: string, size: WorkSize, kinds: readonly WorkKind[], work: () => T): T {
      if (!validPolicy(policy)) throw new ToolInputError('unavailable', HISTORY_LIMIT_MESSAGE);
      if (!count(size.transactions, policy.maxTransactions) || !count(size.snapshots, policy.maxSnapshots)) {
        throw new ToolInputError('unavailable', HISTORY_LIMIT_MESSAGE);
      }
      if (results.has(key)) return results.get(key) as T;
      const due = kinds.filter((kind, i) => !(SHARED.has(kind) && (charged.has(kind) || kinds.indexOf(kind) !== i)));
      const estimate = due.reduce((sum, kind) => sum + estimateWorkMs(policy, kind, size), 0);
      if (!(spent + estimate <= policy.requestWorkMs)) throw new ToolInputError('unavailable', WORK_LIMIT_MESSAGE);
      spent += estimate;
      for (const kind of due) if (SHARED.has(kind)) charged.add(kind);
      // A failing model stays charged (its work happened) but is not cached.
      const value = work();
      results.set(key, value);
      return value;
    },
  };
}
