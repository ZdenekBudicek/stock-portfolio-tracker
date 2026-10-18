import { describe, expect, it } from 'vitest';
import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from '@/types/fundamentals';
import { annualFlow, calculateFairValue, dcf, defaultAssumptions, dividendValue, earningsValue, grahamValue,
  marginOfSafety, fairValuePotential, median, reverseDcf, valuationInputs, type DcfInput } from '@/lib/fairValue';

// Partial records deliberately represent old cached rows without the new fields.
function series(periods: string[], values: Partial<Record<FundamentalMetric, (number | null)[]>>): FundamentalSeries {
  return { periods, values: values as FundamentalSeries['values'] };
}
function company(): CompanyFundamentals {
  return {
    symbol: 'TEST', currency: 'USD', status: 'ok', fetchedAt: '2026-10-18T00:00:00Z',
    annual: series(['2023-12-31', '2024-12-31', '2025-12-31'], {
      revenue: [1000, 1100, 1210], freeCashFlow: [80, 100, 120], dilutedEps: [1, 2, 3],
      dilutedShares: [10, 10, 10], sharesOutstanding: [11, 11, 11], equity: [200, 250, 300],
      cash: [20, 30, 40], totalDebt: [10, 10, 15], dividendsPaid: [-10, -15, -20],
    }),
    quarterly: series(['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'], {
      freeCashFlow: [30, 40, 50, 60], dilutedEps: [0.5, 1, 1.5, 2], dilutedShares: [10, 10, 12, 12],
      sharesOutstanding: [11, 11, 13, 13], equity: [290, 300, 350, 360],
      cash: [30, 40, 50, 60], totalDebt: [10, 15, 20, 24], dividendsPaid: [-5, -5, -6, -8],
    }),
  };
}
const base: DcfInput = { fcfPerShare: 10, growth: 0.1, discount: 0.1, terminalGrowth: 0.025 };

describe('valuation data selection', () => {
  it('uses TTM flows and latest diluted share count, equity and net cash', () => {
    expect(valuationInputs(company())).toMatchObject({
      shares: 12, fcf: { value: 180, source: 'ttm' }, eps: { value: 5, source: 'ttm' },
      dividends: { value: -24, source: 'ttm' }, equity: 360, fcfPerShare: 15, netCashPerShare: 3,
    });
  });
  it('sums the latest four quarters only, including negative and zero quarters', () => {
    const f = company();
    f.quarterly = series(['2025-06-30', ...f.quarterly.periods], { freeCashFlow: [999, -10, 0, 20, 30] });
    expect(annualFlow(f, 'freeCashFlow')).toEqual({ value: 40, source: 'ttm' });
  });
  it.each([null, NaN, Infinity])('falls back to annual for an incomplete/nonfinite TTM (%s)', bad => {
    const f = company();
    f.quarterly.values.freeCashFlow[2] = bad;
    expect(annualFlow(f, 'freeCashFlow')).toEqual({ value: 120, source: 'annual' });
  });
  it('does not combine skipped quarters or duplicate periods', () => {
    for (const date of ['2024-09-30', '2025-12-31']) {
      const f = company();
      f.quarterly.periods[0] = date;
      expect(annualFlow(f, 'freeCashFlow').source).toBe('annual');
    }
  });
  it('uses annual with fewer than four quarters or when the annual report is newer', () => {
    const f = company();
    f.quarterly.periods.pop();
    expect(annualFlow(f, 'freeCashFlow').value).toBe(120);
    f.quarterly = company().quarterly;
    f.annual.periods[2] = '2026-12-31';
    expect(annualFlow(f, 'freeCashFlow').source).toBe('annual');
  });
  it('treats absent arrays as missing, falls back to outstanding shares', () => {
    const f = company();
    delete f.annual.values.dilutedShares;
    delete f.quarterly.values.dilutedShares;
    delete f.annual.values.dividendsPaid;
    delete f.quarterly.values.dividendsPaid;
    expect(valuationInputs(f).shares).toBe(13);
    expect(calculateFairValue(f, 100).methods.dividend.reason).toBe('missingDividends');
  });
  it('uses the latest annual share count when it is newer than quarterly data', () => {
    const f = company();
    f.annual.periods[2] = '2026-12-31';
    expect(valuationInputs(f).shares).toBe(10);
  });
  it('falls back from an invalid diluted count and rejects missing positive share counts', () => {
    const f = company();
    f.quarterly.values.dilutedShares[3] = 0;
    expect(valuationInputs(f).shares).toBe(13);
    f.quarterly.values.sharesOutstanding[3] = -1;
    expect(calculateFairValue(f, 100).methods.dcf.reason).toBe('missingShares');
    expect(calculateFairValue(f, 100).methods.pe.value).toBe(110);
  });
  it('uses a true three-year average without quarterly double counting', () => {
    const inputs = valuationInputs(company(), 'average3');
    expect(inputs.fcf.source).toBe('average3');
    expect(inputs.fcf.value).toBeCloseTo(100);
    expect(inputs.fcfPerShare).toBeCloseTo(100 / 12);
  });
  it('requires three complete consecutive annual values for averaging', () => {
    const f = company();
    f.annual.values.freeCashFlow[1] = null;
    const assumptions = { ...defaultAssumptions(f).assumptions, fcfMode: 'average3' as const };
    expect(calculateFairValue(f, 100, assumptions).methods.dcf.reason).toBe('missingAverage');
    f.annual.values.freeCashFlow[1] = 100;
    f.annual.periods[0] = '2021-12-31';
    expect(valuationInputs(f, 'average3').fcf.value).toBeNull();
    f.annual.periods = f.annual.periods.slice(-2);
    expect(valuationInputs(f, 'average3').fcf.value).toBeNull();
  });
  it('does not mix cash and debt from different periods or assume absent debt is zero', () => {
    const f = company();
    f.quarterly.values.totalDebt = [null, null, null, null];
    f.annual.values.cash = [null, null, null];
    expect(valuationInputs(f).netCashPerShare).toBeNull();
    const defaults = defaultAssumptions(f).assumptions;
    expect(calculateFairValue(f, 100, defaults).methods.dcf.value).not.toBeNull();
    expect(calculateFairValue(f, 100, { ...defaults, includeNetCash: true }).methods.dcf.reason).toBe('missingCashDebt');
  });
});

describe('two-stage DCF', () => {
  it('matches a perpetuity for constant growth across both stages', () => {
    expect(dcf({ ...base, growth: 0.025 }).value).toBeCloseTo(10 * 1.025 / 0.075, 8);
    expect(dcf({ ...base, growth: 0, terminalGrowth: 0 }).value).toBeCloseTo(100, 8);
  });
  it('uses five constant-growth years and five linearly fading years', () => {
    // Independently tabulated flows: 11, 12.1, 13.31, 14.641, 16.1051,
    // 17.4740335, 18.697215845, 19.725562716475, 20.514585225134, 21.027449855762352.
    expect(dcf(base).value).toBeCloseTo(206.26312384172286, 8);
  });
  it('adds positive or negative net cash once without discounting it', () => {
    expect(dcf({ ...base, netCashPerShare: 3 }).value! - dcf(base).value!).toBeCloseTo(3);
    expect(dcf({ ...base, netCashPerShare: -4 }).value! - dcf(base).value!).toBeCloseTo(-4);
    expect(dcf({ ...base, netCashPerShare: -1000 }).value).toBeLessThan(0);
  });
  it.each([0, -5])('rejects nonpositive starting FCF (%s)', fcfPerShare => {
    expect(dcf({ ...base, fcfPerShare }).reason).toBe('nonPositiveFcf');
  });
  it.each([null, NaN, Infinity])('rejects missing/nonfinite FCF (%s)', fcfPerShare => {
    expect(dcf({ ...base, fcfPerShare }).reason).toBe('missingFcf');
  });
  it.each([
    { discount: 0.025 }, { discount: 0.01 }, { discount: 0 }, { discount: NaN },
    { terminalGrowth: -1 }, { growth: -1 }, { growth: Infinity },
  ])('rejects invalid assumptions %j', patch => {
    expect(dcf({ ...base, ...patch }).reason).toBe('invalidRates');
  });
  it('allows negative growth and flags numerical overflow instead of returning Infinity', () => {
    expect(dcf({ ...base, growth: -0.1 }).value).toBeGreaterThan(0);
    expect(dcf({ ...base, fcfPerShare: Number.MAX_VALUE }).reason).toBe('nonFinite');
  });
});

describe('earnings, book value and dividends', () => {
  it('computes both earnings multiples with and without discounted growth', () => {
    expect(earningsValue(4, 15).value).toBe(60);
    expect(earningsValue(4, 20, 0.08, 5, 0.1).value).toBeCloseTo(80 * (1.08 / 1.1) ** 5);
    expect(earningsValue(4, 20, 0.1, 5, 0.1).value).toBe(80);
  });
  it('rejects invalid EPS, P/E, growth, discount and horizon', () => {
    expect(earningsValue(null, 15).reason).toBe('missingEps');
    expect(earningsValue(-1, 15).reason).toBe('nonPositiveEps');
    expect(earningsValue(0, 15).reason).toBe('nonPositiveEps');
    for (const pe of [0, -1, NaN, Infinity]) expect(earningsValue(4, pe).reason).toBe('invalidPe');
    for (const years of [-1, 1.5, 51, Infinity]) expect(earningsValue(4, 15, 0, years).reason).toBe('invalidHorizon');
    expect(earningsValue(4, 15, -1).reason).toBe('invalidRates');
    expect(earningsValue(4, 15, 0, 5, -0.1).reason).toBe('invalidRates');
  });
  it('computes Graham only for positive EPS and equity', () => {
    expect(grahamValue(4, 1000, 100).value).toBe(30);
    expect(grahamValue(null, 1000, 100).reason).toBe('missingEps');
    expect(grahamValue(-1, 1000, 100).reason).toBe('nonPositiveEps');
    expect(grahamValue(4, null, 100).reason).toBe('missingEquity');
    expect(grahamValue(4, 0, 100).reason).toBe('nonPositiveEquity');
    expect(grahamValue(4, -100, 100).reason).toBe('nonPositiveEquity');
    expect(grahamValue(4, 1000, 0).reason).toBe('missingShares');
  });
  it('converts negative reported payouts into next-year positive dividends per share', () => {
    expect(dividendValue(-200, 100, 0.025, 0.1).value).toBeCloseTo(2.05 / 0.075);
    expect(dividendValue(-200, 100, -0.1, 0.1).value).toBeCloseTo(9);
  });
  it('distinguishes unknown dividends from nonpayers and invalid rates', () => {
    expect(dividendValue(null, 100, 0.025, 0.1).reason).toBe('missingDividends');
    for (const paid of [0, 20]) expect(dividendValue(paid, 100, 0.025, 0.1).reason).toBe('noDividends');
    expect(dividendValue(-200, null, 0.025, 0.1).reason).toBe('missingShares');
    expect(dividendValue(-200, 100, 0.1, 0.1).reason).toBe('invalidRates');
    expect(dividendValue(-200, 100, -1, 0.1).reason).toBe('invalidRates');
  });
});

describe('reverse DCF', () => {
  it.each([-0.9, -0.2, 0, 0.1, 0.5, 3])('recovers a known growth rate %s by bisection', growth => {
    const price = dcf({ ...base, growth, netCashPerShare: 3 }).value;
    expect(reverseDcf({ ...base, netCashPerShare: 3 }, price).value).toBeCloseTo(growth, 7);
  });
  it('explains missing prices, unusable FCF and unreachable targets', () => {
    for (const price of [null, 0, -1, NaN, Infinity]) expect(reverseDcf(base, price).reason).toBe('missingPrice');
    expect(reverseDcf({ ...base, fcfPerShare: -1 }, 100).reason).toBe('nonPositiveFcf');
    expect(reverseDcf(base, 1e12).reason).toBe('unreachable');
    expect(reverseDcf({ ...base, netCashPerShare: 100 }, 1).reason).toBe('unreachable');
    expect(reverseDcf({ ...base, discount: 0.025 }, 100).reason).toBe('invalidRates');
  });
});

describe('defaults and complete report', () => {
  it('derives capped historical revenue CAGR using elapsed years', () => {
    const f = company();
    const defaults = defaultAssumptions(f);
    expect(defaults.rationale).toBe('revenue');
    expect(defaults.assumptions.growth).toBeCloseTo(0.075, 3);
    expect(defaults.assumptions).toMatchObject({ discount: 0.09, terminalGrowth: 0.025, pe: 22, includeNetCash: false });
    f.annual.values.revenue = [1, 10, 100];
    expect(defaultAssumptions(f).assumptions.growth).toBe(0.20);
    f.annual.values.revenue = [100, 50, 1];
    expect(defaultAssumptions(f).assumptions.growth).toBe(-0.05);
  });
  it('falls back from revenue to FCF CAGR and then an explained default', () => {
    const f = company();
    delete f.annual.values.revenue;
    expect(defaultAssumptions(f).rationale).toBe('fcf');
    f.annual.values.freeCashFlow = [-10, 0, 20];
    expect(defaultAssumptions(f)).toMatchObject({ rationale: 'fallback', historicalGrowth: null, assumptions: { growth: 0.05 } });
  });
  it('keeps median as a data utility and shows safety only below fair value', () => {
    expect(median([10, 20, 100])).toBe(20);
    expect(median([10, 20, 30, 100])).toBe(25);
    expect(median([NaN, Infinity])).toBeNull();
    expect(marginOfSafety(100, 80)).toBeCloseTo(0.2);
    expect(marginOfSafety(100, 120)).toBeNull();
    expect(marginOfSafety(100, 100)).toBeNull();
    expect(fairValuePotential(100, 120)).toBeCloseTo(-1 / 6);
    expect(fairValuePotential(1, 1000)).toBeCloseTo(-0.999);
    expect(fairValuePotential(0, 100)).toBe(-1);
    expect(fairValuePotential(-1, 100)).toBeNull();
    expect(fairValuePotential(1, 0)).toBeNull();
    expect(marginOfSafety(0, 10)).toBeNull();
    expect(marginOfSafety(10, null)).toBeNull();
    expect(marginOfSafety(-10, 20)).toBeNull();
  });
  it('weights applicable methods and excludes Graham, small dividends and reverse DCF', () => {
    const f = company();
    f.quarterly.values.dividendsPaid = [-0.1, -0.1, -0.1, -0.1];
    const report = calculateFairValue(f, 80);
    expect(report.usableCount).toBe(4);
    expect(report.weights).toMatchObject({ dcf: 0.3, pe: 0.4, peGrowth: 0.1, pfcf: 0.2, graham: 0, dividend: 0 });
    expect(report.value).toBeCloseTo(report.methods.dcf.value! * 0.3 + report.methods.pe.value! * 0.4
      + report.methods.peGrowth.value! * 0.1 + report.methods.pfcf.value! * 0.2, 8);
    expect(report.marginOfSafety).toBeCloseTo(1 - 80 / report.value!);
  });
  it('uses Graham only for demonstrated stable value profiles', () => {
    const f = company();
    f.annual.values.revenue = [1000, 1010, 1020];
    f.annual.values.dilutedEps = [3, 3, 3];
    const r = calculateFairValue(f, 1000);
    expect(r.companyType).toBe('value');
    expect(r.weights.graham).toBe(0.15);
    f.annual.values.equity = [-100, -100, -100];
    f.quarterly.values.equity = [-100, -100, -100, -100];
    expect(calculateFairValue(f, 1000).weights.graham).toBe(0);
  });
  it('produces a 3×3 sensitivity matrix with the selected value at its centre', () => {
    const report = calculateFairValue(company(), 80);
    const { cells } = report.sensitivity;
    expect(cells.map(row => row.length)).toEqual([3, 3, 3]);
    expect(cells[1][1]).toEqual(report.methods.dcf);
    expect(cells[0][1].value).toBeGreaterThan(cells[2][1].value!);
    expect(cells[1][2].value).toBeGreaterThan(cells[1][0].value!);
    const defaults = defaultAssumptions(company()).assumptions;
    const invalid = calculateFairValue(company(), 80, { ...defaults, discount: 0.03 });
    expect(invalid.sensitivity.cells[0][0].reason).toBe('invalidRates');
  });
  it.each(['EUR', 'CZK', ''])('blocks every method and sensitivity for reporting currency %s', currency => {
    const report = calculateFairValue({ ...company(), currency }, 100);
    expect(Object.values(report.methods).every(m => m.reason === 'currency')).toBe(true);
    expect(report.reverse.reason).toBe('currency');
    expect(report.sensitivity.cells.flat().every(m => m.reason === 'currency')).toBe(true);
    expect(report.value).toBeNull();
    expect(report.marginOfSafety).toBeNull();
    expect(report.usableCount).toBe(0);
  });
  it('still values companies without a quote, but omits price-dependent comparisons', () => {
    const report = calculateFairValue(company(), null);
    expect(report.usableCount).toBe(4);
    expect(report.marginOfSafety).toBeNull();
    expect(report.reverse.reason).toBe('missingPrice');
  });
  it('handles loss-making companies and empty legacy rows without fabricated results', () => {
    const f = company();
    f.quarterly.values.freeCashFlow = [-1, -2, -3, -4];
    f.quarterly.values.dilutedEps = [-1, -1, -1, -1];
    f.quarterly.values.dividendsPaid = [0, 0, 0, 0];
    const report = calculateFairValue(f, 10);
    expect(report.methods.dcf.reason).toBe('lossMaking');
    expect(report.methods.pe.reason).toBe('nonPositiveEps');
    expect(report.methods.graham.reason).toBe('nonPositiveEps');
    expect(report.value).toBeNull();
    f.annual = series([], {});
    f.quarterly = series([], {});
    expect(calculateFairValue(f, 10).usableCount).toBe(0);
  });
  it('does not mutate input data, assumptions or arrays', () => {
    const f = company();
    const assumptions = defaultAssumptions(f).assumptions;
    const before = JSON.stringify({ f, assumptions });
    calculateFairValue(f, 80, assumptions);
    valuationInputs(f, 'average3');
    expect(JSON.stringify({ f, assumptions })).toBe(before);
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('share count for per-share values', () => {
  it('uses the newest count, not an older diluted one from before a split', () => {
    const f = {
      symbol: 'X', currency: 'USD', fetchedAt: '2026-01-01T00:00:00Z', status: 'ok',
      annual: { periods: ['2024-12-31'], values: { dilutedShares: [100], freeCashFlow: [100] } },
      quarterly: { periods: ['2025-06-30'], values: { sharesOutstanding: [1000] } },
    } as unknown as CompanyFundamentals;
    expect(valuationInputs(f).shares).toBe(1000);
  });
});
