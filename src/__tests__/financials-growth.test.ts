import { describe, expect, it } from 'vitest';
import { growthStats, rangeFor, rangeStartIndex, usableRanges } from '@/lib/financialsGrowth';

const annual = ['2021-09-25', '2022-09-24', '2023-09-30', '2024-09-28', '2025-09-27'];
const quarterly = ['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30'];

describe('rangeStartIndex', () => {
  it('counts years back from the newest period, tolerating 52/53-week fiscal years', () => {
    expect(rangeStartIndex(annual, '2Y')).toBe(3);
    expect(rangeStartIndex(annual, '3Y')).toBe(2);
    expect(rangeStartIndex(annual, 'ALL')).toBe(0);
    expect(rangeStartIndex(quarterly, '1Y')).toBe(1); // four quarters
  });

  it('offers only presets that narrow the chart to two or more periods', () => {
    expect([...usableRanges(annual)].sort()).toEqual(['2Y', '3Y', 'ALL']);
    expect(usableRanges(quarterly).has('1Y')).toBe(true);
    expect(usableRanges(['2025-12-31']).size).toBe(1);
  });

  it('recognises a selection that matches a preset', () => {
    expect(rangeFor(annual, 0, 4)).toBe('ALL');
    expect(rangeFor(annual, 3, 4)).toBe('2Y');
    expect(rangeFor(annual, 1, 4)).toBeNull();
    expect(rangeFor(annual, 2, 3)).toBeNull();
  });
});

describe('growthStats', () => {
  it('computes total growth and CAGR against the period N years earlier', () => {
    const g = growthStats(annual, [100, 110, 121, 133.1, 146.41]);
    expect(g.map((x) => x.years)).toEqual([1, 2, 3]);
    expect(g[0].growth).toBeCloseTo(0.1);
    expect(g[2].cagr).toBeCloseTo(0.1);
    expect(g[2].growth).toBeCloseTo(0.331);
    expect(g[2].from).toBe('2022-09-24');
  });

  it('starts from the newest reported value and skips gaps', () => {
    const g = growthStats(annual, [100, null, 121, 150, null]);
    expect(g[0]).toMatchObject({ years: 1, from: '2023-09-30', to: '2024-09-28' });
    expect(g.find((x) => x.years === 2)).toBeUndefined(); // 2022 is missing
    expect(g.find((x) => x.years === 3)?.from).toBe('2021-09-25');
  });

  it('gives no percentage across zero or from a loss, but keeps the difference', () => {
    const [g] = growthStats(annual, [null, null, null, -50, 80]);
    expect(g.growth).toBeNull();
    expect(g.cagr).toBeNull();
    expect(g.diff).toBe(130);
  });

  it('compares a quarter with the same quarter a year earlier', () => {
    const [g] = growthStats(quarterly, [10, 12, 9, 11, 15]);
    expect(g).toMatchObject({ years: 1, from: '2024-09-30' });
    expect(g.growth).toBeCloseTo(0.5);
  });

  it('returns nothing without data', () => {
    expect(growthStats([], [])).toEqual([]);
    expect(growthStats(annual, [null, null, null, null, null])).toEqual([]);
  });
});
