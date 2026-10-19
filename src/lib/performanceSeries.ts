// The "Vývoj portfolia" series: the whole portfolio per day (positions + recorded cash), the
// money put in up to that day, and the same money held in the S&P 500 instead.
//
// In the local currency (koruny or the chosen one) every day is valued at ITS OWN USD→local
// rate (the snapshot's fx_rate; value_czk is the positions at that rate) and every flow at the
// rate of the day it went in. Multiplying the whole USD history by today's rate — as the chart
// did — just relabels the USD curve: the percentages came out identical to USD and a koruna
// investor never saw the currency move.
import type { DisplayCurrency } from '@/lib/displayCurrency';

export interface SeriesSnapshot {
  snapshot_date: string;
  /** Positions only. */
  value_usd: number;
  /** Positions only, at that day's rate. */
  value_czk: number;
  fx_rate?: number | null;
  /** Recorded cash; null/absent on days before cash tracking began. */
  cash_usd?: number | null;
}

export interface SeriesPoint {
  date: string;
  total: number;
  cumDep: number;
  benchVal: number | null;
}

export function buildPerformanceSeries({ snapshots, tradeFlowsUsd, incomeUsd, benchAt, currency, fallbackFx, fxAt }: {
  /** Sorted by date, the live point (if any) already appended. */
  snapshots: SeriesSnapshot[];
  /** Money moved into the positions per day, USD (computeTradeFlows). */
  tradeFlowsUsd: Map<string, number>;
  /** Dividends credited to cash per pay day, USD net. A rise in cash from them is a RETURN,
   *  not money put in — without this the return lost the whole dividend yield. */
  incomeUsd?: Map<string, number>;
  /** S&P 500 close on/before a date. */
  benchAt: (date: string) => number | null;
  /** Any non-USD currency is the local branch (the snapshots' value_czk / fx_rate). */
  currency: DisplayCurrency;
  /** Rate for a day that carries none and has no positions to derive it from. */
  fallbackFx: number;
  /** Known USD→local rate for a trade day; otherwise use the current snapshot's rate. */
  fxAt?: (date: string) => number | null | undefined;
}): SeriesPoint[] {
  const czk = currency !== 'USD';
  let lastFx = fallbackFx;
  let cum = 0, units = 0, prevCash = 0;
  const flows = [...tradeFlowsUsd].sort(([a], [b]) => a.localeCompare(b));
  let flowIndex = 0;
  const income = [...(incomeUsd ?? new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b));
  let incomeIndex = 0;
  // The first snapshot is the starting boundary; keep its own day's flow as before.
  while (flowIndex < flows.length && flows[flowIndex][0] < snapshots[0]?.snapshot_date) flowIndex++;
  while (incomeIndex < income.length && income[incomeIndex][0] <= (snapshots[0]?.snapshot_date ?? '')) incomeIndex++;
  return snapshots.map((s) => {
    // The day's own rate; a day without one keeps the last known (value_czk/value_usd is the
    // same rate whenever there are positions to read it from).
    const fx = s.fx_rate ? Number(s.fx_rate) : s.value_usd > 0 && s.value_czk > 0 ? s.value_czk / s.value_usd : lastFx;
    lastFx = fx;
    const k = czk ? fx : 1;
    // Where cash is part of the curve a purchase is an INTERNAL move (cash → positions); what
    // counts as money in is the change in cash plus what was spent on stock.
    // Before cash tracking began a day has no balance (0). After it, a day the nightly job
    // missed keeps the last recorded balance — reading it as 0 drew a one-day crash plus a
    // phantom withdrawal and re-deposit.
    const recorded = s.cash_usd != null && Number.isFinite(Number(s.cash_usd)) ? Number(s.cash_usd) : null;
    const cash = recorded ?? prevCash;
    let flowUsd = cash - prevCash;
    // Income only reached the curve where cash is recorded; before that it is not in the value.
    while (incomeIndex < income.length && income[incomeIndex][0] <= s.snapshot_date) {
      const [, amount] = income[incomeIndex++];
      if (recorded != null) flowUsd -= amount;
    }
    let flowValue = flowUsd * k;
    // Consume each trade once, including dates without a snapshot: (previous, current].
    while (flowIndex < flows.length && flows[flowIndex][0] <= s.snapshot_date) {
      const [date, amount] = flows[flowIndex++];
      const tradeFx = czk ? fxAt?.(date) : null;
      flowUsd += amount;
      flowValue += amount * (czk && tradeFx != null && Number.isFinite(tradeFx) && tradeFx > 0 ? tradeFx : k);
    }
    prevCash = cash;
    const spx = benchAt(s.snapshot_date);
    cum += flowValue;
    if (flowUsd !== 0) {
      if (spx) units += flowUsd / spx;
    }
    return {
      date: s.snapshot_date,
      total: (czk ? s.value_czk : s.value_usd) + cash * k,
      cumDep: cum,
      // Sells can push the matched position negative (more taken out than put in). A
      // negative "what the index would be worth" is meaningless — draw nothing instead.
      benchVal: spx && units > 0 ? units * spx * k : null,
    };
  });
}
