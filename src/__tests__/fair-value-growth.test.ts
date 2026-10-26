import { describe, expect, it } from 'vitest';
import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from '@/types/fundamentals';
import fixtures from './fixtures/fair-value-companies.json';
import {
  analystCheck, calculateFairValue, consensusEpsAt, cycleProfile, CYCLICAL_PE, defaultAssumptions, epsPath, forwardEps, forwardRevenueGrowth, growthDcf, growthMultiple,
  priceScenarios, recentRevenueGrowth, revenueBasisFactor, RERATING_SHARE, valuationInputs, reverseGrowthDcf, revenueGrowthPath, shareChange, shareDilution, usableEstimates,
  GROWTH_MODEL_MIN, LATE_GROWTH_CAP, type ConsensusEstimate, type GrowthDcfInput, type MarketContext,
} from '@/lib/fairValue';

// Ocenění v2: the growth model (revenue → margin → cash, consensus estimates, growth-based P/E) and price scenarios.
function series(periods: string[], values: Partial<Record<FundamentalMetric, (number | null)[]>>): FundamentalSeries {
  return { periods, values: values as FundamentalSeries['values'] };
}
/** A fast grower: revenue +40 % a year, FCF margin 20 %, net margin 15 %, shares +1 % a year. */
function grower(): CompanyFundamentals {
  return {
    symbol: 'GROW', currency: 'USD', status: 'ok', fetchedAt: '2026-08-15T00:00:00Z',
    annual: series(['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31'], {
      revenue: [500, 700, 980, 1372], freeCashFlow: [50, 98, 176, 274], netIncome: [40, 84, 137, 206], operatingCashFlow: [70, 120, 200, 300],
      capex: [-20, -22, -24, -26], dilutedEps: [0.4, 0.83, 1.34, 2.0], dilutedShares: [100, 101, 102, 103], equity: [800, 900, 1000, 1100],
      cash: [100, 120, 140, 160], totalDebt: [50, 50, 50, 50], grossProfit: [250, 350, 490, 686],
    }),
    quarterly: series(['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'], {
      revenue: [250, 270, 300, 330, 360, 382, 420, 462], freeCashFlow: [50, 54, 60, 66, 72, 76, 84, 92],
      netIncome: [37, 40, 45, 50, 54, 57, 63, 69], dilutedEps: [0.36, 0.39, 0.44, 0.49, 0.53, 0.55, 0.61, 0.67],
      dilutedShares: [102, 102, 103, 103, 103, 103, 104, 104], operatingCashFlow: [56, 60, 66, 72, 78, 82, 90, 98], capex: [-6, -6, -6, -6, -6, -6, -6, -6],
    }),
  };
}
const consensus: ConsensusEstimate[] = [
  { period: 'current', endDate: '2026-12-31', eps: 3.0, revenue: 1900, epsGrowth: 0.5, revenueGrowth: 0.38, analysts: 20 },
  { period: 'next', endDate: '2027-12-31', eps: 4.5, revenue: 2600, epsGrowth: 0.5, revenueGrowth: 0.37, analysts: 21 },
];
const market: MarketContext = { estimates: consensus, estimatesCurrency: 'USD', targetMean: 150, targetLow: 100, targetHigh: 220, targetCurrency: 'USD', asOf: '2026-08-15' };
const input: GrowthDcfInput = { revenuePerShare: 10, revenueGrowth: 0.3, discount: 0.1, terminalGrowth: 0.025, margin: 0.1, targetMargin: 0.2, dilution: 0.01 };

describe('growth path and growth-based multiple', () => {
  it('keeps the starting growth two years, caps year 3 and falls linearly to terminal growth in year 10', () => {
    const path = revenueGrowthPath(0.7, 0.025);
    expect(path).toHaveLength(10);
    expect(path.slice(0, 2)).toEqual([0.7, 0.7]);
    expect(path[2]).toBeCloseTo(LATE_GROWTH_CAP + (0.025 - LATE_GROWTH_CAP) / 8, 12);
    expect(path[9]).toBe(0.025);
    for (let i = 3; i < 10; i++) expect(path[i]).toBeLessThan(path[i - 1]);
    // A shrinking company converges up to terminal growth; a longer path stays at it.
    expect(revenueGrowthPath(-0.1, 0.025)[5]).toBeGreaterThan(-0.1);
    expect(revenueGrowthPath(0.2, 0.025, 15).slice(9)).toEqual(Array(6).fill(0.025));
  });
  it('pays a P/E for the growth ahead: 12 + 0.9 × growth in %, 12–45', () => {
    expect(growthMultiple(0.1)).toBeCloseTo(21, 12);
    expect(growthMultiple(0.2)).toBeCloseTo(30, 12);
    expect(growthMultiple(-0.2)).toBe(12);
    expect(growthMultiple(0.6)).toBe(45);
  });
});

describe('growth DCF (revenue → margin → cash per share)', () => {
  it('matches a hand-computed ten-year path with margin ramp, dilution and an averaged terminal value', () => {
    const path = revenueGrowthPath(0.3, 0.025);
    let sales = 10, present = 0, flow = 0;
    for (let year = 1; year <= 10; year++) {
      sales *= 1 + path[year - 1];
      flow = sales * (year >= 5 ? 0.2 : 0.1 + 0.1 * year / 5) / 1.01 ** year;
      present += flow / 1.1 ** year;
    }
    const terminal = flow * ((1.025 / 0.075) + growthMultiple(0.025)) / 2;
    expect(growthDcf(input).value).toBeCloseTo(present + terminal / 1.1 ** 10, 10);
  });
  it('rises with growth and target margin, falls with discount and dilution, adds net cash once', () => {
    const v = growthDcf(input).value!;
    expect(growthDcf({ ...input, revenueGrowth: 0.4 }).value!).toBeGreaterThan(v);
    expect(growthDcf({ ...input, targetMargin: 0.25 }).value!).toBeGreaterThan(v);
    expect(growthDcf({ ...input, discount: 0.11 }).value!).toBeLessThan(v);
    expect(growthDcf({ ...input, dilution: 0.03 }).value!).toBeLessThan(v);
    expect(growthDcf({ ...input, netCashPerShare: 5 }).value!).toBeCloseTo(v + 5, 10);
  });
  it.each([
    [{ revenuePerShare: null }, 'missingRevenue'], [{ revenuePerShare: 0 }, 'missingRevenue'], [{ margin: null }, 'missingFcf'],
    [{ discount: 0.02 }, 'invalidRates'], [{ revenueGrowth: NaN }, 'invalidRates'], [{ targetMargin: 0 }, 'nonPositiveFcf'],
    [{ netCashPerShare: NaN }, 'missingCashDebt'],
  ] as const)('explains invalid input %o', (patch, reason) => {
    expect(growthDcf({ ...input, ...patch } as GrowthDcfInput).reason).toBe(reason);
  });
  it.each([-0.2, 0, 0.15, 0.6, 1.2])('reverse DCF recovers the starting growth %s', growth => {
    const price = growthDcf({ ...input, revenueGrowth: growth }).value!;
    expect(reverseGrowthDcf(input, price).value).toBeCloseTo(growth, 6);
  });
  it('reverse DCF explains a missing price and an unreachable one', () => {
    expect(reverseGrowthDcf(input, null).reason).toBe('missingPrice');
    expect(reverseGrowthDcf(input, 1e9).reason).toBe('unreachable');
  });
});

describe('consensus inputs', () => {
  it('uses estimates only in the statements currency', () => {
    expect(usableEstimates(grower(), market)).toHaveLength(2);
    expect(usableEstimates(grower(), { ...market, estimatesCurrency: 'EUR' })).toEqual([]);
    expect(usableEstimates(grower(), { ...market, estimatesCurrency: null })).toEqual([]);
    expect(usableEstimates(grower(), null)).toEqual([]);
  });
  it('turns the next fiscal year consensus into a yearly rate from the latest TTM revenue', () => {
    const f = grower();
    const ttm = 360 + 382 + 420 + 462;
    const years = (Date.parse('2027-12-31') - Date.parse('2026-06-30')) / 86_400_000 / 365.25;
    expect(forwardRevenueGrowth(f, market)).toEqual({ rate: expect.closeTo((2600 / ttm) ** (1 / years) - 1, 12), source: 'consensus' });
    // Without estimates: the latest four quarters against the four before.
    expect(recentRevenueGrowth(f)).toBeCloseTo(ttm / (250 + 270 + 300 + 330) - 1, 12);
    expect(forwardRevenueGrowth(f, null)).toMatchObject({ source: 'recent' });
  });
  it('takes the next fiscal year EPS and how far its year end lies', () => {
    const e = forwardEps(grower(), market)!;
    expect(e).toMatchObject({ eps: 4.5, period: 'next' });
    expect(e.years).toBeCloseTo((Date.parse('2027-12-31') - Date.parse('2026-08-15')) / 86_400_000 / 365.25, 12);
    expect(forwardEps(grower(), { ...market, estimates: [{ ...consensus[1], eps: -1 }, consensus[0]] })).toMatchObject({ period: 'current', eps: 3 });
  });
  it('measures dilution from the share count, buybacks never adding value in the DCF', () => {
    const f = grower();
    expect(shareChange(f)).toBeCloseTo((103 / 100) ** (1 / ((Date.parse('2025-12-31') - Date.parse('2022-12-31')) / 86_400_000 / 365.25)) - 1, 12);
    f.annual.values.dilutedShares = [110, 108, 106, 100];
    expect(shareChange(f)).toBeLessThan(0);
    expect(shareDilution(f)).toBe(0);
  });
});

describe('fair value of a growth company', () => {
  it('values it with the growth model from the consensus: DCF 60 %, forward P/E 40 % of the model, the analysts\' target 20 %', () => {
    const r = calculateFairValue(grower(), 120, undefined, [], market);
    const d = defaultAssumptions(grower(), [], market);
    expect(d.growthModel).toBe(true);
    expect(d.rationale).toBe('consensus');
    expect(r).toMatchObject({ companyType: 'growth', model: 'revenue', growthSource: 'consensus' });
    expect(r.weights).toMatchObject({ dcf: expect.closeTo(0.48, 12), pe: expect.closeTo(0.32, 12), analysts: 0.2, peGrowth: 0, pfcf: 0 });
    expect(r.methods.analysts.value).toBeCloseTo(150 / (1 + d.assumptions.discount), 10);
    expect(r.modelValue).toBeCloseTo(r.methods.dcf.value! * 0.6 + r.methods.pe.value! * 0.4, 10);
    expect(r.value).toBeCloseTo(r.modelValue! * 0.8 + r.methods.analysts.value! * 0.2, 10);
    // Forward P/E: next year's EPS × the growth-based P/E, discounted for the months beyond a year.
    expect(r.methods.pe.value).toBeCloseTo(4.5 * d.assumptions.pe / (1 + d.assumptions.discount) ** (r.forward!.years - 1), 10);
    // Target margin: today's FCF margin or the consensus net margin, whichever is higher.
    expect(d.assumptions.targetMargin).toBeCloseTo(Math.max(324 / 1624, 4.5 * 104 / 2600), 12);
    expect(r.reverse.value).toBeGreaterThan(-0.5);
    expect(r.sensitivity.cells[1][1]).toEqual(r.methods.dcf);
    expect(r.sensitivity.growths[2] - r.sensitivity.growths[1]).toBeCloseTo(0.05, 12);
  });
  it('marks only the growth model assumptions as affecting the summary', () => {
    const r = calculateFairValue(grower(), 120, undefined, [], market);
    expect(r.affectsSummary).toMatchObject({ revenueGrowth: true, targetMargin: true, dilution: true, pe: true, growth: false, pfcf: false });
    const classic = calculateFairValue(grower(), 120, undefined, [], { ...market, estimates: consensus.map(e => ({ ...e, revenueGrowth: 0.05, revenue: 1700 })) });
    expect(classic.model).toBe('fcf');
    expect(classic.affectsSummary).toMatchObject({ revenueGrowth: false, targetMargin: false, dilution: false });
  });
  it(`keeps the classic methods below ${GROWTH_MODEL_MIN * 100} % growth`, () => {
    const f = grower();
    const slow = { ...market, estimates: consensus.map(e => ({ ...e, revenueGrowth: 0.08, revenue: e.period === 'current' ? 1750 : 1890 })) };
    expect(defaultAssumptions(f, [], slow).growthModel).toBe(false);
    expect(calculateFairValue(f, 120, undefined, [], slow).model).toBe('fcf');
  });
  it('lets the user change growth model assumptions and keeps old callers working', () => {
    const d = defaultAssumptions(grower(), [], market).assumptions;
    const base = calculateFairValue(grower(), 120, d, [], market);
    expect(calculateFairValue(grower(), 120, { ...d, revenueGrowth: d.revenueGrowth + 0.1 }, [], market).value!).toBeGreaterThan(base.value!);
    // An Assumptions object from before v2 (no growth model fields) falls back to the defaults.
    const { revenueGrowth: _r, targetMargin: _t, dilution: _d, ...old } = d;
    expect(calculateFairValue(grower(), 120, old as typeof d, [], market).value).toBeCloseTo(base.value!, 10);
  });
  it('does not fit the value to the quote; the analysts\' target moves only its own 20 %', () => {
    const a = calculateFairValue(grower(), 120, undefined, [], market);
    expect(calculateFairValue(grower(), 1200, undefined, [], market).value).toBe(a.value);
    const high = calculateFairValue(grower(), 120, undefined, [], { ...market, targetMean: 10_000 });
    expect(high.modelValue).toBe(a.modelValue);
    const discount = defaultAssumptions(grower(), [], market).assumptions.discount;
    expect(high.value! - a.value!).toBeCloseTo(0.2 * (10_000 - 150) / (1 + discount), 6);
    // Too few analysts: their target is not a method.
    expect(calculateFairValue(grower(), 120, undefined, [], { ...market, analystCount: 2 }).weights.analysts).toBe(0);
  });
});

describe('analyst check', () => {
  it.each([[150, 'inline'], [110, 'below'], [200, 'above'], [90, 'outside'], [230, 'outside']] as const)('%s against 100–220, mean 150 is %s', (value, status) => {
    expect(analystCheck(value, grower(), market)!.status).toBe(status);
  });
  it('needs a target in the statements currency', () => {
    expect(analystCheck(150, grower(), { ...market, targetCurrency: 'EUR' })).toBeNull();
    expect(analystCheck(null, grower(), market)).toBeNull();
  });
});

describe('price scenarios', () => {
  it('orders bear < base < bull and states every assumption', () => {
    const r = priceScenarios(grower(), 120, 3, market);
    expect(r.reason).toBeNull();
    const [bear, base, bull] = r.scenarios;
    expect([bear.kind, base.kind, bull.kind]).toEqual(['bear', 'base', 'bull']);
    expect(bear.price).toBeLessThan(base.price);
    expect(base.price).toBeLessThan(bull.price);
    for (const s of r.scenarios) {
      expect(s.basis).toBe('earnings');
      expect(s.price).toBeCloseTo(s.revenuePerShare * s.netMargin! * s.multiple, 10);
      expect(s.annual).toBeCloseTo((s.price / 120) ** (1 / 3) - 1, 12);
    }
    // Base margin: the consensus net margin; base P/E: the growth left after year 3.
    expect(base.netMargin).toBeCloseTo(4.5 * 104 / 2600, 12);
    const path = revenueGrowthPath(defaultAssumptions(grower(), [], market).assumptions.revenueGrowth, 0.025, 8);
    expect(base.multiple).toBeCloseTo(growthMultiple(path.slice(3, 8).reduce((a, b) => a + b, 0) / 5 - shareChange(grower())), 10);
  });
  it('grows with the horizon for a growing company', () => {
    const three = priceScenarios(grower(), 120, 3, market).scenarios[1].revenuePerShare;
    expect(priceScenarios(grower(), 120, 5, market).scenarios[1].revenuePerShare).toBeGreaterThan(three);
  });
  it('values a company without profit on sales from today\'s P/S, shrinking as growth slows', () => {
    const f = grower();
    f.quarterly.values.netIncome = [-10, -10, -10, -10, -10, -10, -10, -10];
    f.quarterly.values.dilutedEps = [-0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1];
    const losing = { ...market, estimates: consensus.map(e => ({ ...e, eps: -0.5 })) };
    const r = priceScenarios(f, 120, 3, losing);
    expect(r.scenarios.map(s => s.basis)).toEqual(['sales', 'sales', 'sales']);
    const ps = 120 / (1624 / 104);
    expect(r.scenarios[1].multiple).toBeLessThan(ps);
    expect(r.scenarios[1].eps).toBeNull();
    expect(priceScenarios(f, null, 3, losing).reason).toBe('missingPrice');
  });
  it('explains what it cannot do', () => {
    expect(priceScenarios(grower(), 120, 0, market).reason).toBe('invalidHorizon');
    expect(priceScenarios(grower(), 120, 11, market).reason).toBe('invalidHorizon');
    expect(priceScenarios({ ...grower(), currency: 'EUR' }, 120, 3, market).reason).toBe('currency');
    const jpm = (fixtures.companies as Record<string, { fundamentals: unknown; price: number }>).JPM;
    expect(priceScenarios(jpm.fundamentals as CompanyFundamentals, jpm.price, 3).reason).toBe('financialCashFlow');
  });
});

describe('Ocenění v3: every company type looks ahead', () => {
  const path = [{ years: 0.4, eps: 2, analysts: 10 }, { years: 1.4, eps: 3, analysts: 10 }, { years: 2.4, eps: 4, analysts: 3 }];
  it('reads consensus EPS between fiscal year ends, never beyond the last', () => {
    expect(consensusEpsAt(path, 0)).toBe(2);
    expect(consensusEpsAt(path, 1)).toBeCloseTo(2.6, 12);
    expect(consensusEpsAt(path, 2.4)).toBe(4);
    expect(consensusEpsAt(path, 2.5)).toBeNull();
    expect(consensusEpsAt([], 1)).toBeNull();
  });
  it('values a profitable classic company on next-twelve-months EPS at its own P/E, a year out', () => {
    const slow = { ...market, targetMean: null, estimates: [
      { period: 'current' as const, endDate: '2026-12-31', eps: 3.0, revenue: 1700, epsGrowth: 0.05, revenueGrowth: 0.05, analysts: 10 },
      { period: 'next' as const, endDate: '2027-12-31', eps: 3.3, revenue: 1790, epsGrowth: 0.1, revenueGrowth: 0.05, analysts: 10 }] };
    const r = calculateFairValue(grower(), 120, undefined, [], slow);
    expect(r.model).toBe('fcf');
    const d = defaultAssumptions(grower(), [], slow).assumptions;
    expect(r.ntmEps).toBeCloseTo(consensusEpsAt(epsPath(grower(), slow), 1)!, 12);
    expect(r.methods.pe.value).toBeCloseTo(r.ntmEps! * d.pe / (1 + d.discount), 10);
  });
  function losing(): CompanyFundamentals {
    const f = grower();
    f.quarterly.values.netIncome = f.quarterly.values.netIncome!.map(() => -10);
    f.quarterly.values.dilutedEps = f.quarterly.values.dilutedEps!.map(() => -0.1);
    f.quarterly.values.freeCashFlow = f.quarterly.values.freeCashFlow!.map(() => -5);
    return f;
  }
  const toProfit: MarketContext = { ...market, estimates: [
    { period: 'current', endDate: '2026-12-31', eps: -0.5, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 8 },
    { period: 'next', endDate: '2027-12-31', eps: 0.4, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 8 },
    { period: 'later', endDate: '2028-12-31', eps: 1.2, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 4 },
    { period: 'later', endDate: '2029-12-31', eps: 9, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 1 }] };
  it('values a company without profit by the furthest consensus year with profit that two analysts cover', () => {
    const r = calculateFairValue(losing(), 120, undefined, [], toProfit);
    const d = defaultAssumptions(losing(), [], toProfit).assumptions;
    expect(r.companyType).toBe('loss');
    const ahead = epsPath(losing(), toProfit).find(p => p.eps === 1.2)!;
    const growthBefore = (1.2 / 0.4) ** (1 / (ahead.years - epsPath(losing(), toProfit).find(p => p.eps === 0.4)!.years)) - 1;
    const multiple = growthMultiple((Math.min(0.5, growthBefore) + d.terminalGrowth) / 2 - shareChange(losing()));
    expect(r.methods.earningsPath.value).toBeCloseTo(1.2 * multiple / (1 + d.discount) ** ahead.years, 10);
    // The analysts' target takes 30 % for a company without profit; without P/S history the path takes the rest.
    expect(r.weights).toMatchObject({ earningsPath: 0.7, analysts: 0.3 });
    expect(r.relativeOnly).toBe(false);
  });
  it('values sales three years out at its own P/S, shrunk as growth slows', () => {
    const f = losing();
    const d = { ...defaultAssumptions(f, [], toProfit).assumptions, ps: 20 };
    const withHistory = calculateFairValue(f, 120, d, [], toProfit);
    // No P/S history in this fixture: the method says so instead of inventing a multiple.
    expect(withHistory.methods.ps.reason).toBe('missingHistory');
  });
  it('RKLB: revenue per share three years out × own P/S × compression, discounted three years', () => {
    const c = (fixtures.companies as Record<string, { fundamentals: unknown; price: number; closes: { date: string; close: number }[] }>).RKLB;
    const f = c.fundamentals as CompanyFundamentals;
    const r = calculateFairValue(f, c.price, undefined, c.closes);
    const d = defaultAssumptions(f, c.closes).assumptions;
    expect(d.ps).toBeGreaterThan(12); // own history, not the old cap
    const sales = revenueGrowthPath(d.revenueGrowth, d.terminalGrowth, 8);
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const perShare = r.inputs.shares ? (r.methods.ps.value! * (1 + d.discount) ** 3) : 0;
    const compression = Math.min(1.2, Math.max(0.15, (12 + 90 * Math.max(0, mean(sales.slice(3, 8)))) / (12 + 90 * Math.max(0, mean(sales.slice(0, 5))))));
    expect(perShare / (d.ps * compression)).toBeCloseTo(f.quarterly.values.revenue!.slice(-4).reduce((a, b) => a! + b!, 0)! / r.inputs.shares!
      * sales.slice(0, 3).reduce((v, g) => v * (1 + g), 1) / (1 + d.dilution) ** 3, 6);
  });
  it('anchors the base scenario on consensus EPS for the horizon and keeps the model spread', () => {
    const anchoredMarket: MarketContext = { ...market, estimates: [...consensus, { period: 'later', endDate: '2029-12-31', eps: 7, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 5 }] };
    const r = priceScenarios(grower(), 120, 3, anchoredMarket);
    const base = r.scenarios[1];
    expect(base.eps).toBeCloseTo(consensusEpsAt(epsPath(grower(), anchoredMarket), 3)!, 10);
    expect(r.scenarios[0].eps!).toBeLessThan(base.eps!);
    expect(r.scenarios[2].eps!).toBeGreaterThan(base.eps!);
    // Beyond the consensus the model alone sets the EPS.
    expect(priceScenarios(grower(), 120, 5, anchoredMarket).scenarios[1].eps).not.toBeCloseTo(7, 1);
  });
});

describe('Ocenění v3: a cyclical company is valued through its cycle', () => {
  /** Memory-chip-like: gross margin 10 → 80 %, losses to a 70 % net margin within three years. */
  function memory(): CompanyFundamentals {
    const periods = ['2023-12-31', '2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30',
      '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'];
    const revenue = [1.8, 1.7, 1.8, 1.9, 2.0, 2.1, 2.3, 3.0, 4.5, 6.0, 8.0, 9.0].map(x => x * 1e9);
    const gross = [0.10, 0.12, 0.18, 0.25, 0.30, 0.32, 0.35, 0.45, 0.60, 0.70, 0.78, 0.80];
    const net = [-0.30, -0.15, -0.02, 0.02, 0.05, 0.06, 0.08, 0.20, 0.40, 0.55, 0.65, 0.70];
    return {
      symbol: 'MEM', currency: 'USD', status: 'ok', fetchedAt: '2026-10-20T00:00:00Z',
      annual: series(['2023-12-31', '2024-12-31', '2025-12-31'], { revenue: [7e9, 7.4e9, 11.9e9], netIncome: [-1e9, 0.1e9, 2.6e9],
        dilutedShares: [150e6, 150e6, 152e6], dilutedEps: [-6.7, 0.7, 17.1] }),
      quarterly: series(periods, { revenue, grossProfit: revenue.map((r, i) => r * gross[i]), netIncome: revenue.map((r, i) => r * net[i]),
        freeCashFlow: revenue.map((r, i) => r * (net[i] - 0.05)), dilutedShares: periods.map(() => 152e6),
        dilutedEps: revenue.map((r, i) => r * net[i] / 152e6), cash: periods.map(() => 2e9), totalDebt: periods.map(() => 1e9), equity: periods.map(() => 10e9) }),
    };
  }
  const memMarket: MarketContext = { estimates: [
    { period: 'current', endDate: '2026-12-31', eps: 120, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 8 },
    { period: 'next', endDate: '2027-12-31', eps: 140, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 7 }],
    estimatesCurrency: 'USD', targetMean: 1500, targetLow: 1000, targetHigh: 2200, targetCurrency: 'USD', analystCount: 20, asOf: '2026-10-24' };
  it('recognises the cycle from swinging gross and net margins, not a company that simply became profitable', () => {
    expect(cycleProfile(memory())).toMatchObject({ cyclical: true });
    const profitable = memory();
    profitable.quarterly.values.grossProfit = profitable.quarterly.values.revenue!.map(r => r! * 0.8);
    expect(cycleProfile(profitable).cyclical).toBe(false);
  });
  it('values it at a cyclical P/E on next-twelve-months EPS and at the mid-cycle margin, never as a growth company', () => {
    const r = calculateFairValue(memory(), 1200, undefined, [], memMarket);
    const d = defaultAssumptions(memory(), [], memMarket);
    expect(r.companyType).toBe('cyclical');
    expect(d.assumptions.pe).toBe(CYCLICAL_PE);
    expect(d.assumptions.revenueGrowth).toBeCloseTo(140 / 120 - 1, 12);
    expect(d.assumptions.targetMargin).toBeCloseTo(cycleProfile(memory()).midFcfMargin!, 12);
    expect(r.methods.pe.value).toBeCloseTo(r.ntmEps! * CYCLICAL_PE / (1 + d.assumptions.discount), 10);
    expect(r.weights).toMatchObject({ dcf: expect.closeTo(0.24, 12), pe: expect.closeTo(0.56, 12), analysts: 0.2 });
  });
  it('scenarios: base at consensus EPS and a lower P/E, bear at the mid-cycle margin', () => {
    const r = priceScenarios(memory(), 1200, 2, memMarket);
    const [bear, base, bull] = r.scenarios;
    expect(base.multiple).toBeCloseTo(CYCLICAL_PE * 0.85, 12);
    expect(base.eps).toBeCloseTo(consensusEpsAt(epsPath(memory(), memMarket), Math.min(2, epsPath(memory(), memMarket).slice(-1)[0].years))!, 10);
    expect(bear.netMargin).toBeCloseTo(cycleProfile(memory()).midNetMargin!, 10);
    expect(bear.price).toBeLessThan(base.price);
    expect(bull.price).toBeGreaterThan(base.price);
  });
});

describe("consensus revenue on the statements' basis (NU: net revenue reported, gross revenue estimated)", () => {
  // The consensus counts revenue half as large again as the statements (a bank's gross vs net revenue), growth unchanged.
  const gross = consensus.map(e => ({ ...e, revenue: e.revenue! * 1.5 }));
  const grossMarket: MarketContext = { ...market, estimates: gross };
  it('scales the consensus to the reported year it implies, so a change of basis is not read as growth', () => {
    expect(revenueBasisFactor(grower(), gross)).toBeCloseTo(1372 / (1900 * 1.5 / 1.38), 9);
    expect(revenueBasisFactor(grower(), consensus)).toBe(1);
    expect(forwardRevenueGrowth(grower(), grossMarket)!.rate).toBeCloseTo(forwardRevenueGrowth(grower(), market)!.rate, 2);
  });
  it('keeps the default assumptions (growth, margin, multiple) of the same company on either basis', () => {
    const a = defaultAssumptions(grower(), [], grossMarket).assumptions, b = defaultAssumptions(grower(), [], market).assumptions;
    expect(a.revenueGrowth).toBeCloseTo(b.revenueGrowth, 2);
    expect(a.targetMargin).toBeCloseTo(b.targetMargin, 2);
    expect(a.pe).toBeCloseTo(b.pe, 1);
  });
});

describe("scenario multiples: no full re-rating above today's P/E", () => {
  it("closes half the gap between today's P/E and each case's multiple for its growth; a dearer stock keeps that multiple", () => {
    const cases = (price: number) => priceScenarios(grower(), price, 3, market).scenarios;
    // At 400 USD today's P/E is far above any growth multiple: each case keeps its own (bear × 0.8, bull × 1.15).
    const full = cases(400);
    // At 20 USD today's P/E (on the trailing 2.36 EPS) is below them: each case pays halfway between the two.
    const todayPe = 20 / valuationInputs(grower()).eps.value!;
    const factor = { bear: 0.8, base: 1, bull: 1.15 } as const;
    for (const c of cases(20)) {
      const justified = full.find(x => x.kind === c.kind)!.multiple / factor[c.kind];
      expect(todayPe).toBeLessThan(justified);
      expect(c.multiple).toBeCloseTo((todayPe + (justified - todayPe) * RERATING_SHARE) * factor[c.kind], 9);
    }
  });
});
