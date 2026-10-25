import { withTimeout } from '../core/budget.ts';
import type { ReadContext } from '../core/dataTypes.ts';
import type { CallerQuery } from '../core/ports.ts';

export const PAGE_SIZE = 1000;
export function readWithinDeadline<T>(work: (signal: AbortSignal) => PromiseLike<T>, ctx: ReadContext): Promise<T> {
  return withTimeout(signal => Promise.resolve(work(signal)), 8000, {
    ...ctx, startedAt: Date.now(), remainingMs: () => Math.max(0, ctx.deadline - Date.now()),
  });
}

export async function readAllPages<T>(page: (from: number, to: number, signal: AbortSignal) => Promise<{ data: T[] | null; error: unknown }>, ctx: ReadContext): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await readWithinDeadline(signal => page(from, from + PAGE_SIZE - 1, signal), ctx);
    if (result.error || !Array.isArray(result.data) || result.data.length > PAGE_SIZE) throw new Error('Database read failed');
    rows.push(...result.data);
    if (result.data.length < PAGE_SIZE) return rows;
  }
}

export type ScanResult = { rows: Record<string, unknown>[]; changed: boolean };
/** A table holds more rows than the caller accepts (seen on the first page's exact count, before reading the rest). */
export class TooManyRows extends Error {
  constructor() { super('Too many rows'); this.name = 'TooManyRows'; }
}
// Count and boundary probes detect many concurrent edits, not an atomic REST snapshot.
export async function scanRows(query: () => CallerQuery, keys: readonly string[], ctx: ReadContext, maxRows?: number): Promise<ScanResult> {
  let expected: number | undefined, changed = false;
  const boundaries: { index: number; row: string }[] = [];
  const rows = await readAllPages<Record<string, unknown>>(async (from, to, signal) => {
    let q = query();
    for (const key of keys) q = q.order(key, { ascending: true });
    const result = await q.range(from, to).abortSignal(signal);
    if (result.error) throw new Error('Database read failed');
    if (typeof result.count !== 'number' || !Number.isSafeInteger(result.count) || result.count < 0) throw new Error('Database count unavailable');
    if (maxRows !== undefined && result.count > maxRows) throw new TooManyRows();
    if (expected === undefined) expected = result.count;
    if (expected !== result.count) changed = true;
    const data = result.data as Record<string, unknown>[] | null;
    if (Array.isArray(data) && data.length) {
      boundaries.push({ index: from, row: JSON.stringify(data[0]) }, { index: from + data.length - 1, row: JSON.stringify(data[data.length - 1]) });
    }
    return { data, error: result.error };
  }, ctx);
  if (rows.length !== expected) changed = true;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(keys.map(k => row[k]));
    if (seen.has(key)) changed = true;
    seen.add(key);
  }
  // Also probe an empty collection, so a concurrent first insertion is detected.
  if (!boundaries.length) boundaries.push({ index: 0, row: '' });
  for (const boundary of boundaries) {
    const result = await readWithinDeadline(signal => {
      let q = query();
      for (const key of keys) q = q.order(key, { ascending: true });
      return q.range(boundary.index, boundary.index).abortSignal(signal);
    }, ctx);
    if (result.error || !Array.isArray(result.data)) throw new Error('Database read failed');
    if (result.count !== expected || (result.data.length ? JSON.stringify(result.data[0]) : '') !== boundary.row) changed = true;
  }
  return { rows, changed };
}
