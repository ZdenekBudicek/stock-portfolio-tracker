// Year-by-year growth for the "Roční zhodnocení" card — measured on the WHOLE portfolio,
// the same thing the page header shows: positions plus the cash balance.
//
// The stored snapshot's value_czk is the positions only, at that day's close. Measuring the
// card on it alone left the running year's "Hodnota" short of the header by the whole cash
// balance (plus the move since the last close), so the card now uses the same series as the
// performance chart: value = positions + recorded cash, and today = the live value.

export interface GrowthSnapshot {
  snapshot_date: string;
  /** Positions only, converted at that day's FX. */
  value_czk: number;
  fx_rate?: number | null;
  /** Recorded cash balance; null on days before cash tracking began. */
  cash_usd?: number | null;
}

/** Today's value exactly as the header computes it. */
export interface LiveTotal {
  date: string;
  holdingsUsd: number;
  cashUsd: number;
  usdCzk: number;
}

export interface MonthPoint {
  label: string;
  month: number;
  actualGrowthPct: number;
  goalGrowthPct: number;
  totalValueCzk: number;
}

export interface YearData {
  year: number;
  startValueCzk: number;   // portfolio value at the start of the year (prev year end)
  depositsCzk: number;     // net money put in during the year
  endValueCzk: number;
  growthCzk: number;       // value gain excluding money put in
  growthPct: number;
  isCurrent: boolean;
  monthly: MonthPoint[];
}

const monthNames = ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čer', 'Čec', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro'];

interface Day { date: string; holdingsCzk: number; fx: number | null; cashUsd: number | null; }

export function computeYearlyGrowth({ snapshots, tradeFlowsUsd, live, goalPct, nowYear, fallbackFx }: {
  snapshots: GrowthSnapshot[];
  /** Money moved into the positions per day, in USD (computeTradeFlows). */
  tradeFlowsUsd: Map<string, number>;
  live: LiveTotal | null;
  goalPct: number;
  nowYear: number;
  /** FX for dates before the first snapshot that carries one. */
  fallbackFx: number;
}): YearData[] {
  const days: Day[] = snapshots
    .map((s) => ({
      date: s.snapshot_date,
      holdingsCzk: Number(s.value_czk),
      fx: s.fx_rate ? Number(s.fx_rate) : null,
      cashUsd: s.cash_usd != null && Number.isFinite(Number(s.cash_usd)) ? Number(s.cash_usd) : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Today = the header's own figure. Replaces a snapshot already stored for today (last close)
  // rather than sitting beside it.
  if (live && live.holdingsUsd + live.cashUsd > 0) {
    const point: Day = { date: live.date, holdingsCzk: live.holdingsUsd * live.usdCzk, fx: live.usdCzk, cashUsd: live.cashUsd };
    const last = days[days.length - 1];
    if (!last || last.date < live.date) days.push(point);
    else if (last.date === live.date) days[days.length - 1] = point;
  }
  if (!days.length) return [];

  // Each flow is converted at the FX OF ITS OWN DAY, matching how value_czk was computed.
  const fxDays = days.filter((d) => d.fx != null);
  const fxAt = (date: string) => {
    let lo = 0, hi = fxDays.length - 1, best = fallbackFx;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fxDays[mid].date <= date) { best = fxDays[mid].fx!; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };
  const totalCzk = (d: Day) => d.holdingsCzk + (d.cashUsd ?? 0) * (d.fx ?? fxAt(d.date));

  // Money put in, per month, on the same basis as the value. A purchase moves money from
  // cash into positions, so what counts is the trade flow PLUS the change in cash — a sale
  // that stays in cash is then neither a loss nor a withdrawal. Before cash was recorded the
  // balance is 0 and this is the trade flow alone; the first recorded balance is money in,
  // exactly matching the step it adds to the value.
  const flowByMonthCzk = new Map<string, number>();
  const addFlow = (date: string, czk: number) => {
    const key = date.slice(0, 7);
    flowByMonthCzk.set(key, (flowByMonthCzk.get(key) ?? 0) + czk);
  };
  for (const [date, usd] of tradeFlowsUsd) addFlow(date, usd * fxAt(date));
  let prevCash = 0;
  for (const d of days) {
    const cash = d.cashUsd ?? 0;
    if (cash !== prevCash) addFlow(d.date, (cash - prevCash) * (d.fx ?? fxAt(d.date)));
    prevCash = cash;
  }

  const byYear = new Map<number, Day[]>();
  for (const d of days) {
    const y = Number(d.date.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(d);
  }

  let prevEnd = 0;
  const out: YearData[] = [];
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    const ys = byYear.get(y)!;
    const startValueCzk = prevEnd || totalCzk(ys[0]); // first year: anchor to its first day
    const endValueCzk = totalCzk(ys[ys.length - 1]);
    let depositsCzk = 0;
    for (const [month, czk] of flowByMonthCzk) if (Number(month.slice(0, 4)) === y) depositsCzk += czk;
    const base = startValueCzk + Math.max(0, depositsCzk);
    const growthCzk = endValueCzk - startValueCzk - depositsCzk;
    const growthPct = base > 0 ? (growthCzk / base) * 100 : 0;

    const byMonth = new Map<number, Day>(); // last day of each month (days are sorted)
    for (const d of ys) byMonth.set(Number(d.date.slice(5, 7)), d);
    const monthly: MonthPoint[] = [{ label: '1.', month: 0, actualGrowthPct: 0, goalGrowthPct: 0, totalValueCzk: startValueCzk }];
    let depSoFar = 0; // REAL cumulative money-in through this month, not the year's total × m/12
    for (const m of [...byMonth.keys()].sort((a, b) => a - b)) {
      const value = totalCzk(byMonth.get(m)!);
      depSoFar += flowByMonthCzk.get(`${y}-${String(m).padStart(2, '0')}`) ?? 0;
      const mBase = startValueCzk + Math.max(0, depSoFar);
      const gPct = mBase > 0 ? ((value - startValueCzk - depSoFar) / mBase) * 100 : 0;
      monthly.push({ label: monthNames[m - 1], month: m, actualGrowthPct: Math.round(gPct * 100) / 100, goalGrowthPct: Math.round((goalPct / 12) * m * 100) / 100, totalValueCzk: value });
    }
    out.push({ year: y, startValueCzk, depositsCzk, endValueCzk, growthCzk, growthPct: Math.round(growthPct * 100) / 100, isCurrent: y === nowYear, monthly });
    prevEnd = endValueCzk;
  }
  return out.reverse(); // newest first
}
