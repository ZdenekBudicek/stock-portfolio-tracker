import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, type Time, ColorType, CrosshairMode } from 'lightweight-charts';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { computeTradeFlows, useComputedPortfolio, useDailySnapshots, useTransactions } from '@/hooks/usePortfolio';
import { useBenchmark } from '@/hooks/useExtras';
import { formatPct } from '@/data/portfolio';

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

interface Point { date: string; total: number; cumDep: number; benchVal: number | null; }
interface WindowStats { delta: number; pct: number; benchPct: number | null; isFull: boolean; }

const PerformanceChart = () => {
  const [range, setRange] = useState<RangeKey>('YTD');
  const [showBench, setShowBench] = useState(true);
  const { format, convert, currency, hidden } = useCurrency();
  const { data: snapshots = [] } = useDailySnapshots();
  const portfolio = useComputedPortfolio();
  const { data: bench = [] } = useBenchmark('SPX');
  const { data: transactions = [] } = useTransactions();

  const cashUsd = portfolio.positions.find((p) => p.ticker === 'CASH')?.value ?? 0;
  const holdingsUsd = portfolio.totalValue - cashUsd;

  const sorted = useMemo(() => {
    const data = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const today = new Date().toISOString().slice(0, 10);
    // Live point = today's holdings from the same `positions` table the stored snapshots are
    // reconstructed against, so the curve joins the live value without a step.
    if (Number.isFinite(holdingsUsd) && holdingsUsd > 0) {
      const last = data[data.length - 1];
      const livePoint = {
        ...(last ?? { value_czk: 0, profit_usd: 0, profit_pct: 0, profit_czk: 0 }),
        snapshot_date: today,
        value_usd: holdingsUsd,
        cash_usd: cashUsd, // today's balance is known exactly — no estimate needed
      };
      if (!last || last.snapshot_date < today) data.push(livePoint);
      else if (last.snapshot_date === today) data[data.length - 1] = livePoint;
    }
    return data;
  }, [snapshots, holdingsUsd, cashUsd]);

  // Sorted benchmark dates for nearest-match lookups (handles weekends/holidays)
  const benchSorted = useMemo(() => [...bench].sort((a, b) => a.date.localeCompare(b.date)), [bench]);
  const findBenchAt = (date: string): number | null => {
    if (benchSorted.length === 0) return null;
    let lo = 0, hi = benchSorted.length - 1, best: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (benchSorted[mid].date <= date) { best = benchSorted[mid].close_value; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  };

  // Cash per day, as RECORDED by the daily snapshot (daily_snapshots.cash_usd). The past
  // balance was never stored and reconstructing it was measured and rejected — with deposits
  // missing from the records it claimed $10 928 of cash in June 2021, when the whole
  // portfolio was worth $5 348. So days before tracking started carry no cash and show the
  // positions only; from the first recorded day the curve is the whole portfolio, and selling
  // a big position no longer looks like a crash because the proceeds stay visible as cash.
  const cashByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sorted) {
      const c = (s as any).cash_usd;
      if (c != null && Number.isFinite(Number(c))) m.set(s.snapshot_date, Number(c));
    }
    return m;
  }, [sorted]);

  // Money that entered the plotted series, by day. Where cash is part of the curve a purchase
  // is an INTERNAL move (cash → positions) and must not count as money in; what counts is the
  // change in cash plus what was spent on stock, which is exactly the external cash-in.
  // Derived from the cash series itself, so the baseline stays consistent with the curve on
  // both sides of the day tracking began.
  const tradeFlows = useMemo(() => computeTradeFlows(transactions as any), [transactions]);

  // Cumulative money in + the dollar-matched S&P (the same money, on the same days, in the
  // index instead) over the FULL series.
  const { cumDepByDate, benchValByDate } = useMemo(() => {
    const cumDepByDate = new Map<string, number>();
    const benchValByDate = new Map<string, number | null>();
    let cum = 0, units = 0, prevCash = 0;
    for (const s of sorted) {
      const cash = cashByDate.get(s.snapshot_date) ?? 0;
      const flow = (cash - prevCash) + (tradeFlows.get(s.snapshot_date) ?? 0);
      prevCash = cash;
      if (flow !== 0) {
        cum += flow;
        const spxAt = findBenchAt(s.snapshot_date);
        if (spxAt) units += flow / spxAt;
      }
      cumDepByDate.set(s.snapshot_date, cum);
      const spx = findBenchAt(s.snapshot_date);
      // Sells can push the matched position negative (more taken out than put in). A
      // negative "what the index would be worth" is meaningless — draw nothing instead.
      benchValByDate.set(s.snapshot_date, spx && units > 0 ? units * spx : null);
    }
    return { cumDepByDate, benchValByDate };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, cashByDate, tradeFlows, benchSorted]);

  // Full point series in USD (converted at render/tooltip time): positions + cash.
  const points: Point[] = useMemo(() => sorted.map((d) => ({
    date: d.snapshot_date,
    total: d.value_usd + (cashByDate.get(d.snapshot_date) ?? 0),
    cumDep: cumDepByDate.get(d.snapshot_date) ?? 0,
    benchVal: benchValByDate.get(d.snapshot_date) ?? null,
  })), [sorted, cashByDate, cumDepByDate, benchValByDate]);

  /* ── chart engine ─────────────────────────────────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<'Area'> | null>(null);
  const benchRef = useRef<ISeriesApi<'Area'> | null>(null);
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
  const rebasing = useRef(false);

  useEffect(() => { pointsRef.current = points; }, [points]);
  useEffect(() => { rangeRef.current = range; }, [range]);
  useEffect(() => { pctModeRef.current = pctMode; }, [pctMode]);

  /**
   * Return of `p` measured from `base`, net of money paid in between them — the same formula
   * as the headline stat, so the curve and the number always agree.
   */
  const returnPct = (p: Point, base: Point, useBench = false) => {
    const now = useBench ? p.benchVal : p.total;
    const then = useBench ? base.benchVal : base.total;
    if (now == null || then == null) return null;
    const depIn = p.cumDep - base.cumDep;
    const den = then + depIn;
    if (!(den > 0)) return null;
    return (((now - then) - depIn) / den) * 100;
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
      localization: { locale: 'cs-CZ' },
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

    // Header stats follow the VISIBLE window — zooming/panning re-bases the return like a
    // pro terminal. Custom pan/zoom clears the preset-range highlight.
    chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      const pts = pointsRef.current;
      if (!lr || pts.length < 2) return;
      const i0 = Math.min(pts.length - 1, Math.max(0, Math.round(lr.from)));
      const i1 = Math.min(pts.length - 1, Math.max(0, Math.round(lr.to)));
      if (i1 <= i0) return;
      const a = pts[i0], b = pts[i1];
      const depIn = b.cumDep - a.cumDep;
      const base = a.total + depIn;
      const delta = (b.total - a.total) - depIn;
      const benchBase = a.benchVal != null ? a.benchVal + depIn : 0;
      const benchPct = a.benchVal != null && b.benchVal != null && benchBase > 0
        ? (((b.benchVal - a.benchVal) - depIn) / benchBase) * 100 : null;
      const isFull = i0 === 0 && i1 === pts.length - 1;
      setStats({ delta, pct: base > 0 ? (delta / base) * 100 : 0, benchPct, isFull });
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
    });

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
    const money = (v: number) => (currency === 'USD' ? v : convert(v));
    main.setData(pts.map((p) => ({
      time: p.date as Time,
      value: asPct ? (returnPct(p, base) ?? 0) : money(p.total),
    })));
    benchS.setData(pts
      .filter((p) => p.benchVal != null && (!asPct || returnPct(p, base, true) != null))
      .map((p) => ({
        time: p.date as Time,
        value: asPct ? returnPct(p, base, true)! : money(p.benchVal!),
      })));
    chart.applyOptions({
      localization: {
        locale: 'cs-CZ',
        priceFormatter: (v: number) => asPct
          ? `${v >= 0 ? '+' : ''}${v.toFixed(0)} %`
          : hidden ? '••••' : (currency === 'CZK' ? `${(v / 1_000_000).toFixed(1)}M` : `$${(v / 1000).toFixed(0)}k`),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, currency, convert, hidden, pctMode]);

  useEffect(() => { benchRef.current?.applyOptions({ visible: showBench }); }, [showBench]);

  const applyRange = (r: typeof timeRanges[number]) => {
    setRange(r);
    rangeRef.current = r;
    setWindow(r);
  };

  // "VŠE" (full window) shows the same deposit-based figures as the header so the two
  // prominent totals are identical; any other window shows the re-based window return.
  const useAll = stats.isFull && portfolio.netDepositsUsd != null;
  const delta = useAll ? portfolio.totalProfit : stats.delta;
  const deltaPct = useAll ? portfolio.totalReturnPct : stats.pct;
  const positive = delta >= 0;
  const hasBench = points.some((p) => p.benchVal != null);

  const fmtMoney = (v: number) => hidden ? (currency === 'USD' ? '$••••' : '•••• Kč') : currency === 'USD'
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `${v.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč`;

  return (
    <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6 animate-fade-in-up hover-lift">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
        <div>
          <h2 className="font-display font-bold text-lg sm:text-xl text-foreground">Vývoj portfolia</h2>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-sm font-semibold ${positive ? 'text-profit' : 'text-loss'}`}>
              {positive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {positive ? '+' : ''}{format(delta)} ({formatPct(deltaPct)})
            </span>
            {hasBench && showBench && stats.benchPct != null && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-info/10 border-info/30 text-info">
                S&P 500 {stats.benchPct >= 0 ? '+' : ''}{stats.benchPct.toFixed(2)}%
              </span>
            )}
            {!stats.isFull && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">výběr období</span>
            )}
          </div>
          {/* Spelling out the split keeps the curve reconcilable with the big number in the
              page header instead of quietly differing by the cash balance. */}
          <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            Pozice {fmtMoney(currency === 'USD' ? holdingsUsd : convert(holdingsUsd))}
            {cashUsd > 0.5 && <> · hotovost {fmtMoney(currency === 'USD' ? cashUsd : convert(cashUsd))}</>}
            {' '}· celkem <span className="text-foreground font-semibold">{fmtMoney(currency === 'USD' ? portfolio.totalValue : convert(portfolio.totalValue))}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md border border-border overflow-hidden">
            {([['money', currency === 'USD' ? '$' : 'Kč'], ['pct', '%']] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setPctMode(m === 'pct')}
                title={m === 'pct'
                  ? 'Zobrazit zhodnocení v procentech od začátku vybraného období'
                  : 'Zobrazit hodnotu portfolia v penězích'}
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
          <div className="flex gap-1 p-1 rounded-xl bg-background/60 border border-border">
            {timeRanges.map((r) => (
              <button
                key={r}
                onClick={() => applyRange(r)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  range === r
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative h-[340px] min-w-0">
        {points.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Načítám data…</div>
        ) : (
          <>
            <div ref={containerRef} className="absolute inset-0" />
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
                  {new Date(tip.date).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs text-muted-foreground">Portfolio</span>
                  <span className="text-right">
                    <span className="font-display font-bold text-sm tabular-nums text-foreground">{fmtMoney(currency === 'USD' ? tip.val : convert(tip.val))}</span>
                    {(pctMode ? tip.wpct : tip.pct) != null && (
                      <span className={`ml-1.5 text-[10px] font-semibold tabular-nums ${(pctMode ? tip.wpct! : tip.pct!) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {(pctMode ? tip.wpct! : tip.pct!) >= 0 ? '+' : ''}{(pctMode ? tip.wpct! : tip.pct!).toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>
                {showBench && tip.bval != null && (
                  <div className="flex items-center justify-between gap-4 mt-1 pt-1 border-t border-border/40">
                    <span className="text-xs text-muted-foreground">S&P 500</span>
                    <span className="text-right">
                      <span className="font-display font-bold text-sm tabular-nums text-foreground">{fmtMoney(currency === 'USD' ? tip.bval : convert(tip.bval))}</span>
                      {(pctMode ? tip.wbpct : tip.bpct) != null && (
                        <span className={`ml-1.5 text-[10px] font-semibold tabular-nums ${(pctMode ? tip.wbpct! : tip.bpct!) >= 0 ? 'text-profit' : 'text-loss'}`}>
                          {(pctMode ? tip.wbpct! : tip.bpct!) >= 0 ? '+' : ''}{(pctMode ? tip.wbpct! : tip.bpct!).toFixed(1)}%
                        </span>
                      )}
                    </span>
                  </div>
                )}
                <p className="mt-1 text-[9px] text-muted-foreground">
                  {pctMode ? 'od začátku zvoleného období' : 'zhodnocení vůči vloženému'}
                </p>
              </div>
            )}
          </>
        )}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Křivka = celá hodnota portfolia (pozice + hotovost), takže prodej pozice ji neshodí — peníze
        zůstanou vidět v hotovosti. Hotovost se zaznamenává od 4. 8. 2026; starší dny ji nemají uloženou
        a ukazují jen pozice. Přepínačem <span className="font-semibold">%</span> uvidíš zhodnocení od začátku
        zvoleného období; S&amp;P 500 je stejná částka ve stejné dny v indexu. Kolečkem / pinchem přiblížíš,
        tažením posouváš. Návratnost nahoře se přepočítává podle viditelného výseku.
        {' '}Graf: <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">TradingView Lightweight Charts</a>.
      </p>
    </div>
  );
};

export default PerformanceChart;
