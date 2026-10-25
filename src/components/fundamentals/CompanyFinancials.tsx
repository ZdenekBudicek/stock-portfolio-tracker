// Company financials on the stock detail — a grid of compact cards (one colour each, metric
// switches inside the card, the latest value and its change on top) that open into a large view
// with value labels, a table per period and a plain-language guide. Valuation multiples come
// from daily closes against the statements (lib/valuationSeries).
//
// Data: company_fundamentals (Yahoo timeseries, refreshed nightly). Amounts stay in the
// company's reporting currency; missing values are gaps, never zeros; negative values are red.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Maximize2 } from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, Brush, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useCompanyFundamentals } from '@/hooks/useCompanyFundamentals';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { fetchCompanyData, isStalePending, useFundamentalsRequest } from '@/hooks/useFundamentalsRequests';
import { useQueryClient } from '@tanstack/react-query';
import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from '@/types/fundamentals';
import { medianOf, valuationSeries, type Multiple } from '@/lib/valuationSeries';
import { Panel, Segmented, EmptyNote, Pill } from '@/components/v2/ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TickerLogo } from '@/components/TickerLogo';
import { useIsMobile } from '@/hooks/use-mobile';
import { CHART_RANGES, growthStats, rangeFor, rangeStartIndex, usableRanges, type ChartRange } from '@/lib/financialsGrowth';
import { currentLang, currentLocale } from '@/i18n';
import { fmtDay, fmtNum, fmtPercent } from '@/i18n/format';
import { cn } from '@/lib/utils';

type Mode = 'annual' | 'quarterly';
type Fmt = 'money' | 'pct' | 'perShare' | 'shares' | 'multiple';

const COL = {
  purple: 'hsl(262 83% 68%)',
  teal: 'hsl(188 86% 48%)',
  green: 'hsl(150 70% 50%)',
  red: 'hsl(350 85% 62%)',
  yellow: 'hsl(56 78% 58%)',
  lime: 'hsl(84 62% 52%)',
  pink: 'hsl(322 80% 64%)',
  orange: 'hsl(32 95% 60%)',
  blue: 'hsl(214 95% 66%)',
  grid: 'hsl(0 0% 100% / 0.06)',
  axis: 'hsl(225 12% 62%)',
};

/** "$1.2B" / "1,2 mld. $" — compact amount in the reporting currency. */
export function compactMoney(v: number | null, currency: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const n = new Intl.NumberFormat(currentLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const sym = currency === 'USD' ? '$' : currency;
  return currentLocale() === 'en-US' ? (v < 0 ? `-${sym}${n.replace('-', '')}` : `${sym}${n}`) : `${n} ${sym}`;
}

const compactShares = (v: number) =>
  `${new Intl.NumberFormat(currentLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(v)} ${currentLang() === 'en' ? 'sh' : 'ks'}`;

function formatter(kind: Fmt, currency: string, compact = false): (v: number) => string {
  switch (kind) {
    case 'money': return (v) => compactMoney(v, currency);
    case 'pct': return (v) => fmtPercent(v * 100, compact ? 0 : 1);
    case 'shares': return compactShares;
    case 'multiple': return (v) => `${fmtNum(v, compact ? 0 : 1, compact ? 0 : 1)}×`;
    case 'perShare': return (v) => {
      const n = Math.abs(v).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const sign = v < 0 ? '-' : '';
      return currency === 'USD' ? `${sign}$${n}` : `${sign}${n} ${currency}`;
    };
  }
}

/** Margins beyond ±200 % come from near-zero revenue and would flatten the chart. */
const MARGIN_LIMIT = 2;

/** "Q3 25" in the small cards; "3Q 2025" (cs) / "Q3 2025" (en) in the enlarged chart. */
const periodLabel = (iso: string, mode: Mode, long = false) => {
  if (mode === 'annual') return iso.slice(0, 4);
  const q = Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
  if (!long) return `Q${q} ${iso.slice(2, 4)}`;
  return currentLang() === 'en' ? `Q${q} ${iso.slice(0, 4)}` : `${q}Q ${iso.slice(0, 4)}`;
};

type Row = { period: string; label: string; end: string } & Record<string, number | string | null>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const div = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : a / b);
const margin = (a: number | null, rev: number | null) => {
  const m = rev != null && rev > 0 ? div(a, rev) : null;
  return m != null && Math.abs(m) <= MARGIN_LIMIT ? m : null;
};

/** Every metric and derived figure per period, in one row each. */
function buildRows(s: FundamentalSeries, mode: Mode): Row[] {
  const v = (m: FundamentalMetric, i: number) => num(s.values[m]?.[i]);
  return s.periods.map((end, i) => {
    const rev = v('revenue', i);
    const ocf = v('operatingCashFlow', i), capex = v('capex', i);
    const fcf = v('freeCashFlow', i) ?? (ocf != null && capex != null ? ocf + capex : null);
    const shares = v('dilutedShares', i) ?? v('sharesOutstanding', i);
    const dividends = v('dividendsPaid', i) != null ? Math.abs(v('dividendsPaid', i)!) : null;
    const buybacks = v('buybacks', i) != null ? Math.abs(v('buybacks', i)!) : null;
    const cash = v('cash', i), debt = v('totalDebt', i);
    const r: Row = {
      period: periodLabel(end, mode), label: periodLabel(end, mode, true), end,
      revenue: rev, grossProfit: v('grossProfit', i), ebitda: v('ebitda', i),
      netIncome: v('netIncome', i), eps: v('dilutedEps', i), operatingIncome: v('operatingIncome', i),
      fcf, ocf, capexSpend: capex != null ? Math.abs(capex) : null,
      grossMargin: margin(v('grossProfit', i), rev), ebitdaMargin: margin(v('ebitda', i), rev),
      opMargin: margin(v('operatingIncome', i), rev), netMargin: margin(v('netIncome', i), rev), fcfMargin: margin(fcf, rev),
      dividends, buybacks,
      dividendsPs: div(dividends, shares), buybacksPs: div(buybacks, shares),
      rnd: v('rnd', i), sga: v('sga', i), cogs: v('costOfRevenue', i), rndShare: margin(v('rnd', i), rev),
      shares: v('sharesOutstanding', i) ?? shares,
      cash, debt, netCash: cash != null && debt != null ? cash - debt : null,
    };
    return r;
  });
}

/**
 * Totals of stacked series. A component the company reports in some period must be known in
 * this one too — otherwise the total is unknown (null), never a sum with the gap read as zero.
 * A component it never reports (e.g. no dividends at all) counts as zero.
 */
function withTotals(rows: Row[]): Row[] {
  const reported = (k: string) => rows.some((r) => num(r[k]) != null);
  const total = (r: Row, keys: string[]) => {
    const used = keys.filter(reported);
    if (used.length === 0 || used.some((k) => num(r[k]) == null)) return null;
    return used.reduce((a, k) => a + num(r[k])!, 0);
  };
  return rows.map((r) => ({ ...r, returnedTotal: total(r, ['dividends', 'buybacks']), returnedPsTotal: total(r, ['dividendsPs', 'buybacksPs']) }));
}

/** Latest value and its change against the period ending ~a year earlier (matched by date). */
function headline(rows: Row[], key: string) {
  let i = rows.length - 1;
  while (i >= 0 && num(rows[i][key]) == null) i--;
  if (i < 0) return null;
  const v = num(rows[i][key])!;
  const end = Date.parse(rows[i].end);
  let change: number | null = null;
  let flip: 'toPositive' | 'toNegative' | null = null;
  for (let j = i - 1; j >= 0; j--) {
    const days = (end - Date.parse(rows[j].end)) / 86_400_000;
    if (days < 320) continue;
    if (days > 410) break;
    const p = num(rows[j][key]);
    // A change across zero (or of a tiny base) is not a meaningful percentage — show none.
    if (p != null && p !== 0 && Math.sign(p) === Math.sign(v)) { const c = (v - p) / Math.abs(p); if (Math.abs(c) <= 5) change = c; }
    else if (p != null && p !== 0 && v !== 0) flip = v > 0 ? 'toPositive' : 'toNegative';
    break;
  }
  return { v, change, flip, period: rows[i].period, label: rows[i].label };
}

interface SeriesDef { key: string; label: string; color: string }
interface View {
  id: string;
  label: string;
  kind: 'bar' | 'stack' | 'group';
  series: SeriesDef[];
  fmt: Fmt;
  /** Headline: the key whose latest value sits on top (stacks: their total). */
  head?: string;
  /** A rise is bad (debt, share count, spending) — the change pill turns red instead of green. */
  upIsBad?: boolean;
  /** Neither direction is good or bad by itself (spending) — grey pill. */
  neutral?: boolean;
  explain: string;
  more: string;
  note?: string;
}
interface CardDef { id: string; title: string; views: View[] }

const tooltipStyle = {
  contentStyle: { background: 'hsl(228 24% 8% / 0.96)', border: '1px solid hsl(0 0% 100% / 0.12)', borderRadius: 12, fontSize: 12, boxShadow: '0 12px 30px -8px rgb(0 0 0 / 0.6)' },
  labelStyle: { color: 'hsl(220 33% 96%)', fontWeight: 600, marginBottom: 4 },
  itemStyle: { padding: '1px 0' },
  cursor: { fill: 'hsl(0 0% 100% / 0.05)' },
};
const labelStyle = { fontSize: 11, fontWeight: 600, stroke: 'hsl(228 24% 7%)', strokeWidth: 3, paintOrder: 'stroke' } as const;

const Grad = ({ id, color }: { id: string; color: string }) => (
  <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stopColor={color} stopOpacity={1} />
    <stop offset="100%" stopColor={color} stopOpacity={0.55} />
  </linearGradient>
);

const LegendChips = ({ series, className }: { series: SeriesDef[]; className?: string }) => (
  <div className={cn('flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] font-semibold', className)}>
    {series.map((s) => <span key={s.key} className="flex items-center gap-1.5" style={{ color: s.color }}><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>)}
  </div>
);

/** Small pill tabs inside a card — scroll sideways when they do not fit. */
const ViewTabs = ({ views, active, onChange }: { views: { id: string; label: string }[]; active: number; onChange: (i: number) => void }) =>
  views.length < 2 ? null : (
    <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
      {views.map((v, i) => (
        <button key={v.id} type="button" onClick={(e) => { e.stopPropagation(); onChange(i); }}
          className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition', i === active ? 'bg-white/[0.12] text-foreground shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.12)]' : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground')}>
          {v.label}
        </button>
      ))}
    </div>
  );

function Headline({ rows, view, currency, big }: { rows: Row[]; view: View; currency: string; big?: boolean }) {
  const { t } = useTranslation();
  const h = headline(rows, view.head ?? view.series[0].key);
  if (!h) return <div className="h-7" />;
  const f = formatter(view.fmt, currency);
  const good = h.change == null ? null : view.upIsBad ? h.change < 0 : h.change > 0;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={cn('font-semibold tracking-tight num', big ? 'text-3xl' : 'text-xl', h.v < 0 && 'text-loss')}>{f(h.v)}</span>
      {h.change != null && (
        <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-semibold num', view.neutral || h.change === 0 ? 'bg-white/10 text-foreground/80' : good ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss')}>{fmtPercent(h.change * 100, 1, true)}</span>
      )}
      {h.flip && (
        <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-semibold', view.neutral ? 'bg-white/10 text-foreground/80' : (h.flip === 'toPositive') !== !!view.upIsBad ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss')}>{t(h.flip === 'toPositive' ? 'fin.flipUp' : 'fin.flipDown')}</span>
      )}
      <span className="text-[11px] text-muted-foreground">{big ? h.label : h.period}{h.change != null ? ` · ${t('fin.vsYearAgo')}` : ''}</span>
    </div>
  );
}

function ViewChart({ rows, view, currency, big, uid }: { rows: Row[]; view: View; currency: string; big: boolean; uid: string }) {
  const tick = formatter(view.fmt, currency, true);
  const full = formatter(view.fmt, currency);
  const showLabels = big && rows.length <= 12;
  const single = view.kind === 'bar' && view.series.length === 1;
  const s0 = view.series[0];
  const gid = (k: string) => `${uid}-${k}-${big ? 'b' : 's'}`;
  return (
    <ResponsiveContainer>
      <BarChart data={rows} margin={{ top: showLabels ? 20 : 6, right: 4, left: 0, bottom: 0 }} barCategoryGap={view.kind === 'group' ? '22%' : '18%'}>
        <defs>
          {view.series.map((s) => <Grad key={s.key} id={gid(s.key)} color={s.color} />)}
          <Grad id={gid('neg')} color={COL.red} />
        </defs>
        <CartesianGrid stroke={COL.grid} vertical={false} />
        <XAxis dataKey="period" tick={{ fill: COL.axis, fontSize: big ? 12 : 10.5 }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={tick} tick={{ fill: COL.axis, fontSize: big ? 12 : 10.5 }} axisLine={false} tickLine={false} width={big ? 88 : 80} />
        <ReferenceLine y={0} stroke="hsl(0 0% 100% / 0.22)" />
        <Tooltip {...tooltipStyle} formatter={(v: unknown, name: string) => [v == null ? '—' : full(Number(v)), name]} />
        {view.series.map((s, si) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={view.kind === 'stack' ? 'a' : undefined}
            fill={`url(#${gid(s.key)})`}
            radius={view.kind === 'stack' ? (si === view.series.length - 1 ? [5, 5, 0, 0] : [0, 0, 0, 0]) : [5, 5, 5, 5]}
            maxBarSize={big ? 64 : 42}>
            {single && rows.map((r, i) => <Cell key={i} fill={(num(r[s0.key]) ?? 0) < 0 ? `url(#${gid('neg')})` : `url(#${gid(s.key)})`} />)}
            {showLabels && (view.kind !== 'stack' || si === view.series.length - 1) && (
              <LabelList dataKey={view.kind === 'stack' ? (view.head ?? s.key) : s.key} position="top"
                formatter={(v: unknown) => (v == null ? '' : tick(Number(v)))} style={{ ...labelStyle, fill: view.kind === 'stack' ? 'hsl(220 20% 88%)' : s.color }} />
            )}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function ValuesTable({ rows, view, currency, long }: { rows: Row[]; view: View; currency: string; long?: boolean }) {
  const { t } = useTranslation();
  const f = formatter(view.fmt, currency);
  const keys = [...view.series, ...(view.kind === 'stack' && view.head ? [{ key: view.head, label: t('fin.total'), color: 'hsl(220 20% 85%)' }] : [])];
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[420px] text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="sticky left-0 z-10 whitespace-nowrap bg-[hsl(228_24%_7%)] py-2 pr-3 text-left font-medium">{t('fin.table')}</th>
            {rows.map((r) => <th key={r.end} className="whitespace-nowrap px-2 py-2 text-right font-medium num">{long ? r.label : r.period}</th>)}
          </tr>
        </thead>
        <tbody>
          {keys.map((s) => (
            <tr key={s.key} className="border-t border-white/[0.06]">
              <td className="sticky left-0 z-10 bg-[hsl(228_24%_7%)] py-2 pr-3"><span className="flex items-center gap-1.5 whitespace-nowrap"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span></td>
              {rows.map((r) => {
                const v = num(r[s.key]);
                return <td key={r.end} className={cn('px-2 py-2 text-right num whitespace-nowrap', v != null && v < 0 && 'text-loss')}>{v == null ? '—' : f(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ExpandButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label}
    className="-mr-1 rounded-lg p-1.5 text-muted-foreground transition hover:bg-white/10 hover:text-foreground sm:opacity-60 sm:group-hover/card:opacity-100">
    <Maximize2 className="h-3.5 w-3.5" />
  </button>
);

const Explain = ({ what, how, note }: { what: string; how: string; note?: string }) => {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-2xl bg-white/[0.04] p-4 text-sm leading-relaxed text-muted-foreground"><div className="mb-1 font-semibold text-foreground">{t('fin.whatItIs')}</div>{what}</div>
      <div className="rounded-2xl bg-white/[0.04] p-4 text-sm leading-relaxed text-muted-foreground"><div className="mb-1 font-semibold text-foreground">{t('fin.howToRead')}</div>{how}</div>
      {note && <div className="rounded-2xl border border-warning/25 bg-warning/[0.07] p-4 text-sm leading-relaxed text-foreground/85 sm:col-span-2">{note}</div>}
    </div>
  );
};

const dialogClass = 'max-h-[92vh] max-w-5xl overflow-y-auto border-white/10 bg-[hsl(228_24%_7%/0.98)] p-5 sm:p-7';
const cardClass = 'group/card flex flex-col rounded-3xl border border-white/[0.07] bg-white/[0.025] p-4 transition-colors hover:border-white/[0.15]';

interface Company { symbol: string; name: string }

/** Hover card of the enlarged chart: period, then each series' value in its own colour. */
function ChartTip({ active, payload, view, currency }: { active?: boolean; payload?: { payload?: Row }[]; view: View; currency: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (!row) return null;
  const f = formatter(view.fmt, currency);
  return (
    <div className="min-w-[150px] rounded-xl border border-white/[0.12] bg-[hsl(228_24%_8%/0.96)] px-3.5 py-2.5 text-xs shadow-[0_12px_30px_-8px_rgb(0_0_0/0.6)]">
      <div className="mb-1.5 font-medium text-muted-foreground num">{row.label}</div>
      {view.series.map((s) => {
        const v = num(row[s.key]);
        const neg = v != null && v < 0 && view.kind === 'bar';
        return (
          <div key={s.key} className="flex items-baseline gap-2 py-0.5">
            <span className={cn('text-base font-semibold num', neg && 'text-loss')} style={neg ? undefined : { color: s.color }}>{v == null ? '—' : f(v)}</span>
            <span className="text-muted-foreground">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The range slider pays off only with a long history; a handful of bars needs none. */
const BRUSH_MIN = 16;

/** The enlarged chart: every period, a range slider under long histories, value labels when few bars show. */
function BigChart({ rows, view, currency, uid, start, end, onRange }: {
  rows: Row[]; view: View; currency: string; uid: string; start: number; end: number; onRange: (s: number, e: number) => void;
}) {
  const mobile = useIsMobile();
  const tick = formatter(view.fmt, currency, true);
  const visible = end - start + 1;
  const showLabels = !mobile && visible <= 12;
  const single = view.kind === 'bar' && view.series.length === 1;
  const s0 = view.series[0];
  const gid = (k: string) => `${uid}-${k}-x`;
  const fill = (s: SeriesDef) => `url(#${gid(s.key)})`;
  const brush = rows.length >= BRUSH_MIN;
  return (
    <ResponsiveContainer>
      <BarChart data={rows} margin={{ top: showLabels ? 22 : 8, right: 4, left: 0, bottom: 0 }} barCategoryGap={view.kind === 'group' ? '22%' : visible > 24 ? '12%' : '22%'}>
        <defs>
          {view.series.map((s) => <Grad key={s.key} id={gid(s.key)} color={s.color} />)}
          <Grad id={gid('neg')} color={COL.red} />
        </defs>
        <CartesianGrid stroke={COL.grid} strokeDasharray="3 4" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: COL.axis, fontSize: mobile ? 10.5 : 12, fontWeight: 600 }} axisLine={false} tickLine={false} minTickGap={mobile ? 8 : 16} interval="preserveStartEnd" />
        <YAxis tickFormatter={tick} tick={{ fill: COL.axis, fontSize: mobile ? 10.5 : 12, fontWeight: 600 }} axisLine={false} tickLine={false} width={mobile ? 74 : 84} />
        <ReferenceLine y={0} stroke="hsl(0 0% 100% / 0.22)" />
        <Tooltip content={<ChartTip view={view} currency={currency} />} cursor={{ fill: 'hsl(0 0% 100% / 0.05)' }} isAnimationActive={false} />
        {view.series.map((s, si) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={view.kind === 'stack' ? 'a' : undefined} fill={fill(s)}
            radius={view.kind === 'stack' ? (si === view.series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 4, 4]}
            maxBarSize={64} isAnimationActive={false}>
            {/* Cells follow the bars the brush leaves visible, not the full data. */}
            {single && rows.slice(start, end + 1).map((r, i) => <Cell key={i} fill={(num(r[s0.key]) ?? 0) < 0 ? `url(#${gid('neg')})` : fill(s)} />)}
            {showLabels && (view.kind !== 'stack' || si === view.series.length - 1) && (
              <LabelList dataKey={view.kind === 'stack' ? (view.head ?? s.key) : s.key} position="top"
                formatter={(v: unknown) => (v == null ? '' : tick(Number(v)))} style={{ ...labelStyle, fill: view.kind === 'stack' ? 'hsl(220 20% 88%)' : s.color }} />
            )}
          </Bar>
        ))}
        {brush && (
          <Brush dataKey="label" height={mobile ? 16 : 12} travellerWidth={mobile ? 12 : 8} startIndex={start} endIndex={end}
            stroke="hsl(0 0% 100% / 0.18)" fill="hsl(0 0% 100% / 0.04)" tickFormatter={() => ''}
            onChange={(r) => { if (r.startIndex != null && r.endIndex != null) onRange(r.startIndex, r.endIndex); }} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** CAGR and total growth of the newest value against 1–10 years earlier (margins: change in points). */
function GrowthCards({ rows, view, mode }: { rows: Row[]; view: View; mode: Mode }) {
  const { t } = useTranslation();
  const key = view.head ?? view.series[0].key;
  const stats = growthStats(rows.map((r) => r.end), rows.map((r) => num(r[key])));
  if (stats.length === 0) return null;
  const pct = view.fmt === 'pct';
  const tone = (x: number | null) => (x == null ? 'text-muted-foreground' : view.neutral || x === 0 ? 'text-foreground' : (view.upIsBad ? x < 0 : x > 0) ? 'text-profit' : 'text-loss');
  // Margins move in tenths of a point; a float residue must not read as "+0,0".
  const points = (x: number) => Math.round(x * 1000) / 10;
  const pp = (x: number) => `${points(x) > 0 ? '+' : ''}${fmtNum(points(x), 1, 1)} ${t('fin.chart.pp')}`;
  const pc = (x: number | null) => (x == null ? '—' : fmtPercent(x * 100, 1, true));
  const to = rows.find((r) => r.end === stats[0].to)!;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((g) => (
          <div key={g.years} className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-3">
            <div className="text-[11px] font-semibold text-foreground/90">{t(`fin.chart.horizon.${g.years}`)}</div>
            {pct ? (
              <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs"><span className="text-muted-foreground">{t('fin.chart.change')}</span><span className={cn('font-semibold num', tone(points(g.diff)))}>{pp(g.diff)}</span></div>
            ) : (
              <>
                <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs"><span className="text-muted-foreground">CAGR</span><span className={cn('font-semibold num', tone(g.cagr))}>{pc(g.cagr)}</span></div>
                <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs"><span className="text-muted-foreground">{t('fin.chart.growth')}</span><span className={cn('font-semibold num', tone(g.growth))}>{pc(g.growth)}</span></div>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {t(mode === 'annual' ? 'fin.chart.growthNoteAnnual' : 'fin.chart.growthNoteQuarter', { period: to.label })}
        {!pct && stats.some((g) => g.cagr == null) ? ` ${t('fin.chart.growthNegative')}` : ''}
      </p>
    </div>
  );
}

/** Body of the enlarged view for one period type and metric; remounted when either changes. */
function ChartPanel({ rows, view, currency, uid, mode }: { rows: Row[]; view: View; currency: string; uid: string; mode: Mode }) {
  const { t } = useTranslation();
  const ends = useMemo(() => rows.map((r) => r.end), [rows]);
  const [sel, setSel] = useState({ start: 0, end: Math.max(0, rows.length - 1) });
  const usable = useMemo(() => usableRanges(ends), [ends]);
  const active = rangeFor(ends, sel.start, sel.end);
  const has = view.series.some((s) => rows.some((r) => num(r[s.key]) != null));
  // Only presets the history can fill; a short source history leaves just a few, so say where it starts.
  const ranges = CHART_RANGES.filter((r) => usable.has(r)).map((r) => ({ value: r, label: t(`fin.chart.range.${r}`) }));
  const pick = (r: ChartRange) => setSel({ start: rangeStartIndex(ends, r), end: ends.length - 1 });
  if (!has) return <EmptyNote>{t('fin.noData')}</EmptyNote>;
  return (
    <>
      <div className="flex flex-col items-center gap-1.5">
        {ranges.length > 1 && <Segmented<ChartRange> value={active} onChange={pick} options={ranges} className="max-w-full overflow-x-auto [scrollbar-width:none]" />}
        {ranges.length < CHART_RANGES.length && rows.length > 0 && <span className="text-[11px] text-muted-foreground">{t('fin.chart.historyFrom', { period: rows[0].label })}</span>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Headline rows={rows} view={view} currency={currency} big />
        <LegendChips series={view.series} />
      </div>
      <div className="h-[46vh] min-h-[300px]">
        <BigChart rows={rows} view={view} currency={currency} uid={uid} start={sel.start} end={sel.end} onRange={(start, end) => setSel({ start, end })} />
      </div>
      {rows.length >= BRUSH_MIN && <p className="-mt-2 text-center text-[11px] text-muted-foreground">{t('fin.chart.brushHint')}</p>}
      <GrowthCards rows={rows} view={view} mode={mode} />
      <ValuesTable rows={rows.slice(sel.start, sel.end + 1)} view={view} currency={currency} long />
    </>
  );
}

function ChartDialog({ open, onOpenChange, card, rowsBy, initialMode, vi, onView, currency, company }: {
  open: boolean; onOpenChange: (o: boolean) => void; card: CardDef; rowsBy: Record<Mode, Row[]>; initialMode: Mode;
  vi: number; onView: (i: number) => void; currency: string; company: Company;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(initialMode);
  useEffect(() => { if (open) setMode(initialMode); }, [open, initialMode]);
  const view = card.views[Math.min(vi, card.views.length - 1)];
  const m = rowsBy.quarterly.length > 1 ? mode : 'annual';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(dialogClass, 'max-w-6xl gap-5')}>
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-white/[0.07] pb-4 pr-8 text-left">
          <TickerLogo ticker={company.symbol} size="md" />
          <div className="min-w-0">
            <DialogTitle className="truncate text-lg sm:text-xl">{t('fin.chart.title', { symbol: company.symbol, title: card.title })}</DialogTitle>
            <div className="truncate text-xs text-muted-foreground">{company.name !== company.symbol ? `${company.name} · ` : ''}{t('fin.chart.currency', { currency })}</div>
          </div>
          <DialogDescription className="sr-only">{view.explain}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {card.views.length > 1 ? (
            <Select value={view.id} onValueChange={(id) => onView(Math.max(0, card.views.findIndex((x) => x.id === id)))}>
              <SelectTrigger aria-label={t('fin.chart.metric')} className="h-8 w-auto min-w-[150px] gap-2 rounded-full border-white/10 bg-white/[0.04] px-3 text-xs font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {card.views.map((x) => <SelectItem key={x.id} value={x.id} className="text-xs">{x.label}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : <span className="text-sm font-medium">{view.label}</span>}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('fin.chart.period')}</span>
            {rowsBy.quarterly.length > 1
              ? <Segmented<Mode> value={m} onChange={setMode} options={[{ value: 'annual', label: t('fin.annual') }, { value: 'quarterly', label: t('fin.quarterly') }]} />
              : <span className="font-medium text-foreground">{t('fin.annual')}</span>}
          </div>
        </div>
        <ChartPanel key={`${m}-${view.id}`} rows={rowsBy[m]} view={view} currency={currency} uid={card.id} mode={m} />
        <Explain what={view.explain} how={view.more} note={view.note} />
      </DialogContent>
    </Dialog>
  );
}

const CARD_PERIODS: Record<Mode, number> = { annual: 8, quarterly: 12 };

function MetricCard({ card, rowsBy, mode, currency, company }: { card: CardDef; rowsBy: Record<Mode, Row[]>; mode: Mode; currency: string; company: Company }) {
  const { t } = useTranslation();
  const [vi, setVi] = useState(0);
  const [open, setOpen] = useState(false);
  const rows = rowsBy[mode];
  // The card shows the recent periods; the full history (SEC goes back ~19 years) is in the enlarged view.
  const recent = useMemo(() => rows.slice(-CARD_PERIODS[mode]), [rows, mode]);
  const view = card.views[Math.min(vi, card.views.length - 1)];
  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{card.title}</h3>
        <ExpandButton onClick={() => setOpen(true)} label={t('fin.expand')} />
      </div>
      <div className="mt-1.5"><ViewTabs views={card.views} active={vi} onChange={setVi} /></div>
      <div className="mt-2"><Headline rows={rows} view={view} currency={currency} /></div>
      <LegendChips series={view.series} className="mt-2" />
      <div className="mt-1 h-44 cursor-zoom-in" onClick={() => setOpen(true)}><ViewChart rows={recent} view={view} currency={currency} big={false} uid={card.id} /></div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{view.note ?? view.explain}</p>
      <ChartDialog open={open} onOpenChange={setOpen} card={card} rowsBy={rowsBy} initialMode={mode} vi={vi} onView={setVi} currency={currency} company={company} />
    </div>
  );
}

// ── Valuation (daily multiples) ─────────────────────────────────────────────

type Range = '1Y' | '3Y' | '5Y' | 'ALL';
const RANGE_DAYS: Record<Range, number> = { '1Y': 365, '3Y': 1095, '5Y': 1826, ALL: 1e6 };
const sinceIso = (r: Range) => new Date(Date.now() - RANGE_DAYS[r] * 86_400_000).toISOString().slice(0, 10);

function ValuationChart({ points, med, big, range, label, uid }: { points: { date: string; v: number | null }[]; med: number | null; big: boolean; range: Range; label: string; uid: string }) {
  const from = sinceIso(range);
  const data = points.filter((p) => p.date >= from);
  const f = formatter('multiple', 'USD');
  const gid = `${uid}-val-${big ? 'b' : 's'}`;
  return (
    <ResponsiveContainer>
      <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COL.yellow} stopOpacity={0.45} />
            <stop offset="100%" stopColor={COL.yellow} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={COL.grid} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: COL.axis, fontSize: big ? 12 : 10.5 }} axisLine={false} tickLine={false} minTickGap={big ? 60 : 40}
          tickFormatter={(d: string) => (range === '1Y' ? fmtDay(d, false) : `${d.slice(5, 7)}/${d.slice(2, 4)}`)} />
        <YAxis tickFormatter={formatter('multiple', 'USD', true)} tick={{ fill: COL.axis, fontSize: big ? 12 : 10.5 }} axisLine={false} tickLine={false} width={44} domain={[0, 'auto']} />
        <Tooltip {...tooltipStyle} labelFormatter={(d: string) => fmtDay(d, true)} formatter={(v: unknown) => [v == null ? '—' : f(Number(v)), label]} />
        {med != null && <ReferenceLine y={med} stroke="hsl(0 0% 100% / 0.45)" strokeDasharray="5 5" />}
        <Area type="monotone" dataKey="v" stroke={COL.yellow} strokeWidth={big ? 2.2 : 1.8} fill={`url(#${gid})`} connectNulls={false} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ValuationCard({ f, symbol }: { f: CompanyFundamentals; symbol: string }) {
  const { t } = useTranslation();
  const { data: closes = [] } = usePriceHistory(symbol);
  const all = useMemo(() => valuationSeries(f, closes), [f, closes]);
  const [mi, setMi] = useState(0);
  const [range, setRange] = useState<Range>('5Y');
  const [open, setOpen] = useState(false);
  const multiples: { id: Multiple; label: string }[] = [
    { id: 'pe', label: 'P/E' }, { id: 'ps', label: 'P/S' }, { id: 'pfcf', label: 'P/FCF' }, { id: 'evEbitda', label: 'EV/EBITDA' },
  ];
  const m = multiples[mi];
  const points = useMemo(() => all.map((p) => ({ date: p.date, v: p[m.id] })), [all, m.id]);
  // Today's multiple is the one on the latest close; after a swing to a loss it is unavailable,
  // never an older value shown as current.
  const lastV = points.length ? points[points.length - 1].v : null;
  const med = medianOf(all.filter((p) => p.date >= sinceIso(range)), m.id);
  const fm = formatter('multiple', 'USD');
  const usable = f.currency === 'USD' && all.length > 0;
  const head = (big?: boolean) => (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={cn('font-semibold tracking-tight num', big ? 'text-3xl' : 'text-xl')}>{lastV == null ? '—' : fm(lastV)}</span>
      {lastV != null && med != null && (
        <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-semibold', lastV > med ? 'bg-warning/15 text-warning' : 'bg-profit/15 text-profit')}>
          {t(lastV > med ? 'fin.val.aboveMedian' : 'fin.val.belowMedian')}
        </span>
      )}
      {med != null && <span className="text-[11px] text-muted-foreground">{t('fin.val.median', { value: fm(med), range: t(`fin.val.range.${range}`) })}</span>}
      {lastV == null && <span className="text-[11px] text-muted-foreground">{t('fin.val.negative')}</span>}
    </div>
  );
  const ranges = (['1Y', '3Y', '5Y', 'ALL'] as Range[]).map((r) => ({ value: r, label: t(`fin.val.rangeShort.${r}`) }));
  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('fin.val.title')}</h3>
        {usable && <ExpandButton onClick={() => setOpen(true)} label={t('fin.expand')} />}
      </div>
      {!usable ? <div className="mt-3 text-xs text-muted-foreground">{t(f.currency !== 'USD' ? 'fin.val.currency' : 'fin.val.noData')}</div> : (
        <>
          <div className="mt-1.5"><ViewTabs views={multiples} active={mi} onChange={setMi} /></div>
          <div className="mt-2">{head()}</div>
          <LegendChips series={[{ key: 'v', label: m.label, color: COL.yellow }]} className="mt-2" />
          <div className="mt-1 h-44 cursor-zoom-in" onClick={() => setOpen(true)}><ValuationChart points={points} med={med} big={false} range={range} label={m.label} uid="v" /></div>
          <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{t(`fin.val.${m.id}.explain`)}</p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className={dialogClass}>
              <DialogHeader className="pr-8 text-left">
                <DialogTitle className="text-xl">{t('fin.val.titleFull', { symbol })}</DialogTitle>
                <DialogDescription className="sr-only">{t(`fin.val.${m.id}.explain`)}</DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <ViewTabs views={multiples} active={mi} onChange={setMi} />
                <Segmented<Range> value={range} onChange={setRange} options={ranges} />
              </div>
              {head(true)}
              <div className="h-[46vh] min-h-[300px]"><ValuationChart points={points} med={med} big range={range} label={m.label} uid="v" /></div>
              <Explain what={t(`fin.val.${m.id}.explain`)} how={t(`fin.val.${m.id}.more`)} note={t('fin.val.note')} />
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────────

function useCards(rows: Row[]): CardDef[] {
  const { t } = useTranslation();
  const has = (k: string) => rows.some((r) => num(r[k]) != null);
  const negOcf = rows.filter((r) => num(r.ocf) != null && num(r.ocf)! < 0).length > rows.length / 2;
  const fintech = negOcf ? { note: t('fin.v.ocf.fintech') } : {};
  const v = (id: string, label: string, kind: View['kind'], series: SeriesDef[], fmt: Fmt, extra: Partial<View> = {}): View =>
    ({ id, label, kind, series, fmt, explain: t(`fin.v.${id}.explain`), more: t(`fin.v.${id}.more`), ...extra });
  const keep = (views: View[]) => views.filter((x) => x.series.some((s) => has(s.key)));
  const one = (key: string, label: string, color: string) => [{ key, label, color }];
  const cards: CardDef[] = [
    { id: 'rev', title: t('fin.c.revenue'), views: keep([
      v('revenue', t('fin.m.revenue'), 'bar', one('revenue', t('fin.m.revenue'), COL.purple), 'money'),
      v('grossProfit', t('fin.m.grossProfit'), 'bar', one('grossProfit', t('fin.m.grossProfit'), COL.purple), 'money'),
      v('ebitda', 'EBITDA', 'bar', one('ebitda', 'EBITDA', COL.purple), 'money'),
    ]) },
    { id: 'profit', title: t('fin.c.profit'), views: keep([
      v('netIncome', t('fin.m.netIncome'), 'bar', one('netIncome', t('fin.m.netIncome'), COL.pink), 'money'),
      v('eps', 'EPS', 'bar', one('eps', t('fin.m.eps'), COL.pink), 'perShare'),
      v('operatingIncome', t('fin.m.operatingIncome'), 'bar', one('operatingIncome', t('fin.m.operatingIncome'), COL.pink), 'money'),
    ]) },
    { id: 'cf', title: t('fin.c.cashflow'), views: keep([
      v('fcf', t('fin.m.fcf'), 'bar', one('fcf', t('fin.m.fcf'), COL.teal), 'money', fintech),
      v('ocf', t('fin.m.ocf'), 'bar', one('ocf', t('fin.m.ocf'), COL.teal), 'money', fintech),
      v('capex', t('fin.m.capex'), 'bar', one('capexSpend', t('fin.m.capex'), COL.orange), 'money', { neutral: true }),
    ]) },
    { id: 'margin', title: t('fin.c.margins'), views: keep([
      v('grossMargin', t('fin.m.gross'), 'bar', one('grossMargin', t('fin.m.grossMargin'), COL.yellow), 'pct'),
      v('ebitdaMargin', 'EBITDA', 'bar', one('ebitdaMargin', t('fin.m.ebitdaMargin'), COL.yellow), 'pct'),
      v('opMargin', t('fin.m.operating'), 'bar', one('opMargin', t('fin.m.opMargin'), COL.yellow), 'pct'),
      v('netMargin', t('fin.m.net'), 'bar', one('netMargin', t('fin.m.netMargin'), COL.yellow), 'pct'),
      v('fcfMargin', 'FCF', 'bar', one('fcfMargin', t('fin.m.fcfMargin'), COL.yellow), 'pct'),
    ]) },
    { id: 'ret', title: t('fin.c.returned'), views: keep([
      v('returned', t('fin.m.returned'), 'stack', [{ key: 'dividends', label: t('fin.m.dividends'), color: COL.green }, { key: 'buybacks', label: t('fin.m.buybacks'), color: COL.red }], 'money', { head: 'returnedTotal' }),
      v('returnedPs', t('fin.m.returnedPs'), 'stack', [{ key: 'dividendsPs', label: t('fin.m.dividends'), color: COL.green }, { key: 'buybacksPs', label: t('fin.m.buybacks'), color: COL.red }], 'perShare', { head: 'returnedPsTotal' }),
    ]) },
    // Separate views, never one total: R&D can be part of SG&A in some filings, and capex is
    // an investment, not an expense — adding them up would double count or mix concepts.
    { id: 'exp', title: t('fin.c.expenses'), views: keep([
      v('cogs', t('fin.m.cogsShort'), 'bar', one('cogs', t('fin.m.cogs'), COL.teal), 'money', { neutral: true }),
      v('rnd', 'R&D', 'bar', one('rnd', t('fin.m.rnd'), COL.orange), 'money', { neutral: true }),
      v('sga', 'SG&A', 'bar', one('sga', t('fin.m.sga'), COL.purple), 'money', { neutral: true }),
      v('rndShare', t('fin.m.rndShareShort'), 'bar', one('rndShare', t('fin.m.rndShare'), COL.orange), 'pct', { neutral: true }),
    ]) },
    { id: 'shares', title: t('fin.c.shares'), views: keep([
      v('shares', t('fin.m.shares'), 'bar', one('shares', t('fin.m.shares'), COL.lime), 'shares', { upIsBad: true }),
    ]) },
    { id: 'bal', title: t('fin.c.balance'), views: keep([
      v('cashDebt', t('fin.m.cashDebt'), 'group', [{ key: 'cash', label: t('fin.m.cash'), color: COL.green }, { key: 'debt', label: t('fin.m.debt'), color: COL.red }], 'money', { head: 'netCash' }),
      v('netCash', t('fin.m.netCash'), 'bar', one('netCash', t('fin.m.netCash'), COL.blue), 'money'),
    ]) },
  ];
  return cards.filter((c) => c.views.length > 0);
}

function Charts({ f, mode, company }: { f: CompanyFundamentals; mode: Mode; company: Company }) {
  const { t } = useTranslation();
  const rowsBy = useMemo<Record<Mode, Row[]>>(() => ({
    annual: withTotals(buildRows(f.annual, 'annual')),
    quarterly: withTotals(buildRows(f.quarterly, 'quarterly')),
  }), [f]);
  const cards = useCards(rowsBy[mode]);
  const cur = f.currency || 'USD';
  if (cards.length === 0) return <EmptyNote>{t('fin.noData')}</EmptyNote>;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.slice(0, 4).map((c) => <MetricCard key={c.id} card={c} rowsBy={rowsBy} mode={mode} currency={cur} company={company} />)}
      <ValuationCard f={f} symbol={company.symbol} />
      {cards.slice(4).map((c) => <MetricCard key={c.id} card={c} rowsBy={rowsBy} mode={mode} currency={cur} company={company} />)}
    </div>
  );
}

export default function CompanyFinancials({ symbol, name }: { symbol: string; name?: string }) {
  const { t } = useTranslation();
  const { data: f, isLoading } = useCompanyFundamentals(symbol);
  const missing = !isLoading && !f;
  const request = useFundamentalsRequest(symbol, missing);
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  // Opening a company nobody has data for fetches it right away (once per visit): SEC statements and
  // analyst consensus in seconds; a company listed abroad goes to the GitHub run (pending below).
  const asked = useRef('');
  useEffect(() => {
    if (!missing || request.isLoading || asked.current === symbol) return;
    const st = request.data;
    if (st && ((st.status === 'pending' && !isStalePending(st)) || st.status === 'failed')) return;
    asked.current = symbol;
    setLive(true);
    fetchCompanyData(symbol).then(answer => {
      const key = symbol.trim().toUpperCase();
      if (answer?.fundamentals === 'loaded') void qc.invalidateQueries({ queryKey: ['company-fundamentals', key] });
      if (answer?.analysts === 'loaded') void qc.invalidateQueries({ queryKey: ['analyst-snapshot', key] });
      return request.refetch();
    }).catch(() => {}).finally(() => setLive(false));
  }, [missing, symbol, request, qc]);
  const [mode, setMode] = useState<Mode>('annual');
  const hasQuarterly = useMemo(() => !!f && f.quarterly.periods.length > 1, [f]);
  return (
    <Panel
      className="lg:col-span-12"
      title={t('fin.title')}
      action={f ? (
        <div className="flex items-center gap-2">
          {f.status === 'error' && f.annual.periods.length + f.quarterly.periods.length > 0 && <Pill tone="warning">{t('fin.stale')}</Pill>}
          {hasQuarterly && <Segmented<Mode> value={mode} onChange={setMode} options={[{ value: 'annual', label: t('fin.annual') }, { value: 'quarterly', label: t('fin.quarterly') }]} />}
        </div>
      ) : null}
    >
      {isLoading ? <div className="h-64 animate-pulse rounded-2xl bg-white/[0.03]" /> : f && f.annual.periods.length + f.quarterly.periods.length === 0 ? (
        // Stored attempt without any statements (an ETF): say so instead of drawing empty cards.
        <EmptyNote>{t('fin.unavailable', { symbol })}</EmptyNote>
      ) : !f ? (
        live || (request.data?.status === 'pending' && !isStalePending(request.data)) ? (
          <div className="flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/[0.06] p-4 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>{t('fin.fetching', { symbol })}</span>
          </div>
        ) : request.data?.status === 'failed' ? (
          <EmptyNote>{t('fin.unavailable', { symbol })}</EmptyNote>
        ) : <EmptyNote>{t('fin.notYet', { symbol })}</EmptyNote>
      ) : (
        <>
          <p className="-mt-2 mb-4 text-xs text-muted-foreground">{t('fin.intro', { currency: f.currency || 'USD' })}</p>
          <Charts f={f} mode={hasQuarterly ? mode : 'annual'} company={{ symbol, name: name ?? symbol }} />
          <p className="mt-4 text-[11px] text-muted-foreground/70">{t('fin.source', { date: fmtDay(f.fetchedAt.slice(0, 10)) })}</p>
        </>
      )}
    </Panel>
  );
}
