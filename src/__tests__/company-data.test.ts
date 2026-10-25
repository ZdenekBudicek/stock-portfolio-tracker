// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { edgarOnlyFundamentals, fiscalEnd, inferSplits, LIVE_TTL_MS, liveDue, parseNasdaqSnapshot } from '../../supabase/functions/_shared/companyData.js';
import { valuationInputs } from '@/lib/fairValue';

// Ocenění v3: company data fetched live from SEC EDGAR and Nasdaq (company-data edge function).
type Fact = { start?: string; end: string; val: number; filed: string; form?: string };
const facts = (concepts: Record<string, { unit: string; list: Fact[] }>) => ({
  facts: { 'us-gaap': Object.fromEntries(Object.entries(concepts).map(([name, c]) => [name, { units: { [c.unit]: c.list } }])) },
});
const q = (start: string, end: string, val: number, filed = '2026-08-01') => ({ start, end, val, filed });
// A year of quarters (Q4 only as FY − 9M), net income 100/quarter, 50 diluted shares; a 10:1 split mid-2025.
const sample = () => facts({
  Revenues: { unit: 'USD', list: [q('2025-01-01', '2025-03-31', 1000), q('2025-01-01', '2025-06-30', 2000), q('2025-01-01', '2025-09-30', 3000),
    q('2025-01-01', '2025-12-31', 4000, '2026-02-01'), q('2026-01-01', '2026-03-31', 1100), q('2026-01-01', '2026-06-30', 2300)] },
  NetIncomeLoss: { unit: 'USD', list: [q('2025-01-01', '2025-03-31', 100), q('2025-01-01', '2025-06-30', 200), q('2025-01-01', '2025-09-30', 300),
    q('2025-01-01', '2025-12-31', 400, '2026-02-01'), q('2026-01-01', '2026-03-31', 110), q('2026-01-01', '2026-06-30', 230)] },
  WeightedAverageNumberOfDilutedSharesOutstanding: { unit: 'shares', list: [q('2025-01-01', '2025-03-31', 5, '2025-05-01'),
    q('2025-04-01', '2025-06-30', 50), q('2025-07-01', '2025-09-30', 50), q('2026-01-01', '2026-03-31', 50), q('2026-04-01', '2026-06-30', 50)] },
  EarningsPerShareDiluted: { unit: 'USD/shares', list: [q('2025-01-01', '2025-03-31', 20, '2025-05-01'), q('2025-04-01', '2025-06-30', 2),
    q('2025-07-01', '2025-09-30', 2), q('2026-01-01', '2026-03-31', 2.2), q('2026-04-01', '2026-06-30', 2.4)] },
});

describe('live statements from SEC EDGAR', () => {
  it('infers a split from the share count and restates the earlier periods', () => {
    const f = edgarOnlyFundamentals(sample(), 'TEST', '2026-10-24T00:00:00Z')!;
    expect(f).toMatchObject({ symbol: 'TEST', currency: 'USD', status: 'ok', source: 'sec_live' });
    const i = f.quarterly.periods.indexOf('2025-03-31');
    expect(f.quarterly.values.dilutedShares[i]).toBe(50);
    expect(f.quarterly.values.dilutedEps[i]).toBeCloseTo(2, 10);
  });
  it('fills the Q4 EPS the SEC never files (net income / nearest diluted shares), so TTM EPS exists', () => {
    const f = edgarOnlyFundamentals(sample(), 'TEST', '2026-10-24T00:00:00Z')!;
    const q4 = f.quarterly.periods.indexOf('2025-12-31');
    expect(f.quarterly.values.dilutedEps[q4]).toBeCloseTo(100 / 50, 10);
    expect(valuationInputs(f).eps).toEqual({ value: expect.closeTo(2 + 2 + 2.2 + 2.4, 10), source: 'ttm' });
  });
  it('uses a provider share count only when the filings give none', () => {
    const noShares = sample();
    delete (noShares.facts['us-gaap'] as Record<string, unknown>).WeightedAverageNumberOfDilutedSharesOutstanding;
    expect(valuationInputs(edgarOnlyFundamentals(noShares, 'V', '2026-10-24T00:00:00Z')!).shares).toBeNull();
    expect(valuationInputs(edgarOnlyFundamentals(noShares, 'V', '2026-10-24T00:00:00Z', 2.1e9)!).shares).toBe(2.1e9);
    expect(valuationInputs(edgarOnlyFundamentals(sample(), 'T', '2026-10-24T00:00:00Z', 1e12)!).shares).toBe(50);
    expect(edgarOnlyFundamentals({ facts: {} }, 'NONE', '2026-10-24T00:00:00Z')).toBeNull();
  });
  it('finds whole-number splits only', () => {
    const rows = (counts: number[]) => ({ annual: new Map(), quarterly: new Map(counts.map((c, i) => [`2025-0${i + 1}-28`, { dilutedShares: c }])) });
    expect(inferSplits(rows([10, 40, 41]))).toEqual([{ date: expect.any(String), ratio: 4 }]);
    expect(inferSplits(rows([10, 13, 17]))).toEqual([]);
  });
});

describe('live analyst consensus from Nasdaq', () => {
  const forecast = { data: { yearlyForecast: { rows: [
    { fiscalEnd: 'Dec 2025', consensusEPSForecast: 4, noOfEstimates: 20 },
    { fiscalEnd: 'Dec 2026', consensusEPSForecast: 6.5, noOfEstimates: 18 }, { fiscalEnd: 'Dec 2027', consensusEPSForecast: 14.14, noOfEstimates: 19 },
    { fiscalEnd: 'Dec 2028', consensusEPSForecast: 20.49, noOfEstimates: 3 }, { fiscalEnd: 'Dec 2029', consensusEPSForecast: 22.39, noOfEstimates: 1 },
    { fiscalEnd: 'Dec 2030', consensusEPSForecast: 30, noOfEstimates: 1 }] } } };
  const target = { data: { consensusOverview: { lowPriceTarget: 465, highPriceTarget: 1250, priceTarget: 663.28, buy: 29, sell: 0, hold: 6 } } };
  it('maps open fiscal years to current / next / later and keeps targets in the trading currency', () => {
    const v = parseNasdaqSnapshot(forecast, target, 'AMD', '2026-10-24')!;
    expect(v).toMatchObject({ ticker: 'AMD', consensus: 'buy', targetMean: 663.28, targetLow: 465, targetHigh: 1250, currency: 'USD', currencyBasis: 'trading',
      counts: { buy: 29, hold: 6, sell: 0, strongBuy: null }, estimatesCurrency: 'USD', source: 'nasdaq' });
    expect(v.estimates!.map(e => [e.period, e.endDate, e.eps, e.analysts])).toEqual([
      ['current', '2026-12-31', 6.5, 18], ['next', '2027-12-31', 14.14, 19], ['later', '2028-12-31', 20.49, 3], ['later', '2029-12-31', 22.39, 1]]);
    expect(v.estimates![1].epsGrowth).toBeCloseTo(14.14 / 6.5 - 1, 12);
    expect(v.estimates![0].revenue).toBeNull();
  });
  it('returns nothing for an empty answer and parses fiscal year ends', () => {
    expect(parseNasdaqSnapshot({ data: null }, { data: null }, 'X', '2026-10-24')).toBeNull();
    expect(fiscalEnd('Feb 2028')).toBe('2028-02-29');
    expect(fiscalEnd('Sep 2027')).toBe('2027-09-30');
    expect(fiscalEnd('2027')).toBeNull();
  });
  it('refreshes live data after three days or when missing / failed', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(liveDue(null, now)).toBe(true);
    expect(liveDue({ status: 'error', fetched_at: new Date(now).toISOString(), data: {} }, now)).toBe(true);
    expect(liveDue({ status: 'ok', fetched_at: new Date(now - LIVE_TTL_MS + 1000).toISOString(), data: {} }, now)).toBe(false);
    expect(liveDue({ status: 'ok', fetched_at: new Date(now - LIVE_TTL_MS).toISOString(), data: {} }, now)).toBe(true);
  });
});
