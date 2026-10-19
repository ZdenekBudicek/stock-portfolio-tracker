// Detail akcie — docs/design/V2-Akcie.dc.html
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { createChart, createSeriesMarkers, AreaSeries, LineStyle, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type Time, type ISeriesMarkersPluginApi } from 'lightweight-charts';
import { ExternalLink, Newspaper, ChevronDown } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio, useLivePrices, useTransactions, usePositions } from '@/hooks/usePortfolio';
import { useEarnings, useStockNews, useWatchlist } from '@/hooks/useExtras';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { useDividendModel, useTaxModel, todayPrague } from '@/hooks/useInsights';
import { TickerLogo } from '@/components/TickerLogo';
import { fmtDate, monthShort, relDays, earningsWhen } from '@/components/v2/widgets';
import CompanyFinancials from '@/components/fundamentals/CompanyFinancials';
import { FairValueForSymbol } from '@/components/fundamentals/FairValue';
import { currentLang, currentLocale } from '@/i18n';
import { fmtNum, fmtPercent } from '@/i18n/format';
import { EmptyNote, Footnote, Kpi, Label, PageTitle, Panel, Pill, Segmented } from '@/components/v2/ui';
import { addDays, daysBetween, pragueDate } from '@/lib/czTax';
import { isRealTradeTx } from '@/lib/fifo';
import { formatPct, formatUsd } from '@/data/portfolio';
import { cn } from '@/lib/utils';
import { useJurisdiction } from '@/hooks/useTaxResidence';
import { holdingProgress, holdingRuleFor } from '@/lib/tax/holdingRule';
import { isCryptoHolding } from '../../supabase/functions/_shared/crypto.js';

type Range = '1M' | '6M' | '1Y' | '5Y' | 'ALL';
const RANGE_DAYS: Record<Range, number | null> = { '1M': 31, '6M': 183, '1Y': 365, '5Y': 1826, 'ALL': null };

const themeColor = (name: string, alpha?: number) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(', ');
  return alpha != null ? `hsla(${v}, ${alpha})` : `hsl(${v})`;
};

const relTime = (t: TFunction, ts: number | null): string => {
  if (!ts) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 3600) return t('stock.ago.min', { count: Math.max(1, Math.floor(s / 60)) });
  if (s < 86400) return t('stock.ago.hour', { count: Math.floor(s / 3600) });
  return t('stock.ago.day', { count: Math.floor(s / 86400) });
};

interface Mark { date: string; side: 'BUY' | 'SELL'; shares: number; price: number; }

function PriceChart({ sym, marks, avgPrice, earningsDate }: { sym: string; marks: Mark[]; avgPrice: number | null; earningsDate: string | null }) {
  const { data: history = [], isLoading } = usePriceHistory(sym);
  const live = useLivePrices();
  const livePrice = live.data?.prices[sym]?.price ?? null;
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>('1Y');
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const today = todayPrague();

  const data = useMemo(() => {
    const d = history.map((h) => ({ time: h.date as Time, value: h.close }));
    if (livePrice) {
      // Today's point always follows the live price (a stored close for today can be stale).
      if (history.length && history[history.length - 1].date === today) d[d.length - 1] = { time: today as Time, value: livePrice };
      else if (!history.length || history[history.length - 1].date < today) d.push({ time: today as Time, value: livePrice });
    }
    return d;
  }, [history, livePrice, today]);

  // The container exists only once the history is loaded — create the chart then, not on the
  // first render (the live point alone made data non-empty while the div was not mounted yet).
  const ready = !isLoading && data.length >= 2;
  useEffect(() => {
    if (!ready || !ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: themeColor('--muted-foreground'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: themeColor('--border', 0.35) } },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.06 } },
      timeScale: { borderVisible: false, rightOffset: 3 },
      localization: { locale: currentLocale(), priceFormatter: (v: number) => `$${v.toLocaleString(currentLocale(), { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: themeColor('--info'), lineWidth: 3,
      topColor: themeColor('--info', 0.4), bottomColor: themeColor('--info', 0),
      priceLineVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; markersRef.current = null; };
  }, [ready]);

  useEffect(() => {
    const series = seriesRef.current, chart = chartRef.current;
    if (!series || !chart || data.length === 0) return;
    series.setData(data);
    const first = String(data[0].time);
    // Markers snap to the nearest trading day on/after the trade so they sit on the curve.
    const days = data.map((d) => String(d.time));
    const snap = (date: string) => days.find((d) => d >= date) ?? days[days.length - 1];
    const markers = marks.filter((m) => m.date >= first).map((m) => ({
      time: snap(m.date) as Time,
      position: m.side === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
      shape: 'circle' as 'circle' | 'square',
      color: m.side === 'BUY' ? themeColor('--profit') : themeColor('--loss'),
      size: 1,
    }));
    if (earningsDate && earningsDate >= first) markers.push({ time: snap(earningsDate) as Time, position: 'aboveBar', shape: 'square', color: themeColor('--primary'), size: 1 });
    markersRef.current?.setMarkers(markers.sort((a, b) => String(a.time).localeCompare(String(b.time))));
    series.priceLines().forEach((l) => series.removePriceLine(l));
    if (avgPrice) series.createPriceLine({ price: avgPrice, color: themeColor('--warning'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: t('stock.chart.yourAvg') });
    const n = RANGE_DAYS[range];
    if (n == null) chart.timeScale().fitContent();
    else {
      const from = addDays(today, -n);
      chart.timeScale().setVisibleRange({ from: (from > first ? from : first) as Time, to: data[data.length - 1].time });
    }
  }, [ready, data, marks, avgPrice, earningsDate, range, today, t]);

  return (
    <Panel className="lg:col-span-8" title={
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-normal text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-profit shadow-[0_0_8px_hsl(var(--profit))]" />{t('stock.chart.buys')}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-loss" />{t('stock.chart.sells')}</span>
        {avgPrice != null && <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-warning" />{t('stock.chart.avgLegend')}</span>}
        {earningsDate && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary" />{t('stock.chart.earnings')}</span>}
      </span>
    } action={<Segmented<Range> value={range} onChange={setRange} options={(['1M', '6M', '1Y', '5Y', 'ALL'] as const).map((r) => ({ value: r, label: t(`stock.range.${r}`) }))} />}>
      {isLoading ? <div className="h-[340px] animate-pulse rounded-2xl bg-white/[0.03]" /> : data.length < 2 ? (
        <div className="flex h-[340px] flex-col items-center justify-center gap-3">
          <EmptyNote>{t('stock.chart.noHistory', { sym })}</EmptyNote>
          <a href={`https://www.tradingview.com/symbols/${encodeURIComponent(sym)}/`} target="_blank" rel="noopener noreferrer" className="text-sm text-primary">{t('stock.chart.openTv')} ↗</a>
        </div>
      ) : <div ref={ref} className="h-[340px]" />}
    </Panel>
  );
}

const StockDetail = () => {
  const { t } = useTranslation();
  const { ticker = '' } = useParams();
  const sym = ticker.toUpperCase();
  const { format, formatAt, pick, hidden } = useCurrency();
  const { positions } = useComputedPortfolio();
  const { data: dbPositions = [] } = usePositions();
  const { data: watch = [] } = useWatchlist();
  const live = useLivePrices();
  const { data: txs = [] } = useTransactions();
  const { data: earnings = [] } = useEarnings();
  const { data: news } = useStockNews(sym);
  const { data: history = [] } = usePriceHistory(sym);
  const tax = useTaxModel();
  const { code: residence } = useJurisdiction();
  const div = useDividendModel();
  const [openNews, setOpenNews] = useState<number | null>(null);
  const [tradeFilter, setTradeFilter] = useState<'all' | 'BUY' | 'SELL'>('all');
  const today = todayPrague();

  const p = positions.find((x) => x.ticker === sym);
  // A coin has no results, statements, fair value or dividends — those cards are company-only.
  const isCrypto = isCryptoHolding(sym, p?.type);
  const name = p?.name ?? dbPositions.find((x) => x.ticker === sym)?.name ?? watch.find((w) => w.ticker === sym)?.name ?? sym;
  const quote = live.data?.prices[sym];
  const price = p?.currentPrice ?? quote?.price ?? null;
  const dayPct = p?.dailyChangePct ?? quote?.changePct ?? null;

  // Split-adjusted trade markers: buys from the FIFO lots (their price follows splits), sells
  // from the disposals, one marker per trade.
  const marks = useMemo<Mark[]>(() => {
    const buys = new Map<string, Mark>(), sells = new Map<string, Mark>();
    const addBuy = (id: string, at: string, shares: number, price: number) => {
      const e = buys.get(id);
      if (e) e.shares += shares; else buys.set(id, { date: pragueDate(at), side: 'BUY', shares, price });
    };
    for (const l of tax.fifo.openLots) if (l.ticker === sym) addBuy(l.buyTxId, l.acquiredAt, l.shares, l.priceUsd);
    for (const d of tax.fifo.disposals) {
      if (d.ticker !== sym || d.kind !== 'sale') continue;
      addBuy(d.buyTxId, d.acquiredAt, d.shares, d.buyPriceUsd);
      const e = sells.get(d.sellTxId);
      if (e) e.shares += d.shares; else sells.set(d.sellTxId, { date: pragueDate(d.soldAt), side: 'SELL', shares: d.shares, price: d.sellPriceUsd });
    }
    return [...buys.values(), ...sells.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [tax.fifo, sym]);

  const trades = useMemo(() => (txs as any[])
    .filter((t) => t.ticker === sym && isRealTradeTx(t) && Number(t.price_usd) > 0)
    .sort((a, b) => b.executed_at.localeCompare(a.executed_at)), [txs, sym]);
  const shownTrades = trades.filter((t) => tradeFilter === 'all' || t.side === tradeFilter);

  const nextEarnings = earnings.find((e) => e.ticker === sym && e.earnings_date >= today) ?? null;
  const yearAgo = addDays(today, -365);
  const year = history.filter((h) => h.date >= yearAgo);
  const lo = year.length ? year.reduce((a, b) => (b.close < a.close ? b : a)) : null;
  const hi = year.length ? year.reduce((a, b) => (b.close > a.close ? b : a)) : null;
  const rangePos = lo && hi && price && hi.close > lo.close ? Math.min(100, Math.max(0, ((price - lo.close) / (hi.close - lo.close)) * 100)) : null;

  const lots = tax.lots.filter((l) => l.ticker === sym);
  // The holding-period rule of the user's residence for this kind (null = none, just "held since").
  const rule = holdingRuleFor(residence, tax.kindOf(sym).kind);
  const hold = rule ? holdingProgress(lots, rule, today) : null;
  const holdKeys = !rule ? null : rule.effect === 'long-term' ? 'stock.tax.longTerm' : 'stock.tax';
  const oldestLot = lots.reduce<string | null>((a, l) => (a == null || l.acquiredDate < a ? l.acquiredDate : a), null);
  const annualDiv = div.annual.get(sym.split('.')[0]) ?? 0;
  const profit = p ? pick(p.profitUsd, p.profitCzk) : 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <TickerLogo ticker={sym} size="xl" className="shadow-[0_10px_40px_-10px_hsl(var(--info)/0.8)]" />
          <div>
            <PageTitle back={{ to: '/pozice', label: t('nav.positions') }} title={name} />
            <div className="-mt-4 flex items-center gap-2 text-xs text-muted-foreground"><span className="num">{sym}</span>
              <a href={`https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">Yahoo <ExternalLink className="h-3 w-3" /></a>
              <a href={`https://www.tradingview.com/symbols/${encodeURIComponent(sym)}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">TradingView <ExternalLink className="h-3 w-3" /></a>
            </div>
          </div>
        </div>
        {price != null && (
          <div className="text-right">
            <div className="text-5xl font-semibold tracking-[-0.045em] leading-none num">{formatUsd(price)}</div>
            {dayPct != null && <Pill tone={dayPct >= 0 ? 'profit' : 'loss'} className="mt-2 num">{dayPct >= 0 ? '▲' : '▼'} {formatPct(dayPct)} {t('common.today')}</Pill>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <PriceChart sym={sym} marks={marks} avgPrice={p ? p.avgPrice : null} earningsDate={nextEarnings?.earnings_date ?? null} />

        <Panel className="lg:col-span-4" glow={p ? (profit >= 0 ? 'profit' : 'loss') : undefined} title={t('stock.position.title')}>
          {!p ? <EmptyNote>{t('stock.position.notHeld')}</EmptyNote> : (
            <>
              <div className="flex items-center gap-4">
                <svg viewBox="0 0 120 120" className="h-24 w-24 shrink-0" role="img" aria-label={t('stock.position.shareAria', { pct: fmtPercent(p.allocation, 1) })}>
                  <circle cx="60" cy="60" r="48" fill="none" stroke="hsl(0 0% 100% / 0.07)" strokeWidth="12" />
                  <circle cx="60" cy="60" r="48" fill="none" stroke="hsl(var(--primary))" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(p.allocation / 100) * 301.6} 301.6`} transform="rotate(-90 60 60)" />
                  <text x="60" y="60" textAnchor="middle" className="fill-foreground" fontSize="17" fontWeight="600" fontFamily="Geist Mono">{fmtPercent(p.allocation, 0)}</text>
                  <text x="60" y="76" textAnchor="middle" className="fill-muted-foreground" fontSize="10">{t('stock.position.ofPortfolio')}</text>
                </svg>
                <div className="min-w-0">
                  <Label>{t('stock.position.unrealized')}</Label>
                  <div className={cn('text-[26px] font-semibold tracking-[-0.04em] num', profit >= 0 ? 'text-profit' : 'text-loss')}>{profit >= 0 ? '+' : ''}{formatAt(p.profitUsd, p.profitCzk)}</div>
                  <Pill tone={profit >= 0 ? 'profit' : 'loss'}>{formatPct(pick(p.profitPct, p.profitPctCzk))}</Pill>
                </div>
              </div>
              <div className="mt-4 divide-y divide-white/[0.06] text-[13px]">
                {[
                  [t('stock.position.value'), format(p.value)],
                  [t('stock.position.shares'), hidden ? '••••' : fmtNum(p.shares, 4)],
                  [t('stock.position.avgPrice'), formatUsd(p.avgPrice)],
                  [t('stock.position.cost'), formatAt(p.invested, p.investedCzk)],
                  [t('stock.position.today'), `${p.dailyChangeUsd >= 0 ? '+' : ''}${format(p.dailyChangeUsd)}`],
                ].map(([k, v]) => <div key={k} className="flex justify-between py-2.5"><span className="text-muted-foreground">{k}</span><span className="num">{v}</span></div>)}
              </div>
            </>
          )}
        </Panel>

        <Panel className="lg:col-span-3">
          <Label>{t('stock.range52.title')}</Label>
          {lo && hi ? (
            <>
              <div className="mt-2.5 flex justify-between text-[13px] num"><span>{formatUsd(lo.close)}</span><span>{formatUsd(hi.close)}</span></div>
              <div className="relative mt-2 h-2 rounded-full opacity-85" style={{ background: 'linear-gradient(90deg, hsl(var(--loss)), hsl(var(--warning)), hsl(var(--profit)))' }}>
                {rangePos != null && <div className="absolute -top-1.5 h-5 w-5 -translate-x-1/2 rounded-full border-4 border-background bg-foreground" style={{ left: `${rangePos}%` }} />}
              </div>
              <div className="mt-3 text-xs text-muted-foreground">{price && hi.close > 0 ? t('stock.range52.belowHigh', { pct: fmtPercent(((hi.close - price) / hi.close) * 100, 1), date: fmtDate(hi.date) }) : ''}</div>
            </>
          ) : <div className="mt-2 text-sm text-muted-foreground">{t('stock.range52.none')}</div>}
        </Panel>
        {!isCrypto && (
        <Panel className="lg:col-span-3">
          <Label>{t('stock.earnings.title')}</Label>
          {nextEarnings ? (
            <div className="mt-2.5 flex items-center gap-3">
              <div className="w-12 rounded-2xl bg-primary/15 py-1.5 text-center"><div className="text-lg font-semibold num">{Number(nextEarnings.earnings_date.slice(8, 10))}</div><div className="text-[10px] uppercase text-primary">{monthShort(nextEarnings.earnings_date)}</div></div>
              <div><div className="font-semibold">{relDays(t, daysBetween(today, nextEarnings.earnings_date))}</div>
                <div className="text-xs text-muted-foreground">{earningsWhen(t, nextEarnings.time_of_day) ?? t('stock.earnings.noTime')}{nextEarnings.eps_estimate != null ? ` · ${t('stock.earnings.eps', { eps: `$${fmtNum(nextEarnings.eps_estimate, 2)}` })}` : ''}</div></div>
            </div>
          ) : <div className="mt-2 text-sm text-muted-foreground">{t('stock.earnings.unknown')}</div>}
        </Panel>
        )}
        {rule && hold && holdKeys ? (
        // Tax-free after the holding period (CZ, DE crypto, SK securities) or, in the US, only
        // the long-term rate — never called tax-free there.
        <Panel className="lg:col-span-3">
          <Label>{rule.effect === 'exempt' && rule.years === 1 ? t('stock.tax.titleOneYear') : t(`${holdKeys}.title`)}</Label>
          <div className="mt-2 text-2xl font-semibold tracking-[-0.03em] num">{hold.heldShares > 0 ? fmtPercent(hold.qualifiedPct, 0) : '—'} <span className="text-xs font-medium text-muted-foreground">{t(`${holdKeys}.exempt`)}</span></div>
          <div className="mt-2.5 h-2 rounded-full bg-white/[0.06]">{hold.qualifiedPct > 0 && <div className={cn('h-2 rounded-full', rule.effect === 'exempt' ? 'bg-profit' : 'bg-primary')} style={{ width: `${hold.qualifiedPct}%` }} />}</div>
          <div className="mt-2.5 text-xs text-muted-foreground">{hold.next ? t(`${holdKeys}.next`, { date: fmtDate(hold.next) }) : hold.heldShares > 0 ? t(`${holdKeys}.all`) : ''}</div>
          {rule.effect === 'long-term' && <div className="mt-1 text-xs text-muted-foreground">{t('stock.tax.longTerm.note')}</div>}
        </Panel>
        ) : (
        // No holding-period rule in the user's jurisdiction for this kind: just how long it is held.
        <Panel className="lg:col-span-3">
          <Label>{t('residence.stock.title')}</Label>
          <div className="mt-2 text-2xl font-semibold tracking-[-0.03em] num">{oldestLot ? t('residence.stock.since', { date: fmtDate(oldestLot) }) : '—'}</div>
          <div className="mt-2.5 text-xs text-muted-foreground">{lots.length > 0 ? t('residence.stock.lots', { count: lots.length }) : ''}</div>
        </Panel>
        )}
        {isCrypto ? (
        <Panel className="lg:col-span-6">
          <Label>{t('stock.crypto.title')}</Label>
          <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('stock.crypto.text')}</div>
        </Panel>
        ) : (
        <Panel className="lg:col-span-3">
          <Label>{t('stock.dividend.title')}</Label>
          <div className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-profit num">{annualDiv > 0 ? `≈ ${format(annualDiv)}` : '—'} <span className="text-xs font-medium text-muted-foreground">{t('common.perYear')}</span></div>
          <div className="mt-3 text-xs text-muted-foreground">{annualDiv > 0 && p ? t('stock.dividend.yields', { onCost: fmtPercent((annualDiv / p.invested) * 100, 2), today: fmtPercent((annualDiv / p.value) * 100, 2) }) : t('stock.dividend.none')}</div>
        </Panel>
        )}

        {!isCrypto && <CompanyFinancials symbol={sym} />}
        {!isCrypto && <FairValueForSymbol symbol={sym} price={price} />}

        <Panel className="lg:col-span-12" title={t('stock.trades.title')} action={
          <Segmented<'all' | 'BUY' | 'SELL'> value={tradeFilter} onChange={setTradeFilter} options={[{ value: 'all', label: t('stock.trades.all', { count: trades.length }) }, { value: 'BUY', label: t('stock.trades.buys') }, { value: 'SELL', label: t('stock.trades.sells') }] as const} />
        }>
          {shownTrades.length === 0 ? <EmptyNote>{t('stock.trades.none')}</EmptyNote> : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {shownTrades.slice(0, 12).map((tx) => (
                <div key={tx.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.035] px-3.5 py-3">
                  <div className="flex items-center justify-between"><Pill tone={tx.side === 'BUY' ? 'profit' : 'loss'}>{tx.side === 'BUY' ? t('stock.trades.buy') : t('stock.trades.sell')}</Pill><span className="text-xs text-muted-foreground num">{fmtDate(pragueDate(tx.executed_at))}</span></div>
                  <div className="mt-2 text-[13px] num">{t('stock.trades.qty', { shares: hidden ? '••••' : fmtNum(Number(tx.shares), 4), price: formatUsd(Number(tx.price_usd)) })}</div>
                  <div className="text-xs text-muted-foreground">{tx.broker ? String(tx.broker) : t('stock.trades.manual')}</div>
                </div>
              ))}
            </div>
          )}
          {shownTrades.length > 12 && <div className="mt-3 text-center text-xs text-muted-foreground">{t('stock.trades.more', { count: shownTrades.length - 12 })}</div>}
        </Panel>

        {news && news.items.length > 0 && (
          <Panel className="lg:col-span-12" title={<span className="flex items-center gap-2"><Newspaper className="h-4 w-4 text-primary" /> {t('stock.news.title')}</span>} action={<span className="text-xs text-muted-foreground">{relTime(t, Math.floor(new Date(news.fetchedAt).getTime() / 1000))}</span>}>
            <div className="grid gap-2.5 md:grid-cols-2">
              {news.items.map((n, i) => {
                const open = openNews === i;
                return (
                  <div key={i} className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03]">
                    <button type="button" onClick={() => setOpenNews(open ? null : i)} aria-expanded={open} className="flex w-full items-start gap-2 p-3 text-left hover:bg-white/[0.04]">
                      <div className="min-w-0 flex-1"><p className={cn('text-sm font-medium leading-snug', open && 'text-primary')}>{currentLang() === 'en' ? n.en : n.cs}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{n.publisher}{n.ts ? ` · ${relTime(t, n.ts)}` : ''}</p></div>
                      <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
                    </button>
                    {open && (
                      <div className="px-3 pb-3">
                        <p className="text-[13px] leading-relaxed text-muted-foreground">{(currentLang() === 'en' ? n.sumEn : n.sumCs) || t('stock.news.noSummary')}</p>
                        {n.url && <a href={n.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary">{t('stock.news.open')} <ExternalLink className="h-3 w-3" /></a>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        )}
      </div>
      <Footnote>{t('stock.footnote')}</Footnote>
    </div>
  );
};

export default StockDetail;
