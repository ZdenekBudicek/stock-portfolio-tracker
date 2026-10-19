// Dividendy — docs/design/V2-Dividendy.dc.html
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { useDividendModel } from '@/hooks/useInsights';
import DividendTracker from '@/components/DividendTracker';
import { TickerLogo } from '@/components/TickerLogo';
import { holdingsOf, monthShort, RING_COLORS } from '@/components/v2/widgets';
import { ChartTip, EmptyNote, Footnote, Kpi, Label, PageTitle, Panel, Pill } from '@/components/v2/ui';
import { daysBetween } from '@/lib/czTax';
import { cn } from '@/lib/utils';
import { useJurisdiction } from '@/hooks/useTaxResidence';
import { fmtPercent, fmtDay, fmtMonthYear } from '@/i18n/format';

const Dividends = () => {
  const { t } = useTranslation();
  // The assumed 15 % US withholding is the treaty rate for Czech residents.
  const { code: residence } = useJurisdiction();
  const d = useDividendModel();
  // Month under the pointer (or tapped): it lights up and shows what pays that month.
  const [hot, setHot] = useState<number | null>(null);
  const { format, formatAt, currency, convert } = useCurrency();
  const { positions } = useComputedPortfolio();
  const hold = new Map(holdingsOf(positions).map((p) => [p.ticker.split('.')[0], p]));
  const max = Math.max(1e-9, ...d.forecast.map((m) => m.amountUsd));
  // In the local currency (koruny or the chosen one) the cost is what the shares cost in it on
  // the purchase days (not today's rate), so the local yield on cost also reflects the currency
  // move since buying. Dividends themselves are converted at today's rate (usdLocal).
  const czk = currency !== 'USD';
  const yoc = [...d.annual.entries()]
    .map(([ticker, annual]) => {
      const p = hold.get(ticker);
      return p ? {
        ticker, p,
        annual: czk ? convert(annual) : annual,
        cost: czk ? Number((p as any).investedCzk) : p.invested,
        value: czk ? Number((p as any).valueCzk) : p.value,
      } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.cost > 0 && x.value > 0)
    .sort((a, b) => b.annual - a.annual);
  const money = (v: number) => formatAt(v, v); // v is already in the shown currency
  const yocMax = Math.max(1e-9, ...yoc.map((x) => (x.annual / x.cost) * 100));
  const upcoming = [...d.rest, ...d.forecast.flatMap((m) => m.items)].slice(0, 6);
  const pct = (v: number) => fmtPercent(v, 2);
  const ex = yoc[0];

  return (
    <div>
      <PageTitle eyebrow={t('dividends.eyebrow')} title={t('nav.dividends')} />
      <Panel className="!p-6 sm:!p-7">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <Label className="text-profit/80">{t('dividends.next12')}</Label>
            <div className="mt-2 flex items-end gap-3 flex-wrap">
              <div className="text-5xl sm:text-[60px] font-semibold tracking-[-0.045em] leading-none text-profit num">≈ {format(d.annualTotal)}</div>
              <div className="text-xs text-muted-foreground mb-2">{t('dividends.net')}</div>
            </div>
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded" style={{ background: 'linear-gradient(180deg, hsl(var(--profit)), hsl(153 70% 40%))' }} />{t('common.declared')}</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-profit/40" style={{ background: 'repeating-linear-gradient(135deg, hsl(var(--profit) / 0.38) 0 4px, hsl(var(--profit) / 0.14) 4px 8px)' }} />{t('dividends.legendEstimate')}</span>
          </div>
        </div>
        {/* Twelve labelled bars do not fit a phone: scroll sideways there instead of squeezing. */}
        <div className="-mx-2 overflow-x-auto px-2"><div className="min-w-[600px]">
        <div className="relative mt-6 flex h-56 items-end gap-2 sm:gap-3.5" onMouseLeave={() => setHot(null)}>
          {hot != null && d.forecast[hot]?.amountUsd > 0 && (() => {
            const m = d.forecast[hot];
            const items = [...m.items].sort((a, b) => b.amountUsd - a.amountUsd);
            return (
              <ChartTip at={((hot + 0.5) / d.forecast.length) * 100}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3"><b className="capitalize">{fmtMonthYear(m.month + '-01')}</b><span className="font-semibold text-profit num">{format(m.amountUsd)}</span></div>
                <div className="space-y-1">
                  {items.slice(0, 5).map((it, k) => (
                    <div key={k} className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5"><TickerLogo ticker={it.ticker} size="xs" className="!w-4 !h-4 !rounded" />{it.ticker}<span className="text-muted-foreground">{fmtDay(it.payDate, false)}</span></span>
                      <span className={cn('num', it.kind === 'declared' ? 'text-foreground' : 'text-muted-foreground')}>{format(it.amountUsd)}{it.kind !== 'declared' ? '*' : ''}</span>
                    </div>
                  ))}
                  {items.length > 5 && <div className="text-muted-foreground">+{items.length - 5}</div>}
                </div>
                {items.some((it) => it.kind !== 'declared') && <div className="mt-1.5 text-[10px] text-muted-foreground">* {t('common.estimate')}</div>}
              </ChartTip>
            );
          })()}
          {d.forecast.map((m, mi) => (
            <div key={m.month}
              className={cn('flex h-full flex-1 cursor-default flex-col items-center justify-end gap-1.5 rounded-xl transition-opacity duration-200', hot != null && hot !== mi && 'opacity-35', hot === mi && 'bg-white/[0.04]')}
              onMouseEnter={() => setHot(mi)} onClick={() => setHot((h) => (h === mi ? null : mi))}>
              {m.amountUsd > 0 && (
                <>
                  <div className="flex -space-x-1.5">{[...new Set(m.items.map((i) => i.ticker))].slice(0, 3).map((tk) => <TickerLogo key={tk} ticker={tk} size="xs" />)}</div>
                  <span className={cn('text-[11px] num', m.declared ? 'font-semibold' : 'text-muted-foreground')}>{format(m.amountUsd)}</span>
                </>
              )}
              <div
                className={cn('w-full max-w-[54px] rounded-t-xl rounded-b-[4px] origin-bottom transition-transform duration-200', hot === mi && m.amountUsd > 0 && 'scale-x-110', m.amountUsd === 0 && 'h-1 rounded-full bg-white/[0.07]')}
                style={m.amountUsd > 0 ? {
                  height: `${Math.max(6, (m.amountUsd / max) * 70)}%`,
                  background: m.declared ? 'linear-gradient(180deg, hsl(153 100% 70%), hsl(153 70% 40%))' : 'repeating-linear-gradient(135deg, hsl(var(--profit) / 0.38) 0 6px, hsl(var(--profit) / 0.16) 6px 12px)',
                  border: m.declared ? undefined : '1px solid hsl(var(--profit) / 0.4)',
                  boxShadow: m.declared ? '0 0 30px -4px hsl(var(--profit) / 0.6)' : undefined,
                } : undefined}
              />
            </div>
          ))}
        </div>
        <div className="mt-2.5 flex gap-2 sm:gap-3.5 text-center text-xs text-muted-foreground num">
          {d.forecast.map((m) => <span key={m.month} className="flex-1">{monthShort(m.month + '-01')}</span>)}
        </div>
        </div></div>
      </Panel>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel glow="profit" title={t('dividends.nextPayout')} action={d.next ? <Pill tone={d.next.kind === 'declared' ? 'profit' : 'neutral'}>{d.next.kind === 'declared' ? t('common.declared') : t('common.estimate')}</Pill> : null}>
          {d.next ? (
            <>
              <div className="flex items-center gap-3"><TickerLogo ticker={d.next.ticker} size="lg" /><div className="text-lg font-semibold">{d.next.ticker}</div></div>
              <div className="mt-4 text-[34px] font-semibold tracking-[-0.03em] text-profit num">{format(d.next.amountUsd)}</div>
              <div className="text-xs text-muted-foreground">{fmtDay(d.next.payDate)}</div>
              <div className="mt-4 rounded-2xl bg-white/[0.05] py-2.5 text-center">
                <div className="text-2xl font-semibold num">{daysBetween(d.today, d.next.payDate)}</div>
                <div className="text-xs text-muted-foreground">{t('dividends.daysToPay', { count: daysBetween(d.today, d.next.payDate) })}</div>
              </div>
            </>
          ) : <EmptyNote>{t('dividends.noPayout')}</EmptyNote>}
        </Panel>

        <Panel className="lg:col-span-2" title={t('dividends.yoc.title')} action={<span className="text-xs text-muted-foreground">{t('dividends.yoc.sub')}</span>}>
          {yoc.length === 0 ? <EmptyNote>{t('dividends.yoc.empty')}</EmptyNote> : (
            <div className="focus-list space-y-5">
              {yoc.map((x) => {
                const onCost = (x.annual / x.cost) * 100, onValue = (x.annual / x.value) * 100;
                return (
                  <div key={x.ticker} className="flex items-center gap-4">
                    <TickerLogo ticker={x.ticker} size="lg" />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between gap-2 text-[13px]"><b className="truncate">{x.p!.name || x.ticker}</b><span className="text-xs text-muted-foreground num">{t('dividends.yoc.line', { annual: money(x.annual), cost: money(x.cost) })}</span></div>
                      <div className="mt-2 flex items-center gap-2.5"><span className="w-16 text-xs text-muted-foreground">{t('dividends.yoc.onCost')}</span>
                        <div className="h-3 flex-1 rounded-full bg-white/[0.05]"><div className="h-3 rounded-full" style={{ width: `${(onCost / yocMax) * 100}%`, background: 'linear-gradient(90deg, hsl(var(--profit) / 0.35), hsl(var(--profit)))' }} /></div>
                        <span className="w-14 text-right text-sm font-semibold text-profit num">{pct(onCost)}</span></div>
                      <div className="mt-1.5 flex items-center gap-2.5"><span className="w-16 text-xs text-muted-foreground">{t('dividends.yoc.today')}</span>
                        <div className="h-3 flex-1 rounded-full bg-white/[0.05]"><div className="h-3 rounded-full bg-white/20" style={{ width: `${(onValue / yocMax) * 100}%` }} /></div>
                        <span className="w-14 text-right text-sm num">{pct(onValue)}</span></div>
                    </div>
                  </div>
                );
              })}
              <div className="rounded-2xl border border-primary/20 bg-primary/[0.06] p-3.5 text-xs leading-relaxed text-muted-foreground">
                <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-foreground"><Info className="h-3.5 w-3.5 text-primary" /> {t('dividends.yoc.howTitle')}</div>
                {t('dividends.yoc.how')}
                {ex && <div className="mt-1.5 text-foreground/85">{t('dividends.yoc.example', { ticker: ex.ticker, cost: money(ex.cost), annual: money(ex.annual), onCost: pct((ex.annual / ex.cost) * 100), value: money(ex.value), onValue: pct((ex.annual / ex.value) * 100) })}</div>}
              </div>
            </div>
          )}
        </Panel>

        <Panel className="lg:col-span-2" title={t('dividends.received.title')} action={<span className="text-sm font-semibold text-profit num">{format(d.received.total)}</span>}>
          {d.received.byTicker.length === 0 ? <EmptyNote>{t('dividends.received.empty')}</EmptyNote> : (
            <>
              <div className="flex h-4 gap-0.5 overflow-hidden rounded-full">
                {d.received.byTicker.map((r, i) => <i key={r.ticker} style={{ width: `${(r.amountUsd / d.received.total) * 100}%`, background: RING_COLORS[i % RING_COLORS.length] }} />)}
              </div>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {d.received.byTicker.map((r) => (
                  <div key={r.ticker} className={cn('flex items-center gap-2.5 rounded-2xl bg-white/[0.035] p-3', !hold.has(r.ticker) && 'opacity-70')}>
                    <TickerLogo ticker={r.ticker} size="sm" />
                    <div><div className="text-sm font-semibold num">{format(r.amountUsd)}</div><div className="text-xs text-muted-foreground">{r.ticker}{!hold.has(r.ticker) ? ` · ${t('dividends.received.sold')}` : ''}</div></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel title={t('dividends.calendar.title')}>
          {upcoming.length === 0 ? <EmptyNote>{t('dividends.calendar.empty')}</EmptyNote> : (
            <div className="focus-list space-y-3">
              {upcoming.map((u) => (
                <div key={`${u.ticker}-${u.payDate}`} className="flex items-center gap-3">
                  <div className={cn('w-12 shrink-0 rounded-xl py-1 text-center', u.kind === 'declared' ? 'bg-profit/15' : 'bg-white/[0.05]')}>
                    <div className="text-sm font-semibold num">{Number(u.payDate.slice(8, 10))}</div>
                    <div className={cn('text-[10px] uppercase', u.kind === 'declared' ? 'text-profit' : 'text-muted-foreground')}>{monthShort(u.payDate)}</div>
                  </div>
                  <TickerLogo ticker={u.ticker} size="sm" />
                  <span className="flex-1 text-[13px]">{u.ticker} <span className="text-xs text-muted-foreground">{u.kind === 'estimate' ? t('common.estimate') : ''}</span></span>
                  <span className={cn('text-sm num', u.kind === 'declared' && 'text-profit')}>{format(u.amountUsd)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4"><DividendTracker /></div>
      <Footnote>{residence === 'CZ' ? t('dividends.footnote') : t('residence.dividendsFootnote')}</Footnote>
    </div>
  );
};

export default Dividends;
