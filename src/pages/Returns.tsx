// Výnosy a cash flow — docs/design/V2-Vynosy.dc.html
//
// Returns here are time-weighted (lib/returns) over the same series as the chart. Its money-in
// is the series' proxy (cash change + money spent on stock), so the result carries a quality
// level (lib/performanceQuality) and the page says plainly what each number means.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio, useTransactions } from '@/hooks/usePortfolio';
import { useDividends } from '@/hooks/useExtras';
import { summarizePerformance } from '@/lib/performanceModel';
import { usePerformanceSeries } from '@/hooks/usePerformanceSeries';
import { todayPrague } from '@/hooks/useInsights';
import PerformanceChart from '@/components/PerformanceChart';
import { ChartTip, Kpi, PageTitle, Panel, Segmented, Footnote, Pill, Label } from '@/components/v2/ui';
import { monthlyNetFlows, monthlyReturns, yearlyReturns } from '@/lib/returns';
import { dividendPayDate, dividendTaxRow } from '@/lib/dividendTax';
import { addDays, pragueDate } from '@/lib/czTax';
import { fmtCzk, fmtDay, fmtMonthShort, fmtMonthYear, fmtNum, fmtPercent } from '@/i18n/format';
import { currentLang } from '@/i18n';
import { formatMoney, symbolOf, wrapSymbol, type DisplayCurrency } from '@/lib/displayCurrency';
import { cn } from '@/lib/utils';

type Period = 'YTD' | '1R' | '3R' | 'ALL';
type Point = { date: string; total: number; cumDep: number };

const pctText = (r: number | null, signed = true) => (r == null ? '—' : fmtPercent(r * 100, 1, signed));

function periodStart(p: Period, today: string, first: string): string {
  // YTD is measured from the last close of the previous year.
  if (p === 'YTD') return addDays(`${today.slice(0, 4)}-01-01`, -1);
  if (p === '1R') return addDays(today, -365);
  if (p === '3R') return addDays(today, -1095);
  return first;
}

const heatCls = (r: number) => {
  const a = Math.abs(r);
  if (r >= 0) return a > 0.06 ? 'bg-profit/55 text-[#06170F] font-semibold' : a > 0.03 ? 'bg-profit/30 text-profit' : 'bg-profit/[0.14] text-profit/90';
  return a > 0.06 ? 'bg-loss/55 text-[#2A0710] font-semibold' : a > 0.03 ? 'bg-loss/30 text-loss' : 'bg-loss/[0.14] text-loss/90';
};

function MonthHeatmap({ points }: { points: Point[] }) {
  const { t } = useTranslation();
  const months = useMemo(() => monthlyReturns(points), [points]);
  const years = useMemo(() => yearlyReturns(months), [months]);
  const byKey = new Map(months.map((m) => [m.key, m]));
  const shownYears = years.slice(-4);
  if (shownYears.length === 0) return null;
  const monthLabels = Array.from({ length: 12 }, (_, i) => fmtMonthShort(`2026-${String(i + 1).padStart(2, '0')}`));
  const cell = (r: number) => `${r >= 0 ? '+' : ''}${fmtNum(r * 100, 1, 1)}`;
  return (
    <Panel title={t('returns.heatmap.title')} action={<span className="text-xs text-muted-foreground">{t('returns.heatmap.sub')}</span>}>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[52px_repeat(12,minmax(0,1fr))_70px] gap-1.5 mb-1.5 text-center text-xs text-muted-foreground">
            <span />{monthLabels.map((m) => <span key={m}>{m}</span>)}<span>{t('returns.heatmap.year')}</span>
          </div>
          {shownYears.map((y) => (
            <div key={y.key} className="grid grid-cols-[52px_repeat(12,minmax(0,1fr))_70px] gap-1.5 mb-1.5">
              <span className="flex items-center text-xs text-muted-foreground num">{y.key}</span>
              {monthLabels.map((_, i) => {
                const m = byKey.get(`${y.key}-${String(i + 1).padStart(2, '0')}`);
                return (
                  <div key={i} title={m?.partial ? t('returns.heatmap.partial') : undefined}
                    className={cn('flex h-9 items-center justify-center rounded-lg text-[11px] num', m ? heatCls(m.r) : 'bg-white/[0.03] text-white/20', m?.partial && 'ring-1 ring-white/25')}>
                    {m ? cell(m.r) : '·'}
                  </div>
                );
              })}
              <div className={cn('flex h-9 items-center justify-center rounded-[10px] text-[11px] num', heatCls(y.r))}>{cell(y.r)}</div>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('returns.heatmap.note')}</p>
    </Panel>
  );
}

function CashFlow({ points, currency }: { points: Point[]; currency: DisplayCurrency }) {
  const { t } = useTranslation();
  const { data: divs = [] } = useDividends();
  const { data: txs = [] } = useTransactions();
  const { hidden } = useCurrency();
  const lang = currentLang() === 'en' ? 'en' : 'cs';
  const p = useComputedPortfolio();
  const today = todayPrague();
  const months = useMemo(() => {
    const out: string[] = [];
    const [y, m] = today.slice(0, 7).split('-').map(Number);
    for (let i = 11; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
    return out;
  }, [today]);
  const k = currency !== 'USD' ? p.usdLocal : 1; // dividends and fees are converted at today's rate (approximate)
  const [hot, setHot] = useState<number | null>(null);
  const data = useMemo(() => {
    const net = monthlyNetFlows(points);
    const div = new Map<string, number>(), fee = new Map<string, number>();
    for (const d of divs) {
      if (d.status !== 'paid' || String(d.broker ?? '').toLowerCase() === 'auto') continue;
      const mo = dividendPayDate(d).slice(0, 7);
      // Net of withholding (XTB stores the gross amount).
      div.set(mo, (div.get(mo) ?? 0) + dividendTaxRow(d, 'cnb-daily').netUsd * k);
    }
    for (const tx of txs) {
      const f = Number(tx.fee_usd) || 0;
      if (!(f > 0) || tx.ticker === 'CASH') continue;
      const mo = pragueDate(tx.executed_at).slice(0, 7);
      fee.set(mo, (fee.get(mo) ?? 0) + f * k);
    }
    return months.map((mo) => ({ mo, net: net.get(mo) ?? 0, div: div.get(mo) ?? 0, fee: fee.get(mo) ?? 0 }));
  }, [points, divs, txs, months, k]);
  // Scale over every bar drawn (dividends and fees too), or a month with only a dividend blew past the panel.
  const max = Math.max(1e-9, ...data.flatMap((d) => [Math.abs(d.net), d.div, d.fee]));
  const sum = (f: (d: typeof data[number]) => number) => data.reduce((s, d) => s + f(d), 0);
  const money = (v: number) => {
    if (hidden) return '••••';
    if (currency === 'CZK') return fmtCzk(v);
    if (currency !== 'USD') return formatMoney(v, currency, lang, { decimals: 0 });
    return `${v < 0 ? '−' : ''}$${fmtNum(Math.abs(Math.round(v)))}`;
  };
  const inSum = sum((d) => Math.max(0, d.net)), outSum = sum((d) => Math.min(0, d.net));
  return (
    <Panel className="lg:col-span-7" title={t('returns.cashflow.title')} action={<span className="text-xs text-muted-foreground">{t('returns.cashflow.sub')}</span>}>
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3">
        <Kpi label={t('returns.cashflow.in')} value={`+${money(inSum)}`} size="sm" />
        <Kpi label={t('returns.cashflow.out')} value={money(outSum)} tone={outSum < 0 ? 'loss' : 'neutral'} size="sm" />
        <Kpi label={t('returns.cashflow.dividends')} value={`+${money(sum((d) => d.div))}`} tone="profit" size="sm" />
        <Kpi label={t('returns.cashflow.fees')} value={money(-sum((d) => d.fee))} tone="warning" size="sm" />
      </div>
      <div className="relative flex h-48 items-stretch gap-1.5" onMouseLeave={() => setHot(null)}>
        {hot != null && data[hot] && (() => {
          const d = data[hot];
          const line = (color: string, label: string, v: number, tone?: string) => (
            <div className="flex items-center justify-between gap-4"><span className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-sm', color)} />{label}</span><span className={cn('num', tone)}>{money(v)}</span></div>
          );
          return (
            <ChartTip at={((hot + 0.5) / data.length) * 100}>
              <b className="mb-1.5 block capitalize">{fmtMonthYear(d.mo + '-01')}</b>
              <div className="space-y-1">
                {d.net >= 0 ? line('bg-primary', t('returns.cashflow.legendIn'), d.net) : line('bg-loss', t('returns.cashflow.legendOut'), d.net, 'text-loss')}
                {line('bg-profit', t('returns.cashflow.legendDiv'), d.div, d.div > 0 ? 'text-profit' : undefined)}
                {line('bg-warning', t('returns.cashflow.legendFee'), -d.fee, d.fee > 0 ? 'text-warning' : undefined)}
              </div>
            </ChartTip>
          );
        })()}
        {data.map((d, i) => {
          const h = (Math.abs(d.net) / max) * 50;
          return (
            <div key={d.mo} className={cn('relative flex-1 rounded-lg transition-[opacity,background-color] duration-200', hot != null && hot !== i && 'opacity-35', hot === i && 'bg-white/[0.05]')}
              onMouseEnter={() => setHot(i)} onClick={() => setHot((x) => (x === i ? null : i))}>
              <div className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
              {d.net > 0 && <div className="absolute inset-x-[15%] bottom-1/2 rounded-t-md" style={{ height: `${h}%`, background: 'linear-gradient(180deg, hsl(var(--primary)), hsl(250 80% 62%))' }} />}
              {d.net < 0 && <div className="absolute inset-x-[15%] top-1/2 rounded-b-md bg-loss/85" style={{ height: `${h}%` }} />}
              {d.div > 0 && <div className="absolute right-[4%] bottom-1/2 w-[18%] rounded-sm bg-profit" style={{ height: `${Math.max(2, (d.div / max) * 50)}%` }} />}
              {d.fee > 0 && <div className="absolute right-[4%] top-1/2 w-[18%] rounded-sm bg-warning" style={{ height: `${Math.max(1, (d.fee / max) * 50)}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1.5 text-center text-[10px] text-muted-foreground num">
        {data.map((d) => <span key={d.mo} className="flex-1">{fmtMonthShort(d.mo)}</span>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span><span className="text-primary">■</span> {t('returns.cashflow.legendIn')}</span><span><span className="text-loss">■</span> {t('returns.cashflow.legendOut')}</span>
        <span><span className="text-profit">■</span> {t('returns.cashflow.legendDiv')}</span><span><span className="text-warning">■</span> {t('returns.cashflow.legendFee')}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('returns.cashflow.note')}</p>
    </Panel>
  );
}

function ProfitSources() {
  const { t } = useTranslation();
  const p = useComputedPortfolio();
  const { format, formatAt, currency, local, pick, hidden } = useCurrency();
  const lang = currentLang() === 'en' ? 'en' : 'cs';
  const total = pick(p.totalProfit, p.totalProfitCzk);
  const realized = currency === 'USD' ? p.realizedProfit : p.realizedProfit * p.usdLocal;
  const unrealized = pick(p.unrealizedProfit, p.unrealizedProfitCzk);
  // Open positions in the local currency (koruny or the chosen one): what came from the share
  // price (at today's rate) and what from the currency's move since each purchase — exact, from
  // the cost at each purchase day's rate.
  const priceCzk = p.unrealizedProfit * p.usdLocal;
  const fxCzk = p.unrealizedProfitCzk - priceCzk;
  const rest = total - realized - unrealized;
  const rows = [
    { label: t('returns.sources.realized'), v: realized, text: format(p.realizedProfit) },
    { label: t('returns.sources.unrealized'), v: unrealized, text: formatAt(p.unrealizedProfit, p.unrealizedProfitCzk) },
    { label: t('returns.sources.rest'), v: rest, text: format(currency === 'USD' ? rest : rest / p.usdLocal) },
  ];
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.v)));
  const czkMasked = wrapSymbol('••••', local, lang);
  const localMoney = (v: number) => (local === 'CZK' ? fmtCzk(v) : formatMoney(v, local, lang));
  return (
    <Panel className="lg:col-span-5" title={t('returns.sources.title')} action={<Pill tone={total >= 0 ? 'profit' : 'loss'}>{total >= 0 ? '+' : ''}{formatAt(p.totalProfit, p.totalProfitCzk)}</Pill>}>
      <div className="space-y-4">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex justify-between text-[13px]"><span>{r.label}</span><span className={cn('num', r.v >= 0 ? 'text-profit' : 'text-loss')}>{r.v >= 0 ? '+' : ''}{r.text}</span></div>
            <div className="mt-1.5 h-2.5 rounded-full bg-white/[0.05]">
              <div className="h-2.5 rounded-full" style={{ width: `${(Math.abs(r.v) / max) * 100}%`, background: r.v >= 0 ? 'linear-gradient(90deg, hsl(var(--profit) / 0.35), hsl(var(--profit)))' : 'hsl(var(--loss))' }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 border-t border-white/[0.08] pt-4">
        <Label>{t('returns.sources.openCzk', { currency: symbolOf(local, lang) })}</Label>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Kpi label={t('returns.sources.fromPrice')} value={hidden ? czkMasked : localMoney(priceCzk)} tone={priceCzk >= 0 ? 'profit' : 'loss'} size="sm" />
          <Kpi label={t('returns.sources.fromFx')} value={hidden ? czkMasked : localMoney(fxCzk)} tone={fxCzk >= 0 ? 'profit' : 'loss'} size="sm" />
        </div>
      </div>
    </Panel>
  );
}

/** Plain-language explanation of every number on the page. */
function HowToRead({ annual, total, years }: { annual: number | null; total: number | null; years: number | null }) {
  const { t } = useTranslation();
  const items = ['profit', 'twr', 'annual', 'bench', 'cashflow', 'heatmap'] as const;
  return (
    <Panel title={<span className="flex items-center gap-2"><Info className="h-4 w-4 text-primary" /> {t('returns.explain.title')}</span>}>
      {annual != null && total != null && years != null && (
        <div className="mb-4 rounded-2xl border border-primary/25 bg-primary/[0.07] p-3.5 text-[13px] leading-relaxed">
          {t('returns.explain.example', { total: pctText(total), years: fmtNum(years, 1, 1), annual: pctText(annual) })}
        </div>
      )}
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {items.map((k) => (
          <div key={k}>
            <dt className="text-[13px] font-semibold">{t(`returns.explain.${k}.term`)}</dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(`returns.explain.${k}.text`)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

const Returns = () => {
  const { t } = useTranslation();
  const { currency, formatAt, pick } = useCurrency();
  const p = useComputedPortfolio();
  const model = usePerformanceSeries(currency);
  const { points, quality } = model;
  const [period, setPeriod] = useState<Period>('ALL');
  const today = todayPrague();

  const stats = useMemo(() => {
    if (points.length < 2) return null;
    const summary = summarizePerformance(model, { from: periodStart(period, today, points[0].date), to: points[points.length - 1].date });
    if (summary.profit == null) return null;
    return { twr: summary.portfolioReturn, benchTwr: summary.benchmarkReturn, annual: summary.annualReturn,
      benchAnnual: summary.benchmarkAnnualReturn, profit: summary.profit, from: summary.from, years: summary.years };
  }, [model, points, period, today]);

  const total = pick(p.totalProfit, p.totalProfitCzk);
  const estimated = quality && quality.level !== 'ok';
  const insufficient = quality?.level === 'insufficient';
  const headline = stats ? (stats.annual ?? stats.twr) : null;
  const benchDiff = stats && stats.benchTwr != null
    ? (stats.annual != null && stats.benchAnnual != null ? stats.annual - stats.benchAnnual : stats.twr - stats.benchTwr)
    : null;
  const periodLabel = t(`returns.period.${period}`);

  return (
    <div>
      <PageTitle
        back={{ to: '/', label: t('nav.overview') }}
        title={t('returns.title')}
        right={<Segmented<Period> value={period} onChange={setPeriod} options={(['YTD', '1R', '3R', 'ALL'] as const).map((v) => ({ value: v, label: t(`returns.period.${v}`) }))} />}
      />
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Panel glow={total >= 0 ? 'profit' : 'loss'}>
          <Kpi label={t('returns.kpi.totalProfit')} value={`${total >= 0 ? '+' : ''}${formatAt(p.totalProfit, p.totalProfitCzk)}`} tone={total >= 0 ? 'profit' : 'loss'} size="lg"
            sub={p.netDepositsUsd != null ? t('returns.kpi.fromDeposits', { amount: formatAt(p.netDepositsUsd, p.netDepositsCzk ?? 0) }) : undefined} />
        </Panel>
        <Panel>
          <Kpi label={t('returns.kpi.periodProfit', { period: periodLabel })} value={stats ? `${stats.profit >= 0 ? '+' : ''}${formatAt(currency === 'USD' ? stats.profit : stats.profit / p.usdLocal, stats.profit)}` : '—'}
            tone={stats && stats.profit >= 0 ? 'profit' : 'loss'} size="lg" sub={t('returns.kpi.periodProfitSub')} />
        </Panel>
        <Panel>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">{stats?.annual != null ? t('returns.kpi.annual') : t('returns.kpi.periodReturn', { period: periodLabel })}</span>
            {estimated && <Pill tone="warning">{insufficient ? t('returns.quality.insufficientShort') : t('returns.quality.estimatedShort')}</Pill>}
          </div>
          <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{insufficient ? '—' : pctText(headline)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {stats && stats.annual != null && !insufficient
              ? t('returns.kpi.cumulative', { total: pctText(stats.twr), years: fmtNum(stats.years, 1, 1) })
              : t('returns.kpi.twrSub')}
          </div>
        </Panel>
        <Panel>
          <Kpi label={t('returns.kpi.vsSp')} value={benchDiff != null && !insufficient ? `${benchDiff >= 0 ? '+' : ''}${fmtNum(benchDiff * 100, 1)} ${t('returns.kpi.pp')}` : '—'}
            tone="primary" size="lg"
            sub={stats?.benchTwr != null
              ? t(stats.benchAnnual != null ? 'returns.kpi.spAnnual' : 'returns.kpi.spPeriod', { pct: pctText(stats.benchAnnual ?? stats.benchTwr) })
              : t('returns.kpi.noBench')} />
        </Panel>
      </div>

      {estimated && quality && (
        <div className="mt-4 rounded-2xl border border-warning/25 bg-warning/[0.07] p-3.5 text-[13px]">
          <b className="text-warning">{insufficient ? t('returns.quality.insufficientTitle') : t('returns.quality.estimatedTitle')}</b>{' '}
          <span className="text-muted-foreground">{quality.reasons.map((r) => t(`returns.quality.reason.${r}`, { date: quality.cashTrackedFrom ? fmtDay(quality.cashTrackedFrom) : '' })).join(' ')}</span>
          {quality.extremeDays.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('returns.quality.extremeDays', { count: quality.extremeDays.length })}</summary>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {quality.extremeDays.slice(0, 12).map((d) => (
                  <span key={d.date} className={cn('rounded-lg px-2 py-0.5 text-[11px] num', d.r >= 0 ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss')}>{fmtDay(d.date)} {pctText(d.r)}</span>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="mt-4"><PerformanceChart /></div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <CashFlow points={points} currency={currency} />
        <ProfitSources />
      </div>
      <div className="mt-4"><MonthHeatmap points={points} /></div>
      <div className="mt-4"><HowToRead annual={stats?.annual ?? null} total={stats?.twr ?? null} years={stats?.years ?? null} /></div>
      <div className="mt-4 text-center">
        <Link to="/vynosy/historie" className="text-sm font-medium text-primary">{t('returns.historyLink')} →</Link>
      </div>
      <Footnote>{t('returns.footnote', { from: stats ? fmtDay(stats.from) : '—' })}</Footnote>
    </div>
  );
};

export default Returns;
