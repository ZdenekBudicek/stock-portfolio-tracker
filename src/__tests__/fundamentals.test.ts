import { describe, expect, it } from 'vitest';
import { normalizeYahooFundamentals, YAHOO_FUNDAMENTAL_METRICS } from '../../supabase/functions/_shared/fundamentals.js';

const point = (asOfDate: string, raw: unknown, currencyCode = 'USD') => ({ asOfDate, currencyCode, reportedValue: { raw } });
const response = (...result: object[]) => ({ timeseries: { result, error: null } });

describe('normalizeYahooFundamentals', () => {
  it('sorts and aligns annual and quarterly metrics, preserving losses and cash outflows', () => {
    const json = response({
      annualTotalRevenue: [point('2025-12-31', 200), point('2023-12-31', 100)],
      annualNetIncome: [point('2024-12-31', -50)],
      annualOperatingCashFlow: [point('2025-12-31', -10)],
      annualCapitalExpenditure: [point('2025-12-31', -20)],
      annualRepurchaseOfCapitalStock: [point('2025-12-31', -5)],
      annualDilutedEPS: [point('2024-12-31', -1.25)],
    }, {
      quarterlyTotalRevenue: [point('2026-06-30', 60), point('2026-03-31', 50)],
      quarterlyOperatingIncome: [point('2026-03-31', -4)],
    });
    const original = JSON.stringify(json);
    const result = normalizeYahooFundamentals(json, 'NBIS', '2026-10-18T00:00:00.000Z');
    expect(result).toMatchObject({ symbol: 'NBIS', currency: 'USD', status: 'ok', fetchedAt: '2026-10-18T00:00:00.000Z' });
    expect(result.annual.periods).toEqual(['2023-12-31', '2024-12-31', '2025-12-31']);
    expect(result.annual.values.revenue).toEqual([100, null, 200]);
    expect(result.annual.values.netIncome).toEqual([null, -50, null]);
    expect(result.annual.values.dilutedEps).toEqual([null, -1.25, null]);
    expect(result.annual.values.capex).toEqual([null, null, -20]);
    expect(result.annual.values.buybacks).toEqual([null, null, -5]);
    expect(result.annual.values.freeCashFlow).toEqual([null, null, -30]);
    expect(result.quarterly.periods).toEqual(['2026-03-31', '2026-06-30']);
    expect(result.quarterly.values.operatingIncome).toEqual([-4, null]);
    for (const series of [result.annual, result.quarterly]) {
      expect(Object.keys(series.values).sort()).toEqual(Object.values(YAHOO_FUNDAMENTAL_METRICS).sort());
      for (const values of Object.values(series.values)) expect(values).toHaveLength(series.periods.length);
    }
    expect(JSON.stringify(json)).toBe(original);
  });

  it('requires both OCF and capex for derived FCF, or uses reported Yahoo FCF including zero', () => {
    const result = normalizeYahooFundamentals(response({
      annualOperatingCashFlow: [point('2022-12-31', 100), point('2024-12-31', 100), point('2025-12-31', 0)],
      annualCapitalExpenditure: [point('2023-12-31', -20), point('2024-12-31', 20), point('2025-12-31', 0)],
      annualFreeCashFlow: [point('2024-12-31', 0), point('2026-12-31', -50)],
      annualRepurchaseOfCapitalStock: [point('2024-12-31', 5)],
    }), 'META');
    expect(result.annual.values.freeCashFlow).toEqual([null, null, 0, 0, -50]);
    expect(result.annual.values.capex[2]).toBe(-20);
    expect(result.annual.values.buybacks[2]).toBe(-5);
  });

  it('handles annual-only data and leaves missing metrics null, never manufacturing zeros', () => {
    const result = normalizeYahooFundamentals(response({ annualTotalRevenue: [point('2025-12-31', 0, 'EUR')] }), 'SAP');
    expect(result.currency).toBe('EUR');
    expect(result.annual.values.revenue).toEqual([0]);
    expect(result.annual.values.grossProfit).toEqual([null]);
    expect(result.annual.values.freeCashFlow).toEqual([null]);
    expect(result.quarterly.periods).toEqual([]);
    for (const values of Object.values(result.quarterly.values)) expect(values).toEqual([]);
  });

  it('returns a deterministic empty error result for empty or failed responses', () => {
    for (const json of [null, {}, response(), { timeseries: { result: null, error: { code: 'Not Found' } } }]) {
      const result = normalizeYahooFundamentals(json, 'UNKNOWN');
      expect(result.status).toBe('error');
      expect(result.annual.periods).toEqual([]);
      expect(result.quarterly.periods).toEqual([]);
      expect(result).toEqual(normalizeYahooFundamentals(json, 'UNKNOWN'));
      expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
    }
  });

  it('rejects invalid numbers and dates without treating them as reported zeros', () => {
    const result = normalizeYahooFundamentals(response({ annualTotalRevenue: [
      point('2025-12-31', null), point('2024-12-31', NaN), point('2023-12-31', Infinity),
      point('2022-12-31', '100'), point('2026-02-30', 123), point('invalid', 100),
    ] }), 'X');
    expect(result.status).toBe('error');
    expect(result.annual.periods).toEqual(['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31']);
    expect(result.annual.values.revenue).toEqual([null, null, null, null]);
  });

  it('never combines monetary values reported in different currencies', () => {
    expect(() => normalizeYahooFundamentals(response({ annualTotalRevenue: [
      point('2025-12-31', 100, 'EUR'), point('2025-12-31', 100, 'USD'),
    ] }), 'X')).toThrow('Mixed reporting currencies');
  });

  it('uses the currency of the latest period and drops older entries in another one', () => {
    const result = normalizeYahooFundamentals(response({ annualTotalRevenue: [
      point('2022-12-31', 1, 'EUR'), point('2023-12-31', 2, 'EUR'), point('2024-12-31', 3, 'EUR'), point('2025-12-31', 4, 'USD'),
    ] }), 'X');
    expect(result.currency).toBe('USD');
    expect(result.annual.values.revenue).toEqual([null, null, null, 4]);
  });
});
