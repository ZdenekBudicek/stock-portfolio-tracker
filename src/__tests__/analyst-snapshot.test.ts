import { describe, expect, it } from 'vitest';
import { analystsDue, parseAnalystSnapshot } from '../../scripts/analyst-snapshot.mjs';
import { analystRaw, marketNow } from '../test/agentMarketFixture';

describe('analyst snapshots', () => {
  it('parses targets, counts, currency and dated rating changes', () => {
    expect(parseAnalystSnapshot(analystRaw, 'RKLB')).toMatchObject({ ticker: 'RKLB', targetMean: 150, currency: 'USD', counts: { buy: 7, hold: 3, sell: 0 }, changes: [{ firm: 'Synthetic Research', from: 'Hold', to: 'Buy' }] });
  });
  it('takes the target currency from the trading currency, never from financialCurrency', () => {
    // An ADR: statements in TWD, the price and the analysts' targets in USD.
    const adr = structuredClone(analystRaw) as { quoteSummary: { result: Record<string, unknown>[] } };
    const result = adr.quoteSummary.result[0] as { financialData: Record<string, unknown>; price?: Record<string, unknown> };
    result.financialData.financialCurrency = 'TWD'; result.price = { currency: 'USD' };
    expect(parseAnalystSnapshot(adr, 'TSM')).toMatchObject({ targetMean: 150, currency: 'USD', currencyBasis: 'trading' });
    // Without the price module the target currency is unknown, even if financialCurrency says USD.
    delete result.price; result.financialData.financialCurrency = 'USD';
    expect(parseAnalystSnapshot(adr, 'TSM')).toMatchObject({ targetMean: 150, currency: null });
    expect(parseAnalystSnapshot(adr, 'TSM')).not.toHaveProperty('currencyBasis');
    // London quotes are in pence (GBp): not a currency code, so the targets stay without one.
    result.price = { currency: 'GBp' };
    expect(parseAnalystSnapshot(adr, 'BARC.L')).toMatchObject({ currency: null });
  });
  it('keeps absent targets/counts/currency null instead of zero', () => {
    const result = parseAnalystSnapshot({ quoteSummary: { result: [{ recommendationTrend: { trend: [{ period: '0m', buy: 7 }] } }] } }, 'RKLB');
    expect(result).toMatchObject({ targetMean: null, currency: null, counts: { buy: 7, hold: null }, changes: [] });
  });
  it.each([{}, { quoteSummary: { error: { code: 'Denied' }, result: [] } }, { quoteSummary: { result: [{}] } }])('rejects unusable payloads', raw => {
    expect(() => parseAnalystSnapshot(raw, 'RKLB')).toThrow();
  });
  it('uses an independent 24-hour success TTL and one-hour failed-attempt retry', () => {
    expect(analystsDue(null, marketNow)).toBe(true);
    const row = { fetched_at: new Date(marketNow - 25 * 3600000).toISOString(), last_attempt_at: null, status: 'ok' };
    expect(analystsDue(row, marketNow)).toBe(true);
    expect(analystsDue({ ...row, fetched_at: new Date(marketNow - 23 * 3600000).toISOString() }, marketNow)).toBe(false);
    expect(analystsDue({ ...row, status: 'error', last_attempt_at: new Date(marketNow - 1800000).toISOString() }, marketNow)).toBe(false);
    expect(analystsDue({ ...row, status: 'error', last_attempt_at: new Date(marketNow - 3600000).toISOString() }, marketNow)).toBe(true);
  });
});

describe('analyst snapshots: consensus estimates (Ocenění v2)', () => {
  it('reads EPS and revenue consensus for the current and next fiscal year from earningsTrend, in the statements\' currency', () => {
    const raw = structuredClone(analystRaw) as { quoteSummary: { result: Record<string, unknown>[] } };
    const result = raw.quoteSummary.result[0] as Record<string, unknown> & { financialData: Record<string, unknown> };
    result.financialData.financialCurrency = 'USD';
    result.earningsTrend = { trend: [
      { period: '0q', endDate: '2026-12-31', earningsEstimate: { avg: { raw: 1.1 } } },
      { period: '0y', endDate: '2026-12-31', growth: { raw: 0.62 }, earningsEstimate: { avg: { raw: 4.1 }, numberOfAnalysts: { raw: 40 } },
        revenueEstimate: { avg: { raw: 34e9 }, growth: { raw: 0.31 } } },
      { period: '+1y', endDate: '2027-12-31', growth: { raw: 0.45 }, earningsEstimate: { avg: { raw: 5.95 }, numberOfAnalysts: { raw: 38 } },
        revenueEstimate: { avg: { raw: 44e9 }, growth: { raw: 0.29 } } },
    ] };
    const view = parseAnalystSnapshot(raw, 'AMD');
    expect(view.estimates).toEqual([
      { period: 'current', endDate: '2026-12-31', eps: 4.1, revenue: 34e9, epsGrowth: 0.62, revenueGrowth: 0.31, analysts: 40 },
      { period: 'next', endDate: '2027-12-31', eps: 5.95, revenue: 44e9, epsGrowth: 0.45, revenueGrowth: 0.29, analysts: 38 },
    ]);
    expect(view.estimatesCurrency).toBe('USD');
  });
  it('leaves estimates out when earningsTrend is missing', () => {
    expect(parseAnalystSnapshot(analystRaw, 'RKLB').estimates).toBeUndefined();
  });
});
