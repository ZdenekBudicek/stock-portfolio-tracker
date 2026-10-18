import { dailyReturns, type FlowPoint } from './returns';

export type ReturnQualityLevel = "ok" | "estimated" | "insufficient";

export interface ReturnQuality {
  level: ReturnQualityLevel;
  /** Codes translated by the UI. */
  reasons: string[];
  /** Days with |r| >= 25%; diagnostics only, never removed from the returns. */
  extremeDays: { date: string; r: number; flow: number }[];
  /** First date with recorded cash, or null when never tracked. */
  cashTrackedFrom: string | null;
}

export function assessReturnQuality(points: FlowPoint[], opts: { cashTrackedFrom: string | null }): ReturnQuality {
  const reasons = ['proxy-flows'];
  const extremeDays = dailyReturns(points).filter(({ r }) => Math.abs(r) >= 0.25);
  if (opts.cashTrackedFrom == null || points.some((p) => p.date < opts.cashTrackedFrom!)) {
    reasons.push('cash-untracked-period');
  }
  if (extremeDays.length) reasons.push('extreme-days');
  // Weekend samples are optional. Measure calendar gaps between weekday observations.
  const weekdays = points.map((p) => new Date(`${p.date}T00:00:00Z`))
    .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6);
  if (weekdays.some((d, i) => i > 0 && d.getTime() - weekdays[i - 1].getTime() > 7 * 86_400_000)) {
    reasons.push('gaps');
  }
  if (points.length < 20) reasons.push('short-history');
  return {
    level: points.length < 20 ? 'insufficient' : reasons.length > 1 ? 'estimated' : 'ok',
    reasons,
    extremeDays,
    cashTrackedFrom: opts.cashTrackedFrom,
  };
}
