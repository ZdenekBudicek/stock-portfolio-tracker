import { useTranslation } from "react-i18next";
import { currentLang, currentLocale } from "@/i18n";
import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatCzk, formatPct } from '@/data/portfolio';
import { useDailySnapshots, useTransactions, useComputedPortfolio, computeTradeFlows } from '@/hooks/usePortfolio';
import { computeYearlyGrowth, type YearData } from '@/lib/yearlyGrowth';
import { Target, CalendarDays, ChevronDown, ChevronUp, Pencil, Check, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { Input } from '@/components/ui/input';

const DEFAULT_GOAL_PCT = 20;
const goalKey = (uid?: string | null) => `annual_goal_pct:${uid ?? 'anon'}`;

const useAnnualGoalPct = () => {
  const { user } = useAuth();
  const [pct, setPct] = useState<number>(DEFAULT_GOAL_PCT);
  useEffect(() => {
    const raw = localStorage.getItem(goalKey(user?.id));
    const n = raw ? parseFloat(raw) : NaN;
    setPct(Number.isFinite(n) && n > 0 ? n : DEFAULT_GOAL_PCT);
  }, [user?.id]);
  const save = (n: number) => { setPct(n); localStorage.setItem(goalKey(user?.id), String(n)); };
  return { pct, save };
};

const CustomTooltip = ({ active, payload, label, hidden }: any) => {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  return (
    <div className="gradient-card border border-border rounded-lg px-3 py-2 shadow-lg">
      <p className="text-xs text-muted-foreground mb-1.5 font-medium">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="text-xs font-medium" style={{ color: p.color }}>
          {p.name}: {p.dataKey === 'totalValueCzk' ? (hidden ? t('legacy.yearlyGrowth.czk') : t('legacy.yearlyGrowth.czkM', { v0: (p.value / 1_000_000).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })) : `${p.value > 0 ? '+' : ''}${p.value.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`}
        </p>
      ))}
    </div>
  );
};

const YearCard = ({ d, annualGoalPct }: { d: YearData; annualGoalPct: number }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const goalReached = d.growthPct >= annualGoalPct;
  const { hidden } = useCurrency();
  const czk = (n: number) => (hidden ? t('legacy.yearlyGrowth.czk') : formatCzk(n));
  return (
    <div className="rounded-lg border border-border bg-accent/30 overflow-hidden transition-all">
      <button onClick={() => setExpanded(!expanded)} className="w-full p-4 flex items-center justify-between hover:bg-accent/50 transition-colors text-left">
        <div className="flex items-center gap-3">
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <span className="font-display font-bold text-sm text-foreground">{d.year}{d.isCurrent && t('legacy.yearlyGrowth.yearToDate')}</span>
          <span className={`text-xs font-display font-bold px-2 py-0.5 rounded-full ${goalReached ? 'bg-primary/15 text-profit' : d.isCurrent ? 'bg-warning/15 text-warning' : 'bg-destructive/15 text-loss'}`}>
            {goalReached ? t('legacy.yearlyGrowth.goalReached') : d.isCurrent ? t('legacy.yearlyGrowth.inProgress') : t('legacy.yearlyGrowth.notReached')}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right"><p className="text-xs text-muted-foreground">{t('legacy.yearlyGrowth.value')}</p><p className="text-sm font-display font-bold text-foreground">{czk(d.endValueCzk)}</p></div>
          <div className="text-right"><p className="text-xs text-muted-foreground">{t('legacy.yearlyGrowth.growth')}</p><p className={`text-sm font-display font-bold ${d.growthPct >= 0 ? 'text-profit' : 'text-loss'}`}>{formatPct(d.growthPct)}</p></div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border p-4 space-y-4 animate-fade-in">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-0.5"><p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('legacy.yearlyGrowth.startingValue')}</p><p className="text-sm font-display font-medium text-foreground">{czk(d.startValueCzk)}</p></div>
            <div className="space-y-0.5"><p className="text-[10px] text-muted-foreground uppercase tracking-wider" title={t('legacy.yearlyGrowth.purchasesMinusSalesForTheYearPlusChanges')}>{t('legacy.yearlyGrowth.deposited')}</p><p className="text-sm font-display font-medium text-foreground">{czk(d.depositsCzk)}</p></div>
            <div className="space-y-0.5"><p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('legacy.yearlyGrowth.return')}</p><p className={`text-sm font-display font-bold ${d.growthCzk >= 0 ? 'text-profit' : 'text-loss'}`}>{czk(d.growthCzk)}</p></div>
            <div className="space-y-0.5"><p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('legacy.yearlyGrowth.goal')}</p><p className="text-sm font-display font-medium text-foreground/70">+{annualGoalPct}%</p></div>
          </div>
          <div className="h-[300px]">
            <ResponsiveContainer>
              <LineChart data={d.monthly.map((point) => ({ ...point, label: currentLang() === 'cs' || point.month === 0 ? point.label : new Date(d.year, point.month - 1, 1).toLocaleDateString(currentLocale(), { month: 'short' }) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 16%)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(215, 14%, 50%)' }} />
                <YAxis yAxisId="pct" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10, fill: 'hsl(215, 14%, 50%)' }} domain={['auto', 'auto']} />
                <YAxis yAxisId="czk" orientation="right" tickFormatter={(v) => (hidden ? '••' : `${(v / 1_000_000).toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`)} tick={{ fontSize: 10, fill: 'hsl(215, 14%, 50%)' }} domain={['auto', 'auto']} />
                <Tooltip content={<CustomTooltip hidden={hidden} />} />

                <Legend verticalAlign="top" height={36} formatter={(value: string) => <span className="text-xs text-muted-foreground">{value}</span>} />
                <Line yAxisId="pct" type="monotone" dataKey="actualGrowthPct" name={t('legacy.yearlyGrowth.actualGrowth')} stroke="hsl(142, 72%, 50%)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                <Line yAxisId="pct" type="monotone" dataKey="goalGrowthPct" name={t('legacy.yearlyGrowth.goal2', { v0: annualGoalPct })} stroke="hsl(38, 92%, 55%)" strokeWidth={2} strokeDasharray="6 3" dot={false} />
                <Line yAxisId="czk" type="monotone" dataKey="totalValueCzk" name={t('legacy.yearlyGrowth.totalValue')} stroke="hsl(217, 91%, 60%)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
};

const YearlyGrowth = () => {
  const { t } = useTranslation();
  const { pct, save } = useAnnualGoalPct();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(String(pct));
  useEffect(() => { setDraft(String(pct)); }, [pct]);
  const commit = () => { const n = parseFloat(draft.replace(',', '.')); if (Number.isFinite(n) && n > 0 && n <= 1000) save(n); setEditing(false); };

  const { data: snaps = [] } = useDailySnapshots();
  const { data: txs = [] } = useTransactions();
  const portfolio = useComputedPortfolio();
  const { usdCzk } = portfolio;

  // Today's value split exactly as the header computes it (positions + cash, live prices), so
  // the running year ends on the same number as "Hodnota portfolia". Skipped while prices
  // load — until then the positions fall back to their cost and the total is not real.
  const cashUsd = portfolio.positions.find((p) => p.ticker === 'CASH')?.value ?? 0;
  const holdingsUsd = portfolio.totalValue - cashUsd;
  const liveReady = !portfolio.loading && Number.isFinite(portfolio.totalValue) && portfolio.totalValue > 0;

  const tradeFlowsUsd = useMemo(() => computeTradeFlows(txs), [txs]);

  const years: YearData[] = useMemo(() => computeYearlyGrowth({
    snapshots: snaps,
    tradeFlowsUsd,
    live: liveReady ? { date: new Date().toISOString().slice(0, 10), holdingsUsd, cashUsd, usdCzk } : null,
    goalPct: pct,
    nowYear: new Date().getFullYear(),
    fallbackFx: usdCzk || 23,
  }), [snaps, tradeFlowsUsd, liveReady, holdingsUsd, cashUsd, usdCzk, pct]);

  return (
    <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6 animate-fade-in-up space-y-4 hover-lift">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-primary/15 text-primary"><Target className="w-4 h-4" /></div>
          <div>
            <h2 className="font-display font-bold text-lg sm:text-xl text-foreground">{t('legacy.yearlyGrowth.annualReturn')}</h2>
            <p className="text-xs text-muted-foreground">{t('legacy.yearlyGrowth.fromPortfolioHistoryClickAYearForThe')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20">
          <span className="text-xs text-muted-foreground">{t('legacy.yearlyGrowth.goal3')}</span>
          {editing ? (
            <>
              <Input type="number" step="0.1" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setDraft(String(pct)); } }} autoFocus className="h-7 w-20 text-xs" />
              <span className="text-xs font-display font-bold text-primary">{t('legacy.yearlyGrowth.annually')}</span>
              <button onClick={commit} className="text-profit hover:opacity-80"><Check className="w-3.5 h-3.5" /></button>
              <button onClick={() => { setEditing(false); setDraft(String(pct)); }} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
            </>
          ) : (
            <>
              <span className="text-xs font-display font-bold text-primary">+{pct}{t('legacy.yearlyGrowth.annually')}</span>
              <button onClick={() => setEditing(true)} className="text-muted-foreground hover:text-primary"><Pencil className="w-3 h-3" /></button>
            </>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {years.length === 0 && <p className="text-xs text-muted-foreground">{t('legacy.yearlyGrowth.noHistoryYetAddItUsingTheBackfill')}</p>}
        {years.map((d) => <YearCard key={d.year} d={d} annualGoalPct={pct} />)}
      </div>
    </div>
  );
};

export default YearlyGrowth;
