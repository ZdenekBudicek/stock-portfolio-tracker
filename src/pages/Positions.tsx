// Pozice — docs/design/V2-Pozice.dc.html
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { useTaxModel } from '@/hooks/useInsights';
import { TickerLogo } from '@/components/TickerLogo';
import HoldingsTable from '@/components/HoldingsTable';
import Watchlist from '@/components/Watchlist';
import ClosedPositions from '@/components/ClosedPositions';
import SplitsBanner from '@/components/SplitsBanner';
import { MoversCard, holdingsOf, RING_COLORS } from '@/components/v2/widgets';
import { Kpi, PageTitle, Panel, Segmented, Footnote, EmptyNote } from '@/components/v2/ui';
import { squarify } from '@/lib/treemap';
import { formatPct } from '@/data/portfolio';
import { fmtPercent } from '@/i18n/format';
import { currentLang } from '@/i18n';
import { compactMoney } from '@/lib/displayCurrency';
import { cn } from '@/lib/utils';
import { useJurisdiction } from '@/hooks/useTaxResidence';

type MapMode = 'day' | 'total';

/** Red/green intensity for a % move; ±12 % is full colour. */
const tileBg = (pct: number) => {
  const a = Math.min(1, Math.abs(pct) / 12);
  const c = pct >= 0 ? 'var(--profit)' : 'var(--loss)';
  return `linear-gradient(160deg, hsl(${c} / ${0.14 + a * 0.62}), hsl(${c} / ${0.06 + a * 0.3}))`;
};

function PortfolioMap() {
  const { t } = useTranslation();
  const { positions } = useComputedPortfolio();
  const { format, pick } = useCurrency();
  const [mode, setMode] = useState<MapMode>('day');
  const hold = holdingsOf(positions);
  const W = 200, H = 100;
  const rects = useMemo(() => squarify(hold, (p) => p.value, W, H), [hold]);
  return (
    <Panel
      className="lg:col-span-2"
      title={t('positions.map.title')}
      action={<Segmented<MapMode> value={mode} onChange={setMode} options={[{ value: 'day', label: t('positions.map.day') }, { value: 'total', label: t('positions.map.total') }]} />}
    >
      {rects.length === 0 ? <EmptyNote>{t('positions.map.empty')}</EmptyNote> : (
        <div className="focus-list relative h-[300px] sm:h-[380px]">
          {rects.map(({ item: p, x, y, w, h }) => {
            const pct = mode === 'day' ? p.dailyChangePct : pick(p.profitPct, p.profitPctCzk);
            const big = w * h > 900, small = w < 18 || h < 18;
            return (
              <Link
                key={p.ticker}
                to={`/stock/${p.ticker}`}
                title={`${p.ticker} · ${format(p.value)} · ${formatPct(pct)}`}
                className="group/link absolute overflow-hidden rounded-2xl border border-white/10 p-2.5 sm:p-3.5 flex flex-col justify-between transition hover:z-10 hover:scale-[1.02] hover:border-white/40 hover:shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]"
                style={{ left: `calc(${(x / W) * 100}% + 3px)`, top: `calc(${(y / H) * 100}% + 3px)`, width: `calc(${(w / W) * 100}% - 6px)`, height: `calc(${(h / H) * 100}% - 6px)`, background: tileBg(pct) }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <TickerLogo ticker={p.ticker} size={big ? 'md' : 'sm'} />
                  {!small && <div className="min-w-0"><div className="font-semibold text-sm truncate">{p.ticker}</div>{big && <div className="text-xs text-white/70 num">{fmtPercent(p.allocation, 1)}</div>}</div>}
                </div>
                {!small && (
                  <div>
                    <div className={`${big ? 'text-2xl sm:text-3xl' : 'text-base'} font-semibold tracking-tight num`}>{formatPct(pct)}</div>
                    {big && <div className="text-xs text-white/75 num">{format(p.value)}</div>}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-2">
        <span>{t(mode === 'day' ? 'positions.map.legendDay' : 'positions.map.legendTotal')}</span>
        <span className="flex items-center gap-1.5">{fmtPercent(-12, 0)} <span className="h-1.5 w-28 rounded-full" style={{ background: 'linear-gradient(90deg, hsl(var(--loss)), hsl(var(--loss) / 0.15), hsl(var(--profit) / 0.15), hsl(var(--profit)))' }} /> {fmtPercent(12, 0, true)}</span>
      </div>
    </Panel>
  );
}

function Concentration() {
  const { t } = useTranslation();
  const { positions } = useComputedPortfolio();
  const hold = holdingsOf(positions).sort((a, b) => b.value - a.value);
  const total = hold.reduce((s, p) => s + p.value, 0);
  const top3 = hold.slice(0, 3);
  const share = total > 0 ? (top3.reduce((s, p) => s + p.value, 0) / total) * 100 : 0;
  return (
    <Panel title={t('positions.concentration.title')}>
      <div className="flex items-center gap-3.5">
        <div className={`text-[34px] font-semibold tracking-[-0.04em] num ${share > 50 ? 'text-warning' : ''}`}>{fmtPercent(share, 1)}</div>
        <div className="text-xs text-muted-foreground">{t('positions.concentration.top3')}<br />{top3.map((p) => p.ticker).join(', ')}</div>
      </div>
      <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {top3.map((p, i) => <i key={p.ticker} style={{ width: `${(p.value / total) * 100}%`, background: RING_COLORS[i] }} />)}
        <i className="flex-1 bg-white/[0.12]" />
      </div>
    </Panel>
  );
}

type GridMode = 'total' | 'day';

/**
 * Every open position at a glance: rank by value, logo, weight, price and the gain in money and
 * percent — overall (unrealized, in the shown currency) or today. Three columns on wide screens.
 */
function PositionsGrid() {
  const { t } = useTranslation();
  const { positions, usdLocal } = useComputedPortfolio();
  const { currency, hidden } = useCurrency();
  const [mode, setMode] = useState<GridMode>('total');
  const hold = holdingsOf(positions).sort((a, b) => b.value - a.value);
  const compact = (v: number) => {
    if (hidden) return '••••';
    // "$60.63K" in dollars (as brokers show it), "1,26 mil. Kč" in koruna (likewise the other local currencies).
    const sign = v < 0 ? '−' : '';
    if (currency === 'USD') return `${sign}$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(Math.abs(v))}`;
    return sign + compactMoney(Math.abs(v), currency, currentLang() === 'en' ? 'en' : 'cs', 2);
  };
  const price = (v: number) => (hidden ? '••••' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  if (hold.length === 0) return null;
  return (
    <Panel title={t('positions.grid.title')} action={<Segmented<GridMode> value={mode} onChange={setMode} options={[{ value: 'total', label: t('positions.map.total') }, { value: 'day', label: t('positions.map.day') }]} />}>
      <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
        {hold.map((p, i) => {
          const amt = mode === 'day' ? (currency !== 'USD' ? p.dailyChangeUsd * usdLocal : p.dailyChangeUsd) : (currency !== 'USD' ? p.profitCzk : p.profitUsd);
          const pct = mode === 'day' ? p.dailyChangePct : (currency !== 'USD' ? p.profitPctCzk : p.profitPct);
          const up = amt >= 0;
          return (
            <Link key={p.ticker} to={`/stock/${p.ticker}`} className="group/link flex items-center gap-3 border-b border-white/[0.06] py-3 transition-colors hover:bg-white/[0.03]">
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground num">#{i + 1}</span>
              <TickerLogo ticker={p.ticker} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{p.ticker}</div>
                <div className="text-xs text-muted-foreground num">{fmtPercent(p.allocation, 2)}</div>
              </div>
              <div className="text-right">
                <div className="font-semibold num">{price(p.currentPrice)}</div>
                <div className={cn('text-xs font-medium num', up ? 'text-profit' : 'text-loss')}>{up ? '' : ''}{compact(amt)} ({fmtPercent(pct, 2, true)})</div>
              </div>
            </Link>
          );
        })}
      </div>
    </Panel>
  );
}

const Positions = () => {
  const { t } = useTranslation();
  const p = useComputedPortfolio();
  const tax = useTaxModel();
  const { caps } = useJurisdiction();
  const { format, formatAt } = useCurrency();
  const hold = holdingsOf(p.positions);
  return (
    <div>
      <PageTitle
        eyebrow={t('positions.open', { count: hold.length })}
        title={t('nav.positions')}
        right={
          <div className="flex gap-6 sm:gap-8">
            <Kpi label={t('positions.kpi.value')} value={format(p.totalValue - (p.positions.find((x) => x.ticker === 'CASH')?.value ?? 0))} size="sm" />
            <Kpi label={t('positions.kpi.today')} value={`${p.dailyReturn >= 0 ? '+' : ''}${format(p.dailyReturn)}`} tone={p.dailyReturn >= 0 ? 'profit' : 'loss'} size="sm" />
            <Kpi label={t('positions.kpi.unrealized')} value={formatAt(p.unrealizedProfit, p.unrealizedProfitCzk)} tone={p.unrealizedProfit >= 0 ? 'profit' : 'loss'} size="sm" />
            {caps.holdingExemption && <Kpi label={t('positions.kpi.taxFree')} value={format(tax.summary.exemptValueUsd)} tone="profit" size="sm" className="hidden sm:block" />}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PortfolioMap />
        <div className="flex flex-col gap-4">
          <MoversCard limit={7} />
          <Concentration />
        </div>
      </div>
      <div className="mt-4"><PositionsGrid /></div>
      <div className="mt-4 space-y-4">
        <HoldingsTable />
        <div id="watchlist"><Watchlist /></div>
        <ClosedPositions />
        <SplitsBanner />
      </div>
      {caps.holdingExemption && <Footnote>{t('positions.footnote')}</Footnote>}
    </div>
  );
};

export default Positions;
