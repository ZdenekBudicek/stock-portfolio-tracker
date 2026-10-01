import { useMemo } from "react";
import { CalendarRange, Trophy, TrendingDown } from "lucide-react";
import { useDailySnapshots, useTransactions, useComputedPortfolio, computeTradeFlows } from "@/hooks/usePortfolio";
import { useCurrency } from "@/contexts/CurrencyContext";

const MonthComparison = () => {
  const { data: snaps = [] } = useDailySnapshots();
  const { data: txs = [] } = useTransactions();
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();

  const monthly = useMemo(() => {
    if (snaps.length < 2) return [] as Array<{ key: string; pct: number; usd: number; }>;
    // A month starts where the previous one ended — anchoring `first` to the month's OWN
    // first snapshot threw away the move between the last day of one month and the first of
    // the next, so every month was measured over a slightly short window.
    const byMonth = new Map<string, { first: number; last: number; }>();
    let prevEnd: number | null = null;
    for (const s of snaps) {
      const key = s.snapshot_date.slice(0, 7);
      const cur = byMonth.get(key);
      if (!cur) { byMonth.set(key, { first: prevEnd ?? s.value_usd, last: s.value_usd }); }
      else cur.last = s.value_usd;
      prevEnd = s.value_usd;
    }
    // Money put into the positions per month, so a month with new buys doesn't read as
    // "return" and a month with a sale doesn't read as a loss. Same basis as the chart and
    // Roční zhodnocení — the snapshots being compared are holdings-only, so the baseline
    // has to be holdings-only too.
    const flowByMonth = new Map<string, number>();
    for (const [date, usd] of computeTradeFlows(txs as any)) {
      const m = date.slice(0, 7);
      flowByMonth.set(m, (flowByMonth.get(m) ?? 0) + usd);
    }
    return Array.from(byMonth.entries()).map(([key, { first, last }]) => {
      const flow = flowByMonth.get(key) ?? 0;
      const gain = (last - first) - flow;          // value change net of money paid in
      const base = first + flow;                    // capital working during the month
      return { key, pct: base > 0 ? (gain / base) * 100 : 0, usd: gain };
    }).slice(-6);
  }, [snaps, txs]);

  const bestWorst = useMemo(() => {
    // For each ticker compute best realized + best unrealized %
    const byTicker = new Map<string, { profit: number; pct: number }>();
    for (const p of positions) {
      if (p.ticker === "CASH") continue;
      byTicker.set(p.ticker, { profit: p.profitUsd, pct: p.profitPct });
    }
    const sorted = Array.from(byTicker.entries()).sort((a, b) => b[1].profit - a[1].profit);
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
  }, [positions]);

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <h2 className="font-display text-lg font-bold flex items-center gap-2 mb-4">
        <CalendarRange className="w-5 h-5 text-primary" /> Měsíční srovnání & rekordy
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-2">Posledních 6 měsíců</h3>
          <div className="space-y-1.5">
            {monthly.length === 0 && <p className="text-xs text-muted-foreground">Málo dat.</p>}
            {monthly.map((m) => (
              <div key={m.key} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 px-3 py-2">
                <span className="text-xs font-mono">{m.key}</span>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-mono tabular-nums ${m.usd >= 0 ? "text-profit" : "text-loss"}`}>{format(m.usd)}</span>
                  <span className={`text-sm font-display font-bold tabular-nums w-20 text-right ${m.pct >= 0 ? "text-profit" : "text-loss"}`}>
                    {m.pct >= 0 ? "+" : ""}{m.pct.toFixed(2)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          {bestWorst.best && (
            <div className="rounded-xl border border-profit/30 bg-profit/5 p-4">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1">
                <Trophy className="w-3 h-3 text-profit" /> Nejlepší pozice
              </p>
              <p className="font-display text-xl font-bold mt-1">{bestWorst.best[0]}</p>
              <p className="text-sm text-profit font-bold tabular-nums">
                {format(bestWorst.best[1].profit)} ({bestWorst.best[1].pct.toFixed(1)}%)
              </p>
            </div>
          )}
          {bestWorst.worst && bestWorst.best && bestWorst.worst[0] !== bestWorst.best[0] && (
            <div className="rounded-xl border border-loss/30 bg-loss/5 p-4">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1">
                <TrendingDown className="w-3 h-3 text-loss" /> Nejhorší pozice
              </p>
              <p className="font-display text-xl font-bold mt-1">{bestWorst.worst[0]}</p>
              <p className="text-sm text-loss font-bold tabular-nums">
                {format(bestWorst.worst[1].profit)} ({bestWorst.worst[1].pct.toFixed(1)}%)
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MonthComparison;
