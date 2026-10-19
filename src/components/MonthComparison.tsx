import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useMemo } from "react";
import { CalendarRange, Trophy, TrendingDown } from "lucide-react";
import { useDailySnapshots, useTransactions, useComputedPortfolio, computeTradeFlows } from "@/hooks/usePortfolio";
import { useCurrency } from "@/contexts/CurrencyContext";

const MonthComparison = () => {
  const { t } = useTranslation();
  const { data: snaps = [] } = useDailySnapshots();
  const { data: txs = [] } = useTransactions();
  const { positions } = useComputedPortfolio();
  const { formatAt, pick, currency, rate } = useCurrency();

  const monthly = useMemo(() => {
    if (snaps.length < 2) return [] as Array<{ key: string; pct: number; amount: number; }>;
    // In the local currency (koruny or the chosen one) the month is measured on the local
    // values of its own days (value_czk, at each day's rate) and the money put in at the rate of
    // the day it went in — not on the USD series times today's rate, which gave the USD % with
    // a koruna label.
    const czk = currency !== 'USD';
    const sorted = [...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const fxDays = sorted.filter((s) => s.fx_rate);
    const fxAt = (date: string) => {
      let best = fxDays[0]?.fx_rate ?? rate;
      for (const s of fxDays) { if (s.snapshot_date <= date) best = s.fx_rate!; else break; }
      return best;
    };
    const valueOf = (s: (typeof snaps)[number]) => (czk ? s.value_czk : s.value_usd);
    // A month starts where the previous one ended — anchoring `first` to the month's OWN
    // first snapshot threw away the move between the last day of one month and the first of
    // the next, so every month was measured over a slightly short window.
    const byMonth = new Map<string, { first: number; last: number; }>();
    let prevEnd: number | null = null;
    for (const s of sorted) {
      const key = s.snapshot_date.slice(0, 7);
      const cur = byMonth.get(key);
      if (!cur) { byMonth.set(key, { first: prevEnd ?? valueOf(s), last: valueOf(s) }); }
      else cur.last = valueOf(s);
      prevEnd = valueOf(s);
    }
    // Money put into the positions per month, so a month with new buys doesn't read as
    // "return" and a month with a sale doesn't read as a loss. Same basis as the chart and
    // Roční zhodnocení — the snapshots being compared are holdings-only, so the baseline
    // has to be holdings-only too.
    const flowByMonth = new Map<string, number>();
    for (const [date, usd] of computeTradeFlows(txs as any)) {
      const m = date.slice(0, 7);
      flowByMonth.set(m, (flowByMonth.get(m) ?? 0) + (czk ? usd * fxAt(date) : usd));
    }
    return Array.from(byMonth.entries()).map(([key, { first, last }]) => {
      const flow = flowByMonth.get(key) ?? 0;
      const gain = (last - first) - flow;          // value change net of money paid in
      const base = first + flow;                    // capital working during the month
      return { key, pct: base > 0 ? (gain / base) * 100 : 0, amount: gain };
    }).slice(-6);
  }, [snaps, txs, currency, rate]);
  const money = (v: number) => formatAt(v, v); // already in the displayed currency

  const bestWorst = useMemo(() => {
    // Best / worst open position by unrealized profit, amount and % in the displayed currency.
    const byTicker = new Map<string, { profit: number; pct: number }>();
    for (const p of positions) {
      if (p.ticker === "CASH") continue;
      byTicker.set(p.ticker, { profit: pick(p.profitUsd, p.profitCzk), pct: pick(p.profitPct, p.profitPctCzk) });
    }
    const sorted = Array.from(byTicker.entries()).sort((a, b) => b[1].profit - a[1].profit);
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, currency]);

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <h2 className="font-display text-lg font-bold flex items-center gap-2 mb-4">
        <CalendarRange className="w-5 h-5 text-primary" /> {t('legacy.monthComparison.monthlyComparisonRecords')}</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-2">{t('legacy.monthComparison.last6Months')}</h3>
          <div className="space-y-1.5">
            {monthly.length === 0 && <p className="text-xs text-muted-foreground">{t('legacy.monthComparison.notEnoughData')}</p>}
            {monthly.map((m) => (
              <div key={m.key} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 px-3 py-2">
                <span className="text-xs font-mono">{m.key}</span>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-mono tabular-nums ${m.amount >= 0 ? "text-profit" : "text-loss"}`}>{money(m.amount)}</span>
                  <span className={`text-sm font-display font-bold tabular-nums w-20 text-right ${m.pct >= 0 ? "text-profit" : "text-loss"}`}>
                    {m.pct >= 0 ? "+" : ""}{m.pct.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%
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
                <Trophy className="w-3 h-3 text-profit" /> {t('legacy.monthComparison.bestHolding')}</p>
              <p className="font-display text-xl font-bold mt-1">{bestWorst.best[0]}</p>
              <p className="text-sm text-profit font-bold tabular-nums">
                {money(bestWorst.best[1].profit)} ({bestWorst.best[1].pct.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)
              </p>
            </div>
          )}
          {bestWorst.worst && bestWorst.best && bestWorst.worst[0] !== bestWorst.best[0] && (
            <div className="rounded-xl border border-loss/30 bg-loss/5 p-4">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1">
                <TrendingDown className="w-3 h-3 text-loss" /> {t('legacy.monthComparison.worstHolding')}</p>
              <p className="font-display text-xl font-bold mt-1">{bestWorst.worst[0]}</p>
              <p className="text-sm text-loss font-bold tabular-nums">
                {money(bestWorst.worst[1].profit)} ({bestWorst.worst[1].pct.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)

              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MonthComparison;
