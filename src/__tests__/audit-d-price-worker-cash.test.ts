import { beforeAll, describe, expect, it } from 'vitest';

// price-worker reads its env at import; give it dummies (main() only runs when executed directly).
let planDailySnapshots: any;
beforeAll(async () => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
  env.SUPABASE_URL ??= 'http://localhost';
  env.SUPABASE_SERVICE_KEY ??= 'test';
  ({ planDailySnapshots } = await import('../../scripts/price-worker.mjs'));
});

const D = 86_400_000;
const todayMs = Date.parse('2026-10-19T06:00:00Z');

describe('price-worker snapshot plan keeps cash-only days (audit D #12)', () => {
  it('keeps a recorded cash day with no holdings value and stamps live cash on today only', () => {
    // Holdings worth 100 until 16 Oct, everything sold after; cash recorded on 17 Oct.
    const valueOn = (day: string) => (day <= '2026-10-16' ? 100 : 0);
    const { snaps } = planDailySnapshots({
      uid: 'u', uFirst: '2026-10-14', todayMs, fxCzk: new Map(), valueOn,
      prevCash: new Map([['2026-10-15', 5], ['2026-10-17', 500]]), todayCash: 520,
    });
    const by = new Map(snaps.map((s: any) => [s.snapshot_date, s]));
    expect([...by.keys()]).toEqual(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-19']);
    expect((by.get('2026-10-17') as any).cash_usd).toBe(500);
    expect((by.get('2026-10-17') as any).value_usd).toBe(0);
    expect((by.get('2026-10-16') as any).cash_usd).toBeNull(); // today's cash not pushed to an older row
    expect((by.get('2026-10-19') as any).cash_usd).toBe(520);
    expect((by.get('2026-10-15') as any).cash_usd).toBe(5);
    // every row carries the same keys (PostgREST bulk insert)
    for (const s of snaps) expect(Object.keys(s).sort()).toEqual(Object.keys(snaps[0]).sort());
  });

  it('keeps a recorded cash day before the first holding instead of letting cleanup delete it', () => {
    const { snaps } = planDailySnapshots({
      uid: 'u', uFirst: '2026-10-18', todayMs, fxCzk: new Map(), valueOn: (d: string) => (d >= '2026-10-18' ? 50 : 0),
      prevCash: new Map([['2026-10-10', 7]]), todayCash: undefined,
    });
    expect(snaps[0].snapshot_date).toBe('2026-10-10');
    expect(snaps.at(-1).snapshot_date).toBe(new Date(todayMs - 0 * D).toISOString().slice(0, 10));
    expect(snaps.at(-1).cash_usd).toBeNull();
  });
});
