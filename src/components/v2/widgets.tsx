// Cards shared by several V2 screens. Each takes its data from the shared hooks so the same
// figure is identical wherever it appears.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, ArrowDown, ArrowUp, Bell, CheckCircle2, Info } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio, type LivePosition } from '@/hooks/usePortfolio';
import { useEarnings } from '@/hooks/useExtras';
import { useDividendModel, todayPrague } from '@/hooks/useInsights';
import { TickerLogo } from '@/components/TickerLogo';
import { normalizeEarningsTime, type AlertItem } from '@/lib/alerts';
import { daysBetween } from '@/lib/czTax';
import { fmtCzk, fmtDay, fmtMonthShort, fmtNum, fmtPercent } from '@/i18n/format';
import { currentLang } from '@/i18n';
import { EmptyNote, Panel, Pill } from './ui';
import { cn } from '@/lib/utils';

export const RING_COLORS = ['hsl(247 100% 74%)', 'hsl(216 100% 72%)', 'hsl(194 85% 62%)', 'hsl(166 72% 56%)', 'hsl(137 82% 71%)', 'hsl(82 87% 69%)', 'hsl(40 100% 67%)', 'hsl(320 75% 68%)', 'hsl(25 95% 64%)'];

/** Kept names for the screens: all follow the UI language. */
export const monthShort = (iso: string) => fmtMonthShort(iso);
export const fmtDayMonth = (iso: string) => fmtDay(iso, false);
export const fmtDate = (iso: string) => fmtDay(iso, true);

export const holdingsOf = (positions: LivePosition[]) => positions.filter((p) => p.ticker !== 'CASH' && p.type !== 'Cash');

/** "dnes / zítra / za N dní" in the UI language. */
export const relDays = (t: TFunction, days: number) => (days === 0 ? t('common.today') : days === 1 ? t('common.tomorrow') : t('common.inDays', { count: days }));

export const earningsWhen = (t: TFunction, time: string | null | undefined) => {
  const n = normalizeEarningsTime(time ?? null);
  return n ? t(`common.earnings.${n}`) : null;
};

/** Money each position added to / took from today's change, biggest first. */
export function MoversCard({ limit = 5 }: { limit?: number }) {
  const { t } = useTranslation();
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();
  const rows = holdingsOf(positions).filter((p) => p.dailyChangeUsd !== 0)
    .sort((a, b) => Math.abs(b.dailyChangeUsd) - Math.abs(a.dailyChangeUsd)).slice(0, limit);
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.dailyChangeUsd)));
  return (
    <Panel title={t('widgets.movers.title')} action={<span className="text-xs text-muted-foreground">{t('common.today')}</span>}>
      {rows.length === 0 ? <EmptyNote>{t('widgets.movers.empty')}</EmptyNote> : (
        <div className="focus-list space-y-2.5">
          {rows.map((r) => {
            const up = r.dailyChangeUsd > 0;
            const c = up ? 'var(--profit)' : 'var(--loss)';
            return (
              <Link key={r.ticker} to={`/stock/${r.ticker}`} className="flex items-center gap-2.5 group/link">
                <TickerLogo ticker={r.ticker} size="xs" />
                <span className="w-12 text-xs font-semibold num">{r.ticker}</span>
                <div className="flex-1 h-5 rounded-md bg-white/[0.04]">
                  <div className="h-5 rounded-md" style={{ width: `${(Math.abs(r.dailyChangeUsd) / max) * 100}%`, background: `linear-gradient(90deg, hsl(${c} / 0.25), hsl(${c}))` }} />
                </div>
                <span className={cn('w-24 text-right text-xs num', up ? 'text-profit' : 'text-loss')}>{up ? '+' : ''}{format(r.dailyChangeUsd)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/**
 * Composition of the invested part (cash excluded, named as such). Hovering (or tapping) a
 * slice or a legend row lights up both and shows that position in the middle of the ring.
 */
export function AllocationCard() {
  const { t } = useTranslation();
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();
  const [active, setActive] = useState<number | null>(null);
  const hold = holdingsOf(positions).sort((a, b) => b.value - a.value);
  const total = hold.reduce((s, p) => s + p.value, 0);
  const top = hold.slice(0, 7);
  const rest = hold.slice(7);
  const slices: { label: string; value: number; ticker: string | null; dayPct: number | null }[] = [
    ...top.map((p) => ({ label: p.ticker, value: p.value, ticker: p.ticker, dayPct: p.dailyChangePct })),
    ...(rest.length ? [{ label: t('widgets.allocation.other', { count: rest.length }), value: rest.reduce((s, p) => s + p.value, 0), ticker: null, dayPct: null }] : []),
  ];
  const C = 2 * Math.PI * 70;
  let offset = 0;
  const shown = active != null ? slices[active] : null;
  const toggle = (i: number) => setActive((cur) => (cur === i ? null : i));
  return (
    <Panel title={t('widgets.allocation.title')} action={<span className="text-xs text-muted-foreground">{t('widgets.allocation.sub', { count: hold.length })}</span>}>
      {total <= 0 ? <EmptyNote>{t('widgets.allocation.empty')}</EmptyNote> : (
        <div className="flex flex-wrap items-center justify-center gap-5" onMouseLeave={() => setActive(null)}>
          <svg viewBox="0 0 180 180" className="h-36 w-36 shrink-0 overflow-visible" role="img" aria-label={t('widgets.allocation.aria')}>
            <g transform="rotate(-90 90 90)" fill="none" strokeLinecap="round">
              <circle cx="90" cy="90" r="70" stroke="hsl(0 0% 100% / 0.05)" strokeWidth="18" />
              {slices.map((s, i) => {
                const len = (s.value / total) * C;
                const on = active === i, dim = active != null && !on;
                const el = (
                  <circle
                    key={s.label} cx="90" cy="90" r="70"
                    stroke={RING_COLORS[i % RING_COLORS.length]}
                    strokeWidth={on ? 26 : 18}
                    strokeDasharray={`${Math.max(0, len - 4)} ${C}`} strokeDashoffset={-offset - 2}
                    className="cursor-pointer transition-[stroke-width,opacity,filter] duration-200"
                    style={{ opacity: dim ? 0.25 : 1, filter: on ? `drop-shadow(0 0 8px ${RING_COLORS[i % RING_COLORS.length]})` : undefined }}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => toggle(i)}
                  />
                );
                offset += len;
                return el;
              })}
            </g>
            {shown ? (
              <>
                <text x="90" y="76" textAnchor="middle" className="fill-muted-foreground" fontSize="11">{shown.label}</text>
                <text x="90" y="99" textAnchor="middle" className="fill-foreground" fontSize="20" fontWeight="600" fontFamily="Geist Mono">{fmtPercent((shown.value / total) * 100, 1)}</text>
                <text x="90" y="117" textAnchor="middle" className="fill-muted-foreground" fontSize="10.5" fontFamily="Geist Mono">{format(shown.value)}</text>
              </>
            ) : (
              <>
                <text x="90" y="84" textAnchor="middle" className="fill-muted-foreground" fontSize="11">{t('widgets.allocation.largest')}</text>
                <text x="90" y="104" textAnchor="middle" className="fill-foreground" fontSize="16" fontWeight="600" fontFamily="Geist Mono">
                  {slices[0].label} {fmtPercent((slices[0].value / total) * 100, 0)}
                </text>
              </>
            )}
          </svg>
          <div className="min-w-[180px] flex-1 space-y-0.5 text-xs">
            {slices.map((s, i) => {
              const on = active === i, dim = active != null && !on;
              const row = (
                <>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={cn('h-2 w-2 rounded-full shrink-0 transition-transform', on && 'scale-150')} style={{ background: RING_COLORS[i % RING_COLORS.length] }} />
                    {s.ticker && <TickerLogo ticker={s.ticker} size="xs" className="!w-4 !h-4 !rounded" />}
                    <span className={cn('truncate', on && 'font-semibold')}>{s.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                    {on && s.dayPct != null && <span className={cn('num text-[11px]', s.dayPct >= 0 ? 'text-profit' : 'text-loss')}>{fmtPercent(s.dayPct, 1, true)}</span>}
                    <span className="num">{fmtPercent((s.value / total) * 100, 1)}</span>
                  </span>
                </>
              );
              const cls = cn('flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 transition-[background-color,opacity] duration-200', on && 'bg-white/[0.07]', dim && 'opacity-40');
              return s.ticker
                ? <Link key={s.label} to={`/stock/${s.ticker}`} className={cls} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)}>{row}</Link>
                : <div key={s.label} className={cls} onMouseEnter={() => setActive(i)}>{row}</div>;
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Next earnings of held stocks and the next dividend payout. */
export function UpcomingCard({ limit = 4 }: { limit?: number }) {
  const { t } = useTranslation();
  const { positions } = useComputedPortfolio();
  const { data: earnings = [] } = useEarnings();
  const div = useDividendModel();
  const { format } = useCurrency();
  const today = todayPrague();
  const held = new Map(holdingsOf(positions).map((p) => [p.ticker, p]));
  const events = earnings.filter((e) => e.earnings_date >= today && held.has(e.ticker)).slice(0, limit);
  return (
    <Panel title={t('widgets.upcoming.title')} action={<span className="text-xs text-muted-foreground">{t('widgets.upcoming.sub')}</span>}>
      <div className="focus-list space-y-2.5">
        {events.map((e, i) => {
          const when = earningsWhen(t, e.time_of_day);
          return (
            <Link key={e.id} to={`/stock/${e.ticker}`} className="flex items-center gap-3 group/link">
              <div className={cn('w-11 shrink-0 rounded-xl py-1 text-center', i === 0 ? 'bg-primary/15' : 'bg-white/[0.05]')}>
                <div className="text-[15px] font-semibold num">{Number(e.earnings_date.slice(8, 10))}</div>
                <div className={cn('text-[10px] uppercase', i === 0 ? 'text-primary' : 'text-muted-foreground')}>{monthShort(e.earnings_date)}</div>
              </div>
              <TickerLogo ticker={e.ticker} size="xs" />
              <div className="min-w-0 text-[13px]">
                <b>{e.ticker}</b> {t('widgets.upcoming.earnings')}
                <div className="text-xs text-muted-foreground truncate">
                  {relDays(t, daysBetween(today, e.earnings_date))}{when ? ` · ${when}` : ''} · {t('widgets.upcoming.ofPortfolio', { pct: fmtPercent(held.get(e.ticker)!.allocation, 1) })}
                </div>
              </div>
            </Link>
          );
        })}
        {div.next && (
          <Link to="/dividendy" className="flex items-center gap-3">
            <div className="w-11 shrink-0 rounded-xl bg-profit/15 py-1 text-center">
              <div className="text-[15px] font-semibold num">{Number(div.next.payDate.slice(8, 10))}</div>
              <div className="text-[10px] uppercase text-profit">{monthShort(div.next.payDate)}</div>
            </div>
            <TickerLogo ticker={div.next.ticker} size="xs" />
            <div className="text-[13px]"><b>{t('widgets.upcoming.dividend')}</b> {div.next.ticker}
              <div className="text-xs text-muted-foreground">{format(div.next.amountUsd)} · {div.next.kind === 'estimate' ? t('common.estimate') : t('common.declared')}</div>
            </div>
          </Link>
        )}
        {events.length === 0 && !div.next && <EmptyNote>{t('widgets.upcoming.empty')}</EmptyNote>}
      </div>
    </Panel>
  );
}

const ALERT_STYLE: Record<AlertItem['tone'], { box: string; icon: JSX.Element }> = {
  loss: { box: 'border-loss/25 bg-loss/[0.07]', icon: <ArrowDown className="h-4 w-4 text-loss" /> },
  profit: { box: 'border-profit/25 bg-profit/[0.07]', icon: <CheckCircle2 className="h-4 w-4 text-profit" /> },
  warning: { box: 'border-warning/25 bg-warning/[0.07]', icon: <AlertTriangle className="h-4 w-4 text-warning" /> },
  info: { box: 'border-primary/25 bg-primary/[0.07]', icon: <Info className="h-4 w-4 text-primary" /> },
};

/**
 * Title and detail of an alert in the UI language. lib/alerts returns a code and raw numbers;
 * all wording and formatting happens here (amounts masked in privacy mode).
 */
export function useAlertText() {
  const { t } = useTranslation();
  const { hidden } = useCurrency();
  const usd = (v: unknown) => (hidden ? '$••••' : `$${fmtNum(Math.abs(Number(v) || 0), 0)}`);
  const czk = (v: unknown) => (hidden ? (currentLang() === 'en' ? 'CZK ••••' : '•••• Kč') : fmtCzk(Number(v) || 0));
  return (a: AlertItem): { title: string; detail: string } => {
    const p = a.params as Record<string, string | number>;
    switch (a.code) {
      case 'data.pricesError': return { title: t('alerts.msg.pricesError.title'), detail: t('alerts.msg.pricesError.detail') };
      case 'data.pricesStale': return { title: t('alerts.msg.pricesStale.title'), detail: t('alerts.msg.pricesStale.detail') };
      case 'tax.limitOver': return {
        title: t('alerts.msg.taxLimit.title', { year: p.year }),
        detail: t('alerts.msg.taxLimit.detail', { proceeds: czk(p.proceedsCzk), tax: czk(p.estTaxCzk) }) + (p.complete ? '' : ` ${t('alerts.msg.taxLimit.incomplete')}`),
      };
      case 'move.down':
      case 'move.up': return {
        title: t(a.code === 'move.down' ? 'alerts.msg.moveDown.title' : 'alerts.msg.moveUp.title', { ticker: a.ticker, pct: fmtPercent(Math.abs(Number(p.pct)), 2) }),
        detail: t(a.code === 'move.down' ? 'alerts.msg.moveDown.detail' : 'alerts.msg.moveUp.detail', { amount: usd(p.amountUsd), weight: fmtPercent(Number(p.allocation), 1) }),
      };
      case 'watch.belowTarget': return {
        title: t('alerts.msg.watch.title', { ticker: a.ticker }),
        detail: t('alerts.msg.watch.detail', { price: `$${fmtNum(Number(p.price), 2, 2)}`, target: `$${fmtNum(Number(p.target), 2)}`, below: fmtPercent(Number(p.belowPct), 0) }),
      };
      case 'earnings.soon': {
        const when = p.time ? t(`common.earnings.${p.time}`) : t('alerts.msg.earnings.noTime');
        return { title: t('alerts.msg.earnings.title', { ticker: a.ticker, date: fmtDay(String(p.date), false) }), detail: when.charAt(0).toUpperCase() + when.slice(1) };
      }
      case 'exempt.lots': return {
        title: t('alerts.msg.exempt.title', { ticker: a.ticker, count: Number(p.count) }),
        detail: p.valueUsd != null
          ? t('alerts.msg.exempt.detailValue', { value: usd(p.valueUsd), date: fmtDay(String(p.from), false) })
          : t('alerts.msg.exempt.detail', { date: fmtDay(String(p.from), false) }),
      };
      default: return { title: a.code, detail: '' };
    }
  };
}

export function AlertRow({ a, large }: { a: AlertItem; large?: boolean }) {
  const text = useAlertText()(a);
  const s = ALERT_STYLE[a.tone];
  const icon = a.ticker
    ? <TickerLogo ticker={a.ticker} size={large ? 'lg' : 'sm'} />
    : <span className={cn('flex shrink-0 items-center justify-center rounded-xl bg-white/[0.06]', large ? 'h-12 w-12' : 'h-8 w-8')}>{a.kind === 'move' ? (a.tone === 'loss' ? <ArrowDown className="h-4 w-4 text-loss" /> : <ArrowUp className="h-4 w-4 text-profit" />) : s.icon}</span>;
  const body = (
    <>
      {icon}
      <div className="min-w-0">
        <div className={cn('font-semibold', large ? 'text-sm' : 'text-[13px]')}>{text.title}</div>
        <div className="text-xs text-muted-foreground truncate">{text.detail}</div>
      </div>
    </>
  );
  const cls = cn('flex items-center gap-3 rounded-2xl border', large ? 'p-3.5' : 'p-2.5', s.box);
  return a.href ? <Link to={a.href} className={cn(cls, 'hover:brightness-125 transition')}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function AttentionCard({ alerts, limit = 3 }: { alerts: AlertItem[]; limit?: number }) {
  const { t } = useTranslation();
  return (
    <Panel
      title={<Link to="/upozorneni" className="hover:text-primary">{t('widgets.attention.title')} →</Link>}
      action={alerts.length > 0 ? <Pill tone="loss">{alerts.length}</Pill> : <Bell className="h-4 w-4 text-muted-foreground" />}
    >
      {alerts.length === 0 ? <EmptyNote>{t('widgets.attention.empty')}</EmptyNote> : (
        <div className="space-y-2">{alerts.slice(0, limit).map((a) => <AlertRow key={a.id} a={a} />)}</div>
      )}
    </Panel>
  );
}
