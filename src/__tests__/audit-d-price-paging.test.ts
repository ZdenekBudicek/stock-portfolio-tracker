import { describe, expect, it } from 'vitest';
import { fetchAllRows, fetchFinnhub, fetchRowsBySymbols, latestCloses } from '../../supabase/functions/_shared/price-providers';

// Minimal PostgREST-like fake: filters + orders applied in memory, every response capped at 1000 rows.
function fakeClient(tables: Record<string, any[]>, opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const client = {
    calls,
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      const orders: [string, boolean][] = [];
      let lim = Infinity;
      const run = (from = 0, to = Infinity) => {
        calls.push(table);
        if (opts.failOn === table) return Promise.resolve({ data: null, error: { message: 'boom' } });
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        rows = [...rows].sort((a, b) => {
          for (const [k, asc] of orders) { if (a[k] < b[k]) return asc ? -1 : 1; if (a[k] > b[k]) return asc ? 1 : -1; }
          return 0;
        });
        rows = rows.slice(from, Math.min(to + 1, from + 1000)).slice(0, lim);
        return Promise.resolve({ data: rows, error: null });
      };
      const q: any = {
        select: () => q,
        in: (k: string, v: any[]) => { filters.push((r) => v.includes(r[k])); return q; },
        eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
        gt: (k: string, v: any) => { filters.push((r) => r[k] > v); return q; },
        gte: (k: string, v: any) => { filters.push((r) => r[k] >= v); return q; },
        order: (k: string, o: { ascending: boolean }) => { orders.push([k, o.ascending]); return q; },
        limit: (n: number) => { lim = n; return run(); },
        range: (f: number, t: number) => run(f, t),
      };
      return q;
    },
  };
  return client;
}

const day = (i: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);

describe('PostgREST paging helpers (audit D #23)', () => {
  it('fetchAllRows reads past the 1000-row cap and throws on a failed read', async () => {
    const c = fakeClient({ t: Array.from({ length: 2500 }, (_, i) => ({ id: i })) });
    const rows = await fetchAllRows('t', (f, to) => c.from('t').select('*').order('id', { ascending: true }).range(f, to));
    expect(rows).toHaveLength(2500);
    const bad = fakeClient({}, { failOn: 't' });
    await expect(fetchAllRows('t', (f, to) => bad.from('t').range(f, to))).rejects.toThrow(/boom/);
  });

  it('fetchRowsBySymbols returns rows for every requested symbol across chunks', async () => {
    const syms = Array.from({ length: 250 }, (_, i) => `S${i}`);
    const c = fakeClient({ price_cache: [...syms, 'OTHER'].map((symbol) => ({ symbol, price: 1 })) });
    const rows = await fetchRowsBySymbols(syms, (chunk, f, t) => c.from('price_cache').select('*').in('symbol', chunk).order('symbol', { ascending: true }).range(f, t), 'price_cache');
    expect(new Set(rows.map((r) => r.symbol))).toEqual(new Set(syms));
  });

  it('latestCloses keeps the latest close per symbol, even when other symbols have >1000 newer rows', async () => {
    const rows: any[] = [];
    for (let s = 0; s < 60; s++) for (let d = 0; d < 30; d++) rows.push({ symbol: `A${s}`, date: day(300 + d), close: 100 + d });
    rows.push({ symbol: 'OLD', date: day(10), close: 7 }, { symbol: 'OLD', date: day(5), close: 6 });
    rows.push({ symbol: 'Z', date: day(329), close: 0 }, { symbol: 'Z', date: day(328), close: 9 });
    const c = fakeClient({ price_history: rows });
    const now = Date.parse(day(330));
    const m = await latestCloses(c, [...Array.from({ length: 60 }, (_, i) => `A${i}`), 'OLD', 'Z', 'NONE'], { now });
    expect(m.get('A0')).toEqual({ date: day(329), close: 129 });
    expect(m.get('A59')).toEqual({ date: day(329), close: 129 });
    expect(m.get('OLD')).toEqual({ date: day(10), close: 7 }); // outside the window -> own query
    expect(m.get('Z')).toEqual({ date: day(328), close: 9 }); // zero close skipped
    expect(m.has('NONE')).toBe(false);
  });
});

describe('fetchFinnhub pacing (audit D scalability)', () => {
  const ok = (c: number) => ({ status: 200, json: async () => ({ c, pc: c, dp: 0 }) }) as any;

  it('spaces calls and stops at maxCalls', async () => {
    let t = 0;
    const starts: number[] = [];
    const out = await fetchFinnhub(['A', 'B', 'C', 'D'], 'k', {
      maxCalls: 3, minIntervalMs: 1100, now: () => t,
      sleepImpl: async (ms) => { t += ms; },
      fetchImpl: (async () => { starts.push(t); t += 100; return ok(10); }) as any,
    });
    expect([...out.keys()]).toEqual(['A', 'B', 'C']);
    expect(starts).toEqual([0, 1100, 2200]);
  });

  it('stops on HTTP 429 and does not mark the limited symbol as attempted', async () => {
    const attempted = new Set<string>();
    let n = 0;
    const out = await fetchFinnhub(['A', 'B', 'C'], 'k', {
      attempted,
      fetchImpl: (async () => (++n === 2 ? ({ status: 429, json: async () => ({}) }) : ok(5))) as any,
    });
    expect([...out.keys()]).toEqual(['A']);
    expect([...attempted]).toEqual(['A']);
    expect(n).toBe(2);
  });

  it('stops at the deadline', async () => {
    let t = 0;
    const out = await fetchFinnhub(['A', 'B', 'C'], 'k', {
      deadline: 1500, minIntervalMs: 1000, now: () => t, sleepImpl: async (ms) => { t += ms; },
      fetchImpl: (async () => ok(1)) as any,
    });
    expect([...out.keys()]).toEqual(['A', 'B']);
  });
});
