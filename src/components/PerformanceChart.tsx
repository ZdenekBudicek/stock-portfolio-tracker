import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, AreaSeries, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type Time, ColorType, CrosshairMode } from 'lightweight-charts';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { usePerformanceSeries } from '@/hooks/usePerformanceSeries';
import { formatPct } from '@/data/portfolio';
import { useTranslation } from 'react-i18next';
import { currentLang, currentLocale } from '@/i18n';
import { fmtPercent } from '@/i18n/format';
import { compactMoney, formatMoney, symbolOf, wrapSymbol } from '@/lib/displayCurrency';
import { type SeriesPoint } from '@/lib/performanceSeries';

const timeRanges = ['1M', '3M', '6M', 'YTD', '1R', '5R', 'VŠE'] as const;
type RangeKey = typeof timeRanges[number] | '';

// Tailwind theme vars are HSL fragments ("142 76% 36%") — turn them into concrete colors,
// since the canvas renderer can't resolve CSS variables.
const themeColor = (name: string, alpha?: number) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(', ');
  return alpha != null ? `hsla(${v}, ${alpha})` : `hsl(${v})`;
};
const toDateStr = (t: Time): string => {
  if (typeof t === 'string') return t;
  const b = t as { year: number; month: number; day: number };
  return `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
};

type Point = SeriesPoint;

/**
 * Time-weighted growth index per point: each day's change net of that day's money in, chained.
 * The same method as the Výnosy screen, so the % curve and its headline match the TWR there
 * (a deposit after a gain no longer dilutes the percentage).
 */
const twrIndex = (pts: Point[], bench: boolean): WeakMap<Point, number> => {
  const m = new WeakMap<Point, number>();
  let idx = 1;
  let prev: Point | null = null;
  for (const p of pts) {
    const v = bench ? p.benchVal : p.total;
    if (v == null) { prev = null; continue; }
    const pv = prev ? (bench ? prev.benchVal : prev.total) : null;
    if (prev && pv != null && pv > 0) {
      const r = (v - (p.cumDep - prev.cumDep)) / pv;
      if (Number.isFinite(r) && r > 0) idx *= r;
    }
    m.set(p, idx);
    prev = p;
  }
  return m;
};
interface WindowStats { delta: number; pct: number; benchPct: number | null; isFull: boolean; }

/** `embedded`: drawn inside another card (the Přehled hero) — no own frame, title or footnote. */
const PerformanceChart = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const { t } = useTranslation();
  const [range, setRange] = useState<RangeKey>('YTD');
  const [showBench, setShowBench] = useState(true);
  const { formatAt, pick, convert, currency, hidden } = useCurrency();
  const lang = currentLang() === 'en' ? 'en' : 'cs';
  const portfolio = useComputedPortfolio();
  // Same series as the Výnosy screen (hooks/usePerformanceSeries).
  const { points, holdingsUsd, cashUsd } = usePerformanceSeries(currency);

  /* ── chart engine ─────────────────────────────────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<'Area'> | null>(null);
  const benchRef = useRef<ISeriesApi<'Area'> | null>(null);
  const investedRef = useRef<ISeriesApi<'Line'> | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const positiveRef = useRef(true);
  const programmaticMove = useRef(false);
  const rangeRef = useRef<RangeKey>('YTD');
  const [stats, setStats] = useState<WindowStats>({ delta: 0, pct: 0, benchPct: null, isFull: true });
  const [tip, setTip] = useState<{
    x: number; date: string; val: number;
    pct: number | null; bval: number | null; bpct: number | null;
    wpct: number | null; wbpct: number | null;
  } | null>(null);

  // "%" mode plots the return instead of the amount, re-based to the FIRST DAY OF THE VISIBLE
  // WINDOW — so switching period actually changes what the line shows, and its last point is
  // the same number as the headline above it.
  const [pctMode, setPctMode] = useState(false);
  const pctModeRef = useRef(false);
  const baseIdxRef = useRef(0);
  const redrawRef = useRef<() => void>(() => {});
  const rangeChangedRef = useRef<() => void>(() => {});
  const rebasing = useRef(false);

  const twrRef = useRef<{ main: WeakMap<Point, number>; bench: WeakMap<Point, number> }>({ main: new WeakMap(), bench: new WeakMap() });
  useEffect(() => { pointsRef.current = points; twrRef.current = { main: twrIndex(points, false), bench: twrIndex(points, true) }; }, [points]);
  useEffect(() => { rangeRef.current = range; }, [range]);
  useEffect(() => { pctModeRef.current = pctMode; }, [pctMode]);

  /**
   * Return of `p` measured from `base`, net of money paid in between them — the same formula
   * as the headline stat, so the curve and the number always agree.
   */
  const returnPct = (p: Point, base: Point, useBench = false) => {
    const m = useBench ? twrRef.current.bench : twrRef.current.main;
    const now = m.get(p), then = m.get(base);
    if (now == null || then == null || !(then > 0)) return null;
    return (now / then - 1) * 100;
  };

  // Set the visible window for a preset range. Kept as a helper so the data effect can
  // RE-apply the active preset whenever the series (re)loads — on first paint only the live
  // point exists and the full history arrives a moment later; a one-shot fit at that moment
  // froze the view on a 1–2 day window.
  const setWindow = (r: RangeKey) => {
    const chart = chartRef.current;
    const pts = pointsRef.current;
    if (!chart || !r || pts.length === 0) return;
    programmaticMove.current = true;
    if (r === 'VŠE') chart.timeScale().fitContent();
    else {
      const from = r === 'YTD'
        ? `${new Date().getFullYear()}-01-01`
        : new Date(Date.now() - (r === '1M' ? 30 : r === '3M' ? 91 : r === '6M' ? 182 : r === '1R' ? 365 : 1825) * 86400000).toISOString().slice(0, 10);
      const first = pts[0].date;
      chart.timeScale().setVisibleRange({ from: (from > first ? from : first) as Time, to: pts[pts.length - 1].date as Time });
    }
    setTimeout(() => { programmaticMove.current = false; }, 50);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: themeColor('--muted-foreground'),
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: themeColor('--border', 0.35) },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: themeColor('--muted-foreground', 0.4), labelBackgroundColor: themeColor('--primary') },
        horzLine: { color: themeColor('--muted-foreground', 0.4), labelBackgroundColor: themeColor('--primary') },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, rightOffset: 2, minBarSpacing: 0.2 },
      localization: { locale: currentLocale() },
      handleScroll: true,
      handleScale: true,
    });
    const profit = themeColor('--profit');
    const main = chart.addSeries(AreaSeries, {
      lineColor: profit, lineWidth: 3,
      topColor: themeColor('--profit', 0.35), bottomColor: themeColor('--profit', 0.02),
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerRadius: 5,
    });
    const benchS = chart.addSeries(AreaSeries, {
      lineColor: themeColor('--info'), lineWidth: 2,
      topColor: themeColor('--info', 0.12), bottomColor: themeColor('--info', 0),
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerRadius: 4,
    });

    // Money put in so far (dashed): the gap between it and the curve is the profit.
    const investedS = chart.addSeries(LineSeries, {
      color: themeColor('--muted-foreground', 0.8), lineWidth: 1, lineStyle: LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    investedRef.current = investedS;

    // Header stats follow the VISIBLE window — zooming/panning re-bases the return like a
    // pro terminal. Custom pan/zoom clears the preset-range highlight.
    const onRange = (lr: { from: number; to: number } | null) => {
      const pts = pointsRef.current;
      if (!lr || pts.length < 2) return;
      const i0 = Math.min(pts.length - 1, Math.max(0, Math.round(lr.from)));
      const i1 = Math.min(pts.length - 1, Math.max(0, Math.round(lr.to)));
      if (i1 <= i0) return;
      const a = pts[i0], b = pts[i1];
      const depIn = b.cumDep - a.cumDep;
      const base = a.total + depIn;
      const delta = (b.total - a.total) - depIn;
      const benchPct = returnPct(b, a, true);
      const isFull = i0 === 0 && i1 === pts.length - 1;
      setStats({ delta, pct: returnPct(b, a) ?? (base > 0 ? (delta / base) * 100 : 0), benchPct, isFull });
      // In "%" mode the curve is measured from the first day on screen, so moving the window
      // means every plotted value changes. setData keeps the logical range, so this settles
      // in one pass; the flag is there so it can never feed itself.
      if (i0 !== baseIdxRef.current) {
        baseIdxRef.current = i0;
        if (pctModeRef.current && !rebasing.current) {
          rebasing.current = true;
          redrawRef.current();
          setTimeout(() => { rebasing.current = false; }, 0);
        }
      }
      if (!programmaticMove.current && !isFull) setRange('');
      if (!programmaticMove.current && isFull) setRange('VŠE');
      // Recolor by the visible window's direction.
      const pos = delta >= 0;
      if (pos !== positiveRef.current) {
        positiveRef.current = pos;
        const c = pos ? '--profit' : '--loss';
        main.applyOptions({ lineColor: themeColor(c), topColor: themeColor(c, 0.35), bottomColor: themeColor(c, 0.02) });
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    // The window stats are amounts in the displayed currency: recompute them when the series
    // is replaced (currency switch, refresh) even if the visible range did not move.
    rangeChangedRef.current = () => onRange(chart.timeScale().getVisibleLogicalRange());

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) { setTip(null); return; }
      const date = toDateStr(param.time);
      const p = pointsRef.current.find((x) => x.date === date);
      if (!p) { setTip(null); return; }
      // Both percentages are measured against the SAME number — the money put in by that
      // date — so the two lines in the tooltip are directly comparable.
      const pct = p.cumDep > 0 ? ((p.total - p.cumDep) / p.cumDep) * 100 : 0;
      const bpct = p.benchVal != null && p.cumDep > 0 ? ((p.benchVal - p.cumDep) / p.cumDep) * 100 : null;
      const base = pointsRef.current[Math.min(pointsRef.current.length - 1, Math.max(0, baseIdxRef.current))];
      setTip({
        x: param.point.x, date, val: p.total,
        pct: p.cumDep > 0 ? pct : null, bval: p.benchVal, bpct,
        wpct: base ? returnPct(p, base) : null,
        wbpct: base ? returnPct(p, base, true) : null,
      });
    });

    chartRef.current = chart;
    mainRef.current = main;
    benchRef.current = benchS;
    return () => { chart.remove(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push data + formatting into the chart. Kept as a function (not just an effect) because
  // "%" mode has to redraw when the visible window moves — the return is measured from the
  // first day on screen, so panning to a different period changes every plotted value.
  const pushData = () => {
    const chart = chartRef.current, main = mainRef.current, benchS = benchRef.current;
    const pts = pointsRef.current;
    if (!chart || !main || !benchS || pts.length === 0) return;
    const asPct = pctModeRef.current;
    const base = pts[Math.min(pts.length - 1, Math.max(0, baseIdxRef.current))];
    main.setData(pts.map((p) => ({
      time: p.date as Time,
      value: asPct ? (returnPct(p, base) ?? 0) : p.total,
    })));
    investedRef.current?.setData(asPct ? [] : pts.filter((p) => p.cumDep > 0).map((p) => ({ time: p.date as Time, value: p.cumDep })));
    benchS.setData(pts
      .filter((p) => p.benchVal != null && (!asPct || returnPct(p, base, true) != null))
      .map((p) => ({
        time: p.date as Time,
        value: asPct ? returnPct(p, base, true)! : p.benchVal!,
      })));
    chart.applyOptions({
      localization: {
        locale: currentLocale(),
        priceFormatter: (v: number) => asPct
          ? fmtPercent(v, 0, true)
          : hidden ? '••••' : (currency === 'CZK' ? `${(v / 1_000_000).toFixed(2)}M` : currency === 'USD' ? `$${(v / 1000).toFixed(0)}k` : compactMoney(v, currency, lang)),
      },
    });
  };
  useEffect(() => { redrawRef.current = pushData; });

  useEffect(() => {
    if (points.length === 0) return;
    pushData();
    // Re-apply the active preset window after every data (re)load. A custom zoom/pan
    // (range === '') is left untouched so the user's view survives price refreshes.
    if (rangeRef.current) setWindow(rangeRef.current);
    rangeChangedRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, hidden, pctMode]);

  useEffect(() => { benchRef.current?.applyOptions({ visible: showBench }); }, [showBench]);

  const applyRange = (r: typeof timeRanges[number]) => {
    setRange(r);
    rangeRef.current = r;
    setWindow(r);
  };

  // "VŠE" (full window) shows the same deposit-based figures as the header so the two
  // prominent totals are identical; any other window shows the re-based window return.
  // Both are in the displayed currency.
  const useAll = stats.isFull && portfolio.netDepositsUsd != null;
  const delta = useAll ? pick(portfolio.totalProfit, portfolio.totalProfitCzk) : stats.delta;
  // The % is always time-weighted (as on Výnosy); the amount above stays profit vs. money in.
  const deltaPct = stats.pct;
  const positive = delta >= 0;
  const hasBench = points.some((p) => p.benchVal != null);

  const fmtMoney = (v: number) => hidden ? wrapSymbol('••••', currency, lang) : currency === 'USD'
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : formatMoney(v, currency, lang, { decimals: 0 });
  const rangeLabel = (k: typeof timeRanges[number]) => (k === '1R' ? t('perf.range.1y') : k === '5R' ? t('perf.range.5y') : k === 'VŠE' ? t('perf.range.all') : k);

  return (
    <div className={embedded ? '' : 'surface-card rounded-3xl border p-5 sm:p-6 animate-fade-in-up'}>
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
        <div>
          {!embedded && <h2 className="font-display font-semibold text-[15px] text-foreground">{t('perf.title')}</h2>}
          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-sm font-semibold ${positive ? 'text-profit' : 'text-loss'}`}>
              {positive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {positive ? '+' : ''}{formatAt(delta, delta)} ({formatPct(deltaPct)})
            </span>
            {hasBench && showBench && stats.benchPct != null && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-info/10 border-info/30 text-info">
                S&P 500 {fmtPercent(stats.benchPct, 2, true)}
              </span>
            )}
            {!stats.isFull && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('perf.selection')}</span>
            )}
          </div>
          {/* Spelling out the split keeps the curve reconcilable with the big number in the
              page header instead of quietly differing by the cash balance. */}
          {!embedded && <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            {t('perf.positions')} {fmtMoney(currency === 'USD' ? holdingsUsd : convert(holdingsUsd))}
            {cashUsd > 0.5 && <> · {t('perf.cash')} {fmtMoney(currency === 'USD' ? cashUsd : convert(cashUsd))}</>}
            {' '}· {t('perf.total')} <span className="text-foreground font-semibold">{fmtMoney(currency === 'USD' ? portfolio.totalValue : convert(portfolio.totalValue))}</span>
          </p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md border border-border overflow-hidden">
            {([['money', symbolOf(currency, lang)], ['pct', '%']] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setPctMode(m === 'pct')}
                title={m === 'pct'
                  ? t('perf.showPct')
                  : t('perf.showMoney')}
                className={`px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  (m === 'pct') === pctMode
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {hasBench && (
            <button
              onClick={() => setShowBench(!showBench)}
              className={`px-2.5 py-1 text-[11px] font-bold rounded-md border transition-colors ${
                showBench ? 'bg-info/10 border-info/40 text-info' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              S&P 500
            </button>
          )}
          <div className="flex max-w-full gap-1 overflow-x-auto p-1 rounded-full bg-white/[0.04] border border-white/10">
            {timeRanges.map((r) => (
              <button
                key={r}
                onClick={() => applyRange(r)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  range === r
                    ? 'bg-foreground text-background font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {rangeLabel(r)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={`relative ${embedded ? 'h-[260px]' : 'h-[340px]'} min-w-0`}>
        {/* The chart container is always mounted — the chart is created once, on mount. */}
        <div ref={containerRef} className="absolute inset-0" />
        {points.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : (
          <>
            {tip && (
              // Pinned to the side the cursor is NOT on. Following the cursor meant the box
              // sat on top of the very point being read, so you could not see where on the
              // curve you were.
              <div
                className={`pointer-events-none absolute top-2 z-10 glass-strong border border-border rounded-xl px-3.5 py-2.5 shadow-2xl min-w-[200px] ${
                  tip.x < (containerRef.current?.clientWidth ?? 600) / 2 ? 'right-2' : 'left-2'
                }`}
              >
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                  {new Date(tip.date).toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs text-muted-foreground">Portfolio</span>
                  <span className="text-right">
                    <span className="font-display font-bold text-sm tabular-nums text-foreground">{fmtMoney(tip.val)}</span>
                    {(pctMode ? tip.wpct : tip.pct) != null && (
                      <span className={`ml-1.5 text-[10px] font-semibold tabular-nums ${(pctMode ? tip.wpct! : tip.pct!) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {fmtPercent(pctMode ? tip.wpct! : tip.pct!, 1, true)}
                      </span>
                    )}
                  </span>
                </div>
                {showBench && tip.bval != null && (
                  <div className="flex items-center justify-between gap-4 mt-1 pt-1 border-t border-border/40">
                    <span className="text-xs text-muted-foreground">S&P 500</span>
                    <span className="text-right">
                      <span className="font-display font-bold text-sm tabular-nums text-foreground">{fmtMoney(tip.bval)}</span>
                      {(pctMode ? tip.wbpct : tip.bpct) != null && (
                        <span className={`ml-1.5 text-[10px] font-semibold tabular-nums ${(pctMode ? tip.wbpct! : tip.bpct!) >= 0 ? 'text-profit' : 'text-loss'}`}>
                          {fmtPercent(pctMode ? tip.wbpct! : tip.bpct!, 1, true)}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                <p className="mt-1 text-[9px] text-muted-foreground">
                  {pctMode ? t('perf.tipPct') : t('perf.tipMoney')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
      {embedded ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          <span className="inline-block w-4 border-t border-dashed border-muted-foreground align-middle mr-1.5" />{t('perf.legendEmbedded')}
        </p>
      ) : (
      <p className="mt-2 text-[10px] text-muted-foreground">
        {t('perf.footnote')}
        {' '}{t('perf.chartBy')} <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">TradingView Lightweight Charts</a>.
      </p>
      )}
    </div>
  );
};

export default PerformanceChart;
