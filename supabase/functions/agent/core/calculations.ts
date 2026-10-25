export type AgentLib = typeof import('../_lib/trackora-lib.js');
export interface CpuPolicy { mode: 'full' | 'limited'; maxTransactions: number; maxSnapshots: number; }

// Call with full fetched-history counts before starting any synchronous model. Abort
// cannot interrupt FIFO once it starts; an oversized history must never be truncated.
export function computeWithinLimits<T>(size: { transactions: number; snapshots: number }, work: () => T, policy: CpuPolicy = manifest.cpuPolicy as CpuPolicy):
  { status: 'ready'; value: T } | { status: 'unavailable'; reason: string } {
  const within = (count: number, max: number) => Number.isSafeInteger(count) && count >= 0
    && Number.isSafeInteger(max) && max >= 0 && count <= max;
  if (!within(size.transactions, policy.maxTransactions) || !within(size.snapshots, policy.maxSnapshots)) {
    return { status: 'unavailable', reason: HISTORY_LIMIT_MESSAGE };
  }
  return { status: 'ready', value: work() };
}
import manifest from '../_lib/manifest.json' with { type: 'json' };
import { HISTORY_LIMIT_MESSAGE } from './workBudget.ts';
