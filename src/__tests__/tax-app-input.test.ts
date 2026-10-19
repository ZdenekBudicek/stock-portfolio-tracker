import { describe, expect, it } from 'vitest';
import { buildTaxInput, localDate } from '@/lib/tax/appInput';
import { taxEngineFor, parseTaxProfile } from '@/lib/tax/engines';

const usProfile = parseTaxProfile({
  version: 1, residence: 'US', year: 2025, filingStatus: 'single',
  otherOrdinaryTaxableIncome: 50_000, otherMagi: 70_000, otherNetInvestmentIncome: 0,
  shortTermLossCarry: 0, longTermLossCarry: 0, foreignTaxCreditLimit: 0,
});
const tx = (id: string, side: 'BUY' | 'SELL', shares: number, price: number, at: string, extra: Record<string, unknown> = {}): any =>
  ({ id, ticker: 'AAPL', side, shares, price_usd: price, executed_at: at, broker: 'T212', broker_account: '1', ...extra });

describe('buildTaxInput', () => {
  it('uses the trade day in the country time zone', () => {
    // 03:30 UTC on 2 Jan is still 1 Jan in New York
    expect(localDate('2025-01-02T03:30:00Z', 'America/New_York')).toBe('2025-01-01');
  });

  it('drops synthetic reconciliation rows and unrecorded dividends, and runs the US engine', () => {
    const input = buildTaxInput({
      profile: usProfile, today: '2026-03-01', kindOf: () => 'stock',
      transactions: [
        tx('b1', 'BUY', 20, 100, '2023-06-01T15:00:00Z'),
        tx('s1', 'SELL', 10, 150, '2025-06-02T15:00:00Z'),
        tx('adj', 'SELL', 1, 0, '2025-07-01T15:00:00Z', { ext_id: 't212:adj:1:AAPL' }),
      ],
      dividends: [
        { id: 'd1', ticker: 'AAPL', status: 'paid', broker: 'manual', amount_per_share: 1, total_amount_usd: 8.5, ex_date: '2025-05-01', pay_date: '2025-05-15', shares_held: 10 } as never,
        { id: 'd2', ticker: 'AAPL', status: 'paid', broker: 'auto', amount_per_share: 1, total_amount_usd: 10, ex_date: '2025-08-01', pay_date: '2025-08-15', shares_held: 10 } as never,
      ],
    });
    expect(input.trades.map((t) => t.id)).toEqual(['b1', 's1']);
    expect(input.dividends).toHaveLength(1);
    expect(input.provisional).toBe(false); // 2025 is closed and the 30-day look-ahead has passed
    const report = taxEngineFor('US').report(input);
    expect(report.rows[0]).toMatchObject({ classification: expect.stringMatching(/long/i), gain: 500 });
    expect(report.complete).toBe(true);
  });

  it('marks the current year as a provisional estimate instead of blanking it', () => {
    const p = parseTaxProfile({ ...usProfile, year: 2026 });
    const input = buildTaxInput({ profile: p, today: '2026-10-19', kindOf: () => 'stock', dividends: [],
      transactions: [tx('b1', 'BUY', 10, 100, '2026-01-05T15:00:00Z'), tx('s1', 'SELL', 10, 120, '2026-05-05T15:00:00Z')] });
    expect(input.provisional).toBe(true);
    const report = taxEngineFor('US').report(input);
    expect(report.estimatedTax).not.toBeNull();
    expect(report.warnings.some((w) => w.code === 'incomplete-ledger' && !w.blocking)).toBe(true);
  });
});

describe('normalizeSplits', () => {
  it('restates earlier trades in post-split shares and drops the split row', async () => {
    const { normalizeSplits } = await import('@/lib/tax/appInput');
    const out = normalizeSplits([
      tx('b1', 'BUY', 10, 1000, '2023-01-05T15:00:00Z'),
      tx('sp', 'BUY', 90, 0, '2024-06-10T15:00:00Z', { ext_id: 'revolut:split:NVDA' }),
      tx('s1', 'SELL', 50, 120, '2025-01-05T15:00:00Z'),
    ]);
    expect(out.map((t) => t.id)).toEqual(['b1', 's1']);
    expect(out[0]).toMatchObject({ shares: 100, price_usd: 100 }); // same $10,000 cost, 10:1
    const report = taxEngineFor('US').report(buildTaxInput({ profile: usProfile, today: '2026-03-01', kindOf: () => 'stock', dividends: [], transactions: out }));
    expect(report.warnings.some((w) => w.code === 'corporate-action' || w.code === 'unmatched-sell')).toBe(false);
    expect(report.rows[0]).toMatchObject({ gain: 1000, classification: expect.stringMatching(/long/i) });
  });
});

describe('attributeManualSells', () => {
  it('lets a hand-entered sale use the oldest lots of another account, like the Czech FIFO', async () => {
    const { attributeManualSells } = await import('@/lib/tax/appInput');
    const out = attributeManualSells([
      tx('b1', 'BUY', 5, 100, '2023-01-05T15:00:00Z', { broker: 'Revolut', broker_account: 'R1' }),
      tx('b2', 'BUY', 5, 110, '2023-02-05T15:00:00Z', { broker: 'T212', broker_account: '1' }),
      tx('s1', 'SELL', 8, 150, '2025-03-05T15:00:00Z', { broker: 'manual', broker_account: null, fee_usd: 8 }),
    ]);
    const sells = out.filter((t) => t.side === 'SELL');
    expect(sells.map((t) => [t.id, t.broker_account, t.shares, t.fee_usd])).toEqual([['s1#1', 'R1', 5, 5], ['s1#2', '1', 3, 3]]);
    const report = taxEngineFor('US').report(buildTaxInput({ profile: usProfile, today: '2026-03-01', kindOf: () => 'stock', dividends: [], transactions: out }));
    expect(report.warnings.some((w) => w.code === 'unmatched-sell')).toBe(false);
  });
});

describe('normalizeMergers', () => {
  it('turns a stock-for-stock merger into a continuation of the lots and leaves an unpaid cash buyout flagged', async () => {
    const { normalizeMergers } = await import('@/lib/tax/appInput');
    const R = { broker: 'Revolut', broker_account: 'R1' };
    const out = normalizeMergers([
      { ...tx('b1', 'BUY', 40, 5, '2021-01-05T15:00:00Z', R), ticker: 'ZNGA' },
      { ...tx('mo', 'SELL', 40, 0, '2022-05-26T04:18:28Z', { ...R, ext_id: 'revolut:x:merger:ZNGA' }), ticker: 'ZNGA' },
      { ...tx('mi', 'BUY', 1.6, 0, '2022-05-26T04:18:28Z', { ...R, ext_id: 'revolut:x:merger:TTWO' }), ticker: 'TTWO' },
      { ...tx('b2', 'BUY', 3, 80, '2021-02-05T15:00:00Z', R), ticker: 'AVLR' },
      { ...tx('mo2', 'SELL', 3, 0, '2022-10-20T05:10:07Z', { ...R, ext_id: 'revolut:y:merger:AVLR' }), ticker: 'AVLR' },
    ]);
    expect(out.find((t) => t.id === 'b1')).toMatchObject({ ticker: 'TTWO', shares: 1.6, price_usd: 125 }); // same $200
    expect(out.some((t) => t.id === 'mo' || t.id === 'mi')).toBe(false);
    expect(out.find((t) => t.id === 'mo2')).toMatchObject({ ext_id: 'revolut:y:merger:AVLR' }); // no recorded cash: left for the engine to flag
  });
});

describe('heldForQualification', () => {
  it('needs more than 60 days of holding around the ex-date', async () => {
    const { heldForQualification } = await import('@/lib/tax/appInput');
    const long = [tx('b', 'BUY', 10, 100, '2025-01-02T15:00:00Z')];
    expect(heldForQualification(long, 'AAPL', '2025-05-09')).toBe(true);
    const short = [tx('b', 'BUY', 10, 100, '2025-05-01T15:00:00Z'), tx('s', 'SELL', 10, 110, '2025-05-20T15:00:00Z')];
    expect(heldForQualification(short, 'AAPL', '2025-05-09')).toBe(false);
  });
});

describe('review fixes', () => {
  it('counts holding days on both sides of the ex-date', async () => {
    const { heldForQualification } = await import('@/lib/tax/appInput');
    const split = [tx('b', 'BUY', 10, 100, '2025-04-09T15:00:00Z'), tx('s', 'SELL', 10, 110, '2025-06-18T15:00:00Z')];
    expect(heldForQualification(split, 'AAPL', '2025-05-09')).toBe(true); // 70 days
  });
  it('does not rename old lots when the account already traded the new ticker', async () => {
    const { normalizeMergers } = await import('@/lib/tax/appInput');
    const R = { broker: 'Revolut', broker_account: 'R1' };
    const out = normalizeMergers([
      { ...tx('o1', 'BUY', 10, 100, '2021-01-05T15:00:00Z', R), ticker: 'OLD' },
      { ...tx('n1', 'BUY', 1, 900, '2021-06-05T15:00:00Z', R), ticker: 'NEW' },
      { ...tx('n2', 'SELL', 1, 1000, '2022-01-05T15:00:00Z', R), ticker: 'NEW' },
      { ...tx('mo', 'SELL', 10, 0, '2022-05-26T04:18:28Z', { ...R, ext_id: 'r:x:merger:OLD' }), ticker: 'OLD' },
      { ...tx('mi', 'BUY', 2, 0, '2022-05-26T04:18:28Z', { ...R, ext_id: 'r:x:merger:NEW' }), ticker: 'NEW' },
    ]);
    expect(out.find((t) => t.id === 'o1')!.ticker).toBe('OLD');
    expect(out.some((t) => t.id === 'mo')).toBe(true); // left for the engine to flag in 2022
  });
  it('a buyout without recorded cash is not turned into a $0 sale and does not block a later year', async () => {
    const R = { broker: 'Revolut', broker_account: 'R1' };
    const p = parseTaxProfile({ ...usProfile, year: 2025 });
    const input = buildTaxInput({ profile: p, today: '2026-03-01', kindOf: () => 'stock', dividends: [], transactions: [
      { ...tx('b', 'BUY', 3, 80, '2021-02-05T15:00:00Z', R), ticker: 'AVLR' },
      { ...tx('m', 'SELL', 3, 0, '2022-10-20T05:10:07Z', { ...R, ext_id: 'r:y:merger:AVLR' }), ticker: 'AVLR' },
      tx('b1', 'BUY', 1, 100, '2024-01-05T15:00:00Z'), tx('s1', 'SELL', 1, 150, '2025-03-05T15:00:00Z'),
    ] });
    const r = taxEngineFor('US').report(input);
    expect(r.estimatedTax).not.toBeNull();
    expect(r.warnings.filter((w) => w.blocking)).toHaveLength(0);
  });
});
