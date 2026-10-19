import { describe, expect, it } from 'vitest';
import { normalizeMergers } from '@/lib/tax/appInput';

// Merger cash is stored as a 0-share SELL with the payout in price_usd (statements.ts / fifo.ts).
describe('normalizeMergers cash buyout (audit D #8)', () => {
  const R = { broker: 'Revolut', broker_account: 'R1' };
  const row = (id: string, side: 'BUY' | 'SELL', shares: number, price: number, at: string, ext_id: string | null = null): any =>
    ({ id, ticker: 'OLD', side, shares, price_usd: price, executed_at: at, ext_id, ...R });

  it('sells the merged-out shares at the recorded payout, not shares x price of the 0-share row', () => {
    const out = normalizeMergers([
      row('b', 'BUY', 10, 80, '2021-01-05T15:00:00Z'),
      row('mo', 'SELL', 10, 0, '2022-05-26T04:18:28Z', 'r:x:merger:OLD'),
      row('mc', 'SELL', 0, 1000, '2022-05-26T04:18:28Z', 'r:x:mergercash:1000'),
    ]);
    expect(out.some((t) => t.id === 'mc')).toBe(false);
    const sale = out.find((t) => t.id === 'mo')!;
    expect(sale.ext_id).toBeNull();
    expect(sale.shares * sale.price_usd).toBeCloseTo(1000); // proceeds 1000 vs cost 800 → +200
  });
});
