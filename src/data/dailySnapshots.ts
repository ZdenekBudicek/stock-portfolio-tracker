// Pure helpers around DB-backed snapshots. No mock data.
import type { DbSnapshot } from '@/hooks/usePortfolio';

export const getMonthlySnapshots = (year: number, snapshots: DbSnapshot[]) => {
  const ym = snapshots.filter(s => s.snapshot_date.startsWith(`${year}-`));
  // Pick the last snapshot of each month
  const byMonth = new Map<string, DbSnapshot>();
  for (const s of ym) {
    const key = s.snapshot_date.slice(0, 7);
    const cur = byMonth.get(key);
    if (!cur || s.snapshot_date > cur.snapshot_date) byMonth.set(key, s);
  }
  return Array.from(byMonth.values()).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
};
