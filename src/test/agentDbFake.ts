import { vi } from 'vitest';
import type { CallerDbClient } from '../../supabase/functions/agent/core/ports.ts';

export function fakeCaller(tables: Record<string, Record<string, unknown>[]> = {}) {
  const reads: { table: string; columns: string; order: string[]; from: number; to: number }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  let intercept: (table: string, from: number) => void = () => {};
  const errors = new Map<string, unknown>();
  const rpcResult = { data: null as unknown, error: null as unknown };
  const client = {
    from(table: string) {
      const order: string[] = [];
      let columns = '', from = 0, to = 999, head = false, deleted = false;
      const filters: [string, unknown][] = [];
      const query = {
        select(value: string, options?: { head?: boolean }) { columns = value; head = !!options?.head; return query; },
        order(value: string) { order.push(value); return query; },
        range(start: number, end: number) { from = start; to = end; return query; },
        eq(key: string, value: unknown) { filters.push([key, value]); return query; },
        delete() { deleted = true; return query; },
        abortSignal(_signal: AbortSignal) { return query; },
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve().then(() => {
            intercept(table, from);
            reads.push({ table, columns, order, from, to });
            const rows = (tables[table] ?? []).filter(r => filters.every(([k, v]) => r[k] === v))
              .slice().sort((a, b) => {
                for (const key of order) {
                  const c = typeof a[key] === 'number' && typeof b[key] === 'number'
                    ? Number(a[key]) - Number(b[key]) : String(a[key]).localeCompare(String(b[key]));
                  if (c) return c;
                }
                return 0;
              });
            if (deleted) tables[table] = (tables[table] ?? []).filter(r => !rows.includes(r));
            const data = head ? null : rows.slice(from, to + 1).map(r => Object.fromEntries(columns.split(',').map(k => [k, r[k]])));
            return { data, count: rows.length, error: errors.get(`${table}:${from}`) ?? null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      return { abortSignal: vi.fn().mockReturnValue(Promise.resolve(rpcResult)) };
    },
  } as unknown as CallerDbClient;
  return { client, tables, reads, rpcCalls, rpcResult, errors, intercept(fn: typeof intercept) { intercept = fn; } };
}
