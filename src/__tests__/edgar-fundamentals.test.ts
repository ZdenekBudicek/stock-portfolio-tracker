import { describe, expect, it } from 'vitest';
import {
  mergeFundamentals, mergeSeries, normalizeEdgarFacts, parseYahooSplits, secCikMap, secTicker, storedHistory,
} from '../../scripts/edgar-fundamentals.mjs';
import { YAHOO_FUNDAMENTAL_METRICS } from '../../supabase/functions/_shared/fundamentals.js';

const METRICS = Object.values(YAHOO_FUNDAMENTAL_METRICS) as string[];
type Fact = { start?: string; end: string; val: number; filed?: string };
const f = (start: string | null, end: string, val: number, filed = '2025-01-01'): Fact => ({ ...(start ? { start } : {}), end, val, filed });
const facts = (concepts: Record<string, Record<string, Fact[]>>) => {
  const out: { facts: Record<string, Record<string, { units: Record<string, Fact[]> }>> } = { facts: {} };
  for (const [concept, units] of Object.entries(concepts)) {
    const [tax, name] = concept.split(':');
    (out.facts[tax] ??= {})[name] = { units };
  }
  return out;
};
const series = (periods: string[], values: Partial<Record<string, (number | null)[]>>) => ({
  periods, values: Object.fromEntries(METRICS.map((m) => [m, values[m] ?? periods.map(() => null)])),
});
const company = (annual: ReturnType<typeof series>, quarterly = series([], {}), currency = 'USD') => ({ symbol: 'X', currency, fetchedAt: 'now', status: 'ok' as const, annual, quarterly });

// Fiscal year 2024 (Oct–Sep) as a 10-K/10-Q filer reports it: income 3M + YTD, cash flow YTD only.
const FY = { start: '2023-10-01', q1: '2023-12-30', q2: '2024-03-30', q3: '2024-06-29', end: '2024-09-28' };
const filer = facts({
  'us-gaap:Revenues': { USD: [
    f(FY.start, FY.q1, 100), f(FY.start, FY.q2, 210), f('2023-12-31', FY.q2, 110), f(FY.start, FY.q3, 330),
    f('2024-03-31', FY.q3, 120), f(FY.start, FY.end, 460), f('2022-10-02', '2023-09-30', 400),
  ], EUR: [f(FY.start, FY.end, 999)] },
  'us-gaap:NetCashProvidedByUsedInOperatingActivities': { USD: [f(FY.start, FY.q1, 30), f(FY.start, FY.q2, 50), f(FY.start, FY.q3, 90), f(FY.start, FY.end, 140)] },
  'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment': { USD: [f(FY.start, FY.end, 40), f(FY.start, FY.q3, 25)] },
  'us-gaap:EarningsPerShareDiluted': { 'USD/shares': [f(FY.start, FY.q1, 4, '2024-02-01'), f(FY.start, FY.end, 16, '2024-11-01'), f(FY.start, FY.end, 4, '2025-11-01')] },
  'us-gaap:StockholdersEquity': { USD: [f(null, FY.end, 700), f(null, FY.q3, 650), f(null, '2024-05-15', 1)] },
});

describe('SEC mapping helpers', () => {
  it('maps plain tickers to 10-digit CIKs and skips exchange-suffixed symbols', () => {
    const map = secCikMap({ 0: { cik_str: 320193, ticker: 'AAPL' }, 1: { cik_str: 1067983, ticker: 'BRK-B' }, 2: { cik_str: 'x', ticker: 'BAD' } });
    expect([...map]).toEqual([['AAPL', '0000320193'], ['BRK-B', '0001067983']]);
    expect([secTicker('brk-b'), secTicker('SAP.DE'), secTicker('BATS.L'), secTicker('^GSPC')]).toEqual(['BRK-B', null, null, null]);
  });

  it('reads Yahoo split events as ratios and rejects an error answer', () => {
    expect(parseYahooSplits({ chart: { result: [{ events: { splits: { a: { date: 1598832000, numerator: 4, denominator: 1 } } } }] } }))
      .toEqual([{ date: '2020-08-31', ratio: 4 }]);
    expect(parseYahooSplits({ chart: { result: [{}] } })).toEqual([]);
    expect(parseYahooSplits({ chart: { result: null, error: { code: 'Not Found' } } })).toBeNull();
  });
});

describe('normalizeEdgarFacts', () => {
  const out = normalizeEdgarFacts(filer, 'USD', [{ date: '2025-06-01', ratio: 4 }]);

  it('takes direct quarters and derives the rest from year-to-date figures, Q4 = year − 9 months', () => {
    expect([...out.quarterly.keys()].sort()).toEqual([FY.q1, FY.q2, FY.q3, FY.end]);
    expect([FY.q1, FY.q2, FY.q3, FY.end].map((d) => out.quarterly.get(d)!.revenue)).toEqual([100, 110, 120, 130]);
    // cash flow is reported YTD only: 30, 50−30, 90−50, 140−90
    expect([FY.q1, FY.q2, FY.q3, FY.end].map((d) => out.quarterly.get(d)!.operatingCashFlow)).toEqual([30, 20, 40, 50]);
    expect(out.annual.get(FY.end)).toMatchObject({ revenue: 460, operatingCashFlow: 140, capex: -40, equity: 700 });
    expect(out.annual.get('2023-09-30')!.revenue).toBe(400);
  });

  it('never derives non-additive figures, reads only the requested currency and keeps outflows negative', () => {
    expect(out.quarterly.get(FY.end)!.dilutedEps).toBeUndefined(); // Q4 EPS is not FY − 9M
    expect(out.quarterly.get(FY.end)!.capex).toBe(-15);
    expect(out.annual.get(FY.end)!.revenue).toBe(460); // EUR 999 ignored
    expect(out.quarterly.get(FY.q3)!.equity).toBe(650);
    expect([...out.quarterly.keys()]).not.toContain('2024-05-15'); // a lone balance date is no period
  });

  it('restates EPS to today\'s share basis using only splits after the filing', () => {
    // latest filing (2025-11, after the split) wins over the original 16 and is already adjusted
    expect(out.annual.get(FY.end)!.dilutedEps).toBe(4);
    expect(out.quarterly.get(FY.q1)!.dilutedEps).toBe(1); // filed 2024-02, before the 4:1 split
    const noSplits = normalizeEdgarFacts(filer, 'USD', null);
    expect(noSplits.annual.get(FY.end)!.dilutedEps).toBeUndefined();
    expect(noSplits.annual.get(FY.end)!.revenue).toBe(460);
  });

  it('drops share counts a filing tagged in thousands', () => {
    const years = ['2015', '2016', '2017', '2018', '2019'];
    const shares = facts({ 'us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding': { shares: years.map((y, i) => f(`${Number(y) - 1}-01-01`, `${Number(y) - 1}-12-31`, i === 0 ? 600_000 : 600_000_000 + i)) } });
    const rows = normalizeEdgarFacts(shares, 'USD', []).annual;
    expect(rows.get('2014-12-31')!.dilutedShares).toBeUndefined();
    expect(rows.get('2015-12-31')!.dilutedShares).toBe(600_000_001);
  });
});

describe('mergeSeries', () => {
  const yahoo = series(['2023-09-30', '2024-09-30'], { revenue: [400, 460], netIncome: [40, 50], cash: [10, 12], equity: [null, 700] });
  const history = new Map<string, Record<string, number>>([
    ['2021-09-25', { revenue: 300, netIncome: 30, cash: 99, buybacks: -5, operatingCashFlow: 20, capex: -4 }],
    ['2022-09-24', { revenue: 350, netIncome: 35, buybacks: -6 }],
    ['2023-09-30', { revenue: 401, netIncome: 80, buybacks: -7 }],
    ['2024-09-28', { revenue: 459, netIncome: 90, equity: 690, buybacks: -8 }],
  ]);
  const { series: merged, used } = mergeSeries(yahoo, history);

  it('keeps Yahoo for its periods, aligns SEC dates to them and adds the older periods', () => {
    expect(merged.periods).toEqual(['2021-09-30', '2022-09-30', '2023-09-30', '2024-09-30']);
    expect(merged.values.revenue).toEqual([300, 350, 400, 460]);
    expect(merged.values.equity).toEqual([null, null, null, 700]);
  });

  it('takes a metric only where its definition matches Yahoo', () => {
    expect(used).toEqual(expect.arrayContaining(['revenue', 'equity', 'buybacks', 'operatingCashFlow', 'capex']));
    expect(used).not.toContain('netIncome'); // 80 vs 40, 90 vs 50: different definition
    expect(used).not.toContain('cash'); // Yahoo reports it, never in a period history has: unchecked
    expect(merged.values.netIncome).toEqual([null, null, 40, 50]);
    expect(merged.values.cash).toEqual([null, null, 10, 12]);
    expect(merged.values.buybacks).toEqual([-5, -6, -7, -8]); // Yahoo lacks it: history fills its periods too
    expect(merged.values.freeCashFlow).toEqual([16, null, null, null]);
  });

  it('tolerates one disagreement in three (a one-off charge Yahoo excludes)', () => {
    const y = series(['2022-12-31', '2023-12-31', '2024-12-31'], { operatingIncome: [10, 20, 30] });
    const h = new Map([['2021-12-31', { operatingIncome: 5 }], ['2022-12-31', { operatingIncome: 10 }], ['2023-12-31', { operatingIncome: 14 }], ['2024-12-31', { operatingIncome: 30.5 }]]);
    expect(mergeSeries(y, h).series.values.operatingIncome).toEqual([5, 10, 20, 30]);
    const worse = new Map([...h, ['2024-12-31', { operatingIncome: 40 }]]);
    expect(mergeSeries(y, worse).series.values.operatingIncome).toEqual([10, 20, 30]);
  });
});

describe('mergeFundamentals / storedHistory', () => {
  it('returns Yahoo untouched without history and reuses stored data only in the same currency', () => {
    const y = company(series(['2024-12-31'], { revenue: [10] }));
    expect(mergeFundamentals(y, null).data).toBe(y);
    const stored = company(series(['2020-12-31', '2024-12-31'], { revenue: [5, 9.9] }));
    expect(storedHistory(stored, 'EUR')).toBeNull();
    const { data } = mergeFundamentals(y, storedHistory(stored, 'USD'));
    expect(data.annual).toMatchObject({ periods: ['2020-12-31', '2024-12-31'], values: { revenue: [5, 10] } });
    expect(data.quarterly.periods).toEqual([]);
  });
});
