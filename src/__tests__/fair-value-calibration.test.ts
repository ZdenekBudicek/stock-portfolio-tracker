import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/fair-value-companies.json';
import type { CompanyFundamentals } from '@/types/fundamentals';
import { calculateFairValue, defaultAssumptions, historicalMultiples, valuationInputs, METHOD_IDS } from '@/lib/fairValue';
import { medianOf, valuationSeries } from '@/lib/valuationSeries';

const companies = Object.entries(fixtures.companies).map(([symbol, c]) => ({ ...c, symbol, fundamentals: c.fundamentals as CompanyFundamentals }));
const stable = new Set(['MSFT', 'AAPL', 'GOOGL', 'META', 'JPM', 'KO', 'PG', 'JNJ', 'PEP']);
const company = (symbol: string) => companies.find(c => c.symbol === symbol)!;
const report = (symbol: string) => {
  const c = company(symbol);
  return calculateFairValue(c.fundamentals, c.price, undefined, c.closes);
};

describe('25-company default calibration (no quote-based value clamping)', () => {
  it.each(companies)('$symbol has bounded defaults, applicable weights and explicit unavailable reasons', c => {
    const r = calculateFairValue(c.fundamentals, c.price, undefined, c.closes);
    if (stable.has(c.symbol)) {
      expect(r.value).not.toBeNull();
      expect(r.value! / c.price).toBeGreaterThanOrEqual(0.5);
      expect(r.value! / c.price).toBeLessThanOrEqual(1.7);
    }
    if (r.value == null) {
      expect(r.reason).toBeTruthy();
      expect(r.usableCount).toBe(0);
    } else {
      expect(r.value).toBeGreaterThan(0);
      expect(r.value / c.price).toBeLessThanOrEqual(5);
      expect(r.potential).toBeGreaterThanOrEqual(-1);
      expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(r.value).toBeCloseTo(METHOD_IDS.reduce((sum, m) => sum + (r.methods[m].value ?? 0) * r.weights[m], 0), 10);
    }
    for (const m of METHOD_IDS) {
      if (r.methods[m].value == null) {
        expect(r.methods[m].reason).toBeTruthy();
        expect(r.weights[m]).toBe(0);
      }
    }
    if (r.companyType === 'loss') {
      expect(r.relativeOnly).toBe(true);
      expect(r.included).toEqual(['ps']);
      for (const m of ['dcf', 'pfcf', 'pe', 'peGrowth', 'graham'] as const) {
        expect(r.methods[m].value).toBeNull();
        expect(r.methods[m].reason).toBeTruthy();
      }
    }
  });

  it.each(['SOFI', 'NU', 'JPM', 'MELI'])('%s excludes credit-sensitive cash flows, including reverse and sensitivity', symbol => {
    const r = report(symbol);
    expect(r.companyType).toBe('financial');
    expect(r.included).toEqual(['pe', 'pb']);
    expect(r.methods.dcf.reason).toBe('financialCashFlow');
    expect(r.methods.pfcf.reason).toBe('financialCashFlow');
    expect(r.reverse.reason).toBe('financialCashFlow');
    expect(r.sensitivity.cells.flat().every(c => c.reason === 'financialCashFlow')).toBe(true);
  });

  it('does not let token dividends or Graham anchor GOOGL and AAPL', () => {
    for (const symbol of ['GOOGL', 'AAPL']) {
      const r = report(symbol);
      expect(r.weights.dividend).toBe(0);
      expect(r.methods.dividend.reason).toBe('minorDividend');
      expect(r.weights.graham).toBe(0);
      expect(r.methods.graham.value).toBeGreaterThan(0);
    }
    expect(report('GOOGL').value).toBeCloseTo(370.5004800044, 6);
    expect(report('GOOGL').potential).toBeCloseTo(0.0878196072, 7);
  });

  it.each(['GOOGL', 'MSFT', 'META', 'AMZN'])('%s normalizes observable capex surges, with a manual latest override', symbol => {
    const c = company(symbol);
    const d = defaultAssumptions(c.fundamentals, c.closes);
    expect(d.assumptions.fcfMode).toBe('normalized');
    const r = report(symbol);
    expect(r.inputs.fcf.source).toBe('normalized');
    const raw = calculateFairValue(c.fundamentals, c.price, { ...d.assumptions, fcfMode: 'latest' }, c.closes);
    expect(r.inputs.fcf.value).toBeGreaterThan(raw.inputs.fcf.value!);
    expect(r.methods.dcf.value).toBeGreaterThan(raw.methods.dcf.value!);
  });

  it('does not normalize ordinary investment or rehabilitate loss-making FCF', () => {
    expect(defaultAssumptions(company('AAPL').fundamentals).assumptions.fcfMode).toBe('latest');
    const c = company('INTC');
    expect(valuationInputs(c.fundamentals).fcf.value).toBeGreaterThan(0);
    expect(report('INTC').methods.dcf.reason).toBe('lossMaking');
    expect(report('O').value).toBeNull();
    expect(report('O').reason).toBe('missingAffo');
  });

  it('uses five-year own medians with clipping; stale, future and short histories cannot anchor defaults', () => {
    const c = company('GOOGL');
    const points = valuationSeries(c.fundamentals, c.closes).filter(p => p.date >= '2021-10-18' && p.date <= '2026-10-18');
    const d = defaultAssumptions(c.fundamentals, c.closes);
    expect(d.assumptions.pe).toBeCloseTo(medianOf(points, 'pe')!, 10);
    expect(d.assumptions.pfcf).toBeCloseTo(medianOf(points, 'pfcf')!, 10);
    expect(d.assumptions.ps).toBeCloseTo(medianOf(points, 'ps')!, 10);
    const noisy = [...c.closes, { date: '2021-10-17', close: 1e9 }, { date: '2027-01-01', close: 1e9 }, { date: '2026-10-18', close: NaN }];
    expect(historicalMultiples(c.fundamentals, noisy)).toEqual(d.history);
    expect(defaultAssumptions(c.fundamentals, c.closes.slice(-20)).history.pe.median).toBeNull();
    expect(defaultAssumptions(c.fundamentals, Array(100).fill(c.closes[c.closes.length - 1])).history.pe.median).toBeNull();
    expect(defaultAssumptions(company('NVDA').fundamentals, company('NVDA').closes).assumptions.pe).toBe(45);
    expect(defaultAssumptions(company('PLTR').fundamentals, company('PLTR').closes).assumptions.pfcf).toBe(50);
  });

  it('never substitutes an arbitrary P/S for missing loss-company history', () => {
    const c = company('RKLB');
    const r = calculateFairValue(c.fundamentals, c.price);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('missingHistory');
    expect(r.methods.ps.reason).toBe('missingHistory');
  });

  it('renormalizes only applicable methods after invalid user assumptions', () => {
    const c = company('GOOGL');
    const a = defaultAssumptions(c.fundamentals, c.closes).assumptions;
    const r = calculateFairValue(c.fundamentals, c.price, { ...a, discount: 0.01 }, c.closes);
    expect(r.weights.dcf).toBe(0);
    expect(r.weights.pe).toBeCloseTo(4 / 7);
    expect(r.weights.pfcf).toBeCloseTo(2 / 7);
    expect(r.weights.graham).toBe(0);
  });

  it('does not fit valuations to the current quote or fixture symbol', () => {
    const c = company('GOOGL');
    const renamed = { ...c.fundamentals, symbol: 'UNSEEN' };
    expect(calculateFairValue(renamed, c.price, undefined, c.closes)).toEqual(report('GOOGL'));
    expect(calculateFairValue(renamed, c.price * 10, undefined, c.closes).value).toBe(report('GOOGL').value);
  });
});
