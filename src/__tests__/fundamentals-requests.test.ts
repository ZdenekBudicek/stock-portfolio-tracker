import { describe, expect, it } from 'vitest';
import { planFundamentalsRequest } from '../../supabase/functions/_shared/fundamentalsRequests.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('planFundamentalsRequest', () => {
  it('dispatches only companies nobody has data for, via their canonical symbol', () => {
    const r = planFundamentalsRequest({
      tickers: ['fb', 'NEWCO', 'META', 'BTC', 'CASH', 'bad ticker!'],
      aliases: [{ alias: 'FB', canonical: 'META', yahoo_symbol: null }],
      existing: ['META'], requests: [], now: NOW,
    });
    expect(r.dispatch).toEqual([{ ticker: 'NEWCO', symbol: 'NEWCO' }]);
    expect(r.known).toEqual(['META']);
    expect(r.ignored).toEqual(expect.arrayContaining(['BTC']));
  });

  it('does not repeat a running request or one that finished today', () => {
    const r = planFundamentalsRequest({
      tickers: ['RUN', 'DONE', 'OLD', 'STUCK'], aliases: [], existing: [], now: NOW,
      requests: [
        { symbol: 'RUN', status: 'pending', requested_at: ago(5) },
        { symbol: 'DONE', status: 'failed', requested_at: ago(120), finished_at: ago(100) },
        { symbol: 'OLD', status: 'failed', requested_at: ago(3000), finished_at: ago(2000) },
        { symbol: 'STUCK', status: 'pending', requested_at: ago(45) },
      ],
    });
    expect(r.recent).toEqual(['RUN', 'DONE']);
    expect(r.dispatch.map((d) => d.symbol)).toEqual(['OLD', 'STUCK']);
  });

  it('caps the number of tickers per call', () => {
    const r = planFundamentalsRequest({ tickers: Array.from({ length: 30 }, (_, i) => `T${i}`), aliases: [], existing: [], requests: [], now: NOW });
    expect(r.dispatch).toHaveLength(10);
  });

  it('keeps the ticker as the data spells it and keys the request by the canonical symbol', () => {
    const r = planFundamentalsRequest({
      tickers: ['BATSl'], aliases: [{ alias: 'BATSl', canonical: 'BATS', yahoo_symbol: 'BATS.L' }], existing: [], requests: [], now: NOW,
    });
    expect(r.dispatch).toEqual([{ ticker: 'BATSl', symbol: 'BATS' }]);
  });
});
