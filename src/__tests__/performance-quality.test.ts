import { describe, expect, it } from 'vitest';
import { assessReturnQuality } from '@/lib/performanceQuality';
import { dailyReturns } from '@/lib/returns';

const history = (n = 20) => Array.from({ length: n }, (_, i) => ({
  date: new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10), total: 1000, cumDep: 1000,
}));
const tracked = { cashTrackedFrom: '2026-08-03' };

describe('assessReturnQuality', () => {
  it('always reports proxy flows, even for otherwise good history', () => {
    expect(assessReturnQuality(history(), tracked)).toEqual({ level: 'ok', reasons: ['proxy-flows'], extremeDays: [], ...tracked });
  });

  it('gives insufficient history precedence below 20 points', () => {
    for (const points of [[], history(19)]) {
      const q = assessReturnQuality(points, { cashTrackedFrom: null });
      expect(q.level).toBe('insufficient');
      expect(q.reasons).toEqual(['proxy-flows', 'cash-untracked-period', 'short-history']);
    }
  });

  it('flags absent or late cash tracking, but accepts tracking before the series', () => {
    for (const cashTrackedFrom of [null, '2026-08-04']) {
      const q = assessReturnQuality(history(), { cashTrackedFrom });
      expect(q.level).toBe('estimated');
      expect(q.reasons).toContain('cash-untracked-period');
      expect(q.cashTrackedFrom).toBe(cashTrackedFrom);
    }
    expect(assessReturnQuality(history(), { cashTrackedFrom: '2026-08-01' }).level).toBe('ok');
  });

  it('includes positive and negative 25% extremes and their flows without removing returns', () => {
    const points = history();
    points[1] = { ...points[1], total: 1350, cumDep: 1100 };
    points[2] = { ...points[2], total: 912.5, cumDep: 1000 };
    const before = dailyReturns(points);
    const q = assessReturnQuality(points, tracked);
    expect(q.level).toBe('estimated');
    expect(q.reasons).toContain('extreme-days');
    expect(q.extremeDays).toEqual([
      { date: points[1].date, r: 0.25, flow: 100 },
      { date: points[2].date, r: -0.25, flow: -100 },
    ]);
    expect(dailyReturns(points)).toEqual(before);
  });

  it('detects gaps longer than 7 calendar days between weekdays, without flagging weekends', () => {
    const points = history(40).filter((p) => ![0, 6].includes(new Date(p.date).getUTCDay()));
    expect(assessReturnQuality(points, tracked).level).toBe('ok');
    const gap = points.filter((p) => p.date <= '2026-08-07' || p.date >= '2026-08-17');
    expect(assessReturnQuality(gap, tracked).reasons).toContain('gaps');
    const exactly7 = points.filter((p) => p.date <= '2026-08-07' || p.date >= '2026-08-14');
    expect(assessReturnQuality(exactly7, tracked).reasons).not.toContain('gaps');
  });
});
