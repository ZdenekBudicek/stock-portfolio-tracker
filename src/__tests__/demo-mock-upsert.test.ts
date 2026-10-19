import { describe, it, expect } from 'vitest';
import { demoFetch } from '@/demo/mockBackend';
import { DEMO_USER_ID } from '@/demo/data';
const b = 'http://x.supabase.co/rest/v1/';
describe('demo upsert', () => {
  it('merges on conflict and ignores duplicates; NULL keys never conflict', async () => {
    // Start from exactly one row (the demo data set may already seed one).
    await demoFetch(b + 'user_settings?user_id=eq.' + DEMO_USER_ID, { method: 'DELETE' });
    await demoFetch(b + 'user_settings', { method: 'POST', body: JSON.stringify({ user_id: DEMO_USER_ID, tax_residence: 'CZ' }) });
    const up = () => demoFetch(b + 'user_settings?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: DEMO_USER_ID, tax_residence: 'SK' }) });
    await up(); await up();
    const r = await (await demoFetch(b + 'user_settings?select=tax_residence&user_id=eq.' + DEMO_USER_ID)).json();
    expect(r).toEqual([{ tax_residence: 'SK' }]);
    const ins = (t: string, broker: string | null, ext: string | null) => demoFetch(b + 'transactions?on_conflict=user_id,broker,ext_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: JSON.stringify([{ ticker: t, side: 'BUY', shares: 1, price_usd: 1, executed_at: '2025-01-01T00:00:00Z', broker, ext_id: ext }]) });
    await ins('ZZZ', null, null); await ins('ZZZ', null, null); await ins('YYY', 'T212', 'e1'); await ins('YYY', 'T212', 'e1');
    expect((await (await demoFetch(b + 'transactions?select=id&ticker=eq.ZZZ')).json()).length).toBe(2);
    expect((await (await demoFetch(b + 'transactions?select=id&ticker=eq.YYY')).json()).length).toBe(1);
  });
});
