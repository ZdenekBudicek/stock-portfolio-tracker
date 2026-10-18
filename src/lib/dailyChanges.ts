// Day-over-day change of the positions value for the "Denní záznamy" log, net of trades.
// The snapshots hold the positions only, so a purchase raises the value by what was paid and
// a sale lowers it by what was received — neither is a gain or a loss. The money moved into
// the positions that day (computeTradeFlows) is taken out of the change; in CZK at that day's
// rate, the same rate value_czk is computed at.

export interface DailySnapshotLike {
  snapshot_date: string;
  value_usd: number;
  value_czk: number;
  fx_rate?: number | null;
}

export interface DailyChange {
  dayUsd: number;
  dayCzk: number;
  dayPct: number;
}

export function computeDailyChanges<T extends DailySnapshotLike>(snapshots: T[], tradeFlowsUsd: Map<string, number>): (T & DailyChange)[] {
  const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  return sorted.map((s, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    if (!prev) return { ...s, dayUsd: 0, dayCzk: 0, dayPct: 0 };
    const flowUsd = tradeFlowsUsd.get(s.snapshot_date) ?? 0;
    const fx = s.fx_rate ? Number(s.fx_rate) : s.value_usd > 0 ? s.value_czk / s.value_usd : 0;
    const dayUsd = s.value_usd - prev.value_usd - flowUsd;
    const dayCzk = s.value_czk - prev.value_czk - flowUsd * fx;
    // Money bought in that day was at work for the day too.
    const base = prev.value_usd + Math.max(0, flowUsd);
    return { ...s, dayUsd, dayCzk, dayPct: base > 0 ? (dayUsd / base) * 100 : 0 };
  });
}

/**
 * Compounded monthly growth over the given snapshots, money put in excluded: the trade-clean
 * daily returns chained over the REAL calendar span. Measured on the raw value it counted every
 * purchase as growth, so the "Cíle portfolia" ETA came out far too optimistic.
 */
export function monthlyGrowthNetOfFlows(snapshots: DailySnapshotLike[], tradeFlowsUsd: Map<string, number>): number {
  const rows = computeDailyChanges(snapshots, tradeFlowsUsd);
  if (rows.length < 2) return 0;
  let factor = 1;
  for (const r of rows.slice(1)) factor *= 1 + r.dayPct / 100;
  const days = (new Date(rows[rows.length - 1].snapshot_date).getTime() - new Date(rows[0].snapshot_date).getTime()) / 86400000;
  if (!(days > 0) || !(factor > 0)) return 0;
  return factor ** (30 / days) - 1;
}
