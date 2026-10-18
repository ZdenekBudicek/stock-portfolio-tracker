// Neutral "Realized gains" view for users outside the supported tax jurisdictions: realized
// gains/losses and dividends per year in the base currency, with no exemptions, limit or
// tax estimate (src/lib/tax/realized.ts).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useRealizedModel } from '@/hooks/useRealized';
import { TickerLogo } from '@/components/TickerLogo';
import { fmtDate } from '@/components/v2/widgets';
import { EmptyNote, Footnote, Kpi, Label, PageTitle, Panel, Pill, Segmented } from '@/components/v2/ui';
import { currentLang } from '@/i18n';
import { fmtCzk, fmtNum } from '@/i18n/format';
import type { BaseCurrency } from '@/lib/tax/jurisdictions';
import { cn } from '@/lib/utils';

/** Formats an amount already in the base currency (respects the privacy mask). */
export function useBaseMoney(currency: BaseCurrency) {
  const { hidden } = useCurrency();
  const en = currentLang() === 'en';
  return (v: number | null | undefined, signed = false) => {
    if (v == null) return '—';
    const sign = signed && v > 0 ? '+' : '';
    if (currency === 'CZK') return hidden ? (en ? 'CZK ••••' : '•••• Kč') : `${sign}${fmtCzk(v)}`;
    if (hidden) return '$••••';
    const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return v < 0 ? `-${s}` : `${sign}${s}`;
  };
}

const tone = (v: number | null) => (v == null ? 'text-muted-foreground' : v >= 0 ? 'text-profit' : 'text-loss');

export function RealizedGainsView() {
  const { t } = useTranslation();
  const [yearSel, setYear] = useState<number | null>(null);
  const m = useRealizedModel(yearSel ?? new Date().getFullYear());
  const r = m.report;
  const money = useBaseMoney(m.currency);
  const years = m.years.slice(0, 6);
  return (
    <div>
      <PageTitle eyebrow={t('residence.realized.eyebrow')} title={t('residence.realized.title', { year: r.year })}
        right={years.length > 1 ? <Segmented<string> value={String(r.year)} onChange={(v) => setYear(Number(v))} options={years.map((y) => ({ value: String(y), label: String(y) }))} /> : undefined} />
      <div className="mb-4 rounded-2xl border border-info/25 bg-info/10 p-4 text-sm text-muted-foreground" role="note">{t('residence.realized.unsupported')}</div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel className="lg:col-span-5" glow={r.net >= 0 ? 'profit' : 'loss'}>
          <div className="flex items-center justify-between">
            <Label>{t('residence.realized.net')}</Label>
            <Pill tone={r.complete ? 'profit' : 'warning'}>{r.complete ? t('residence.realized.complete') : t('residence.realized.incomplete')}</Pill>
          </div>
          <div className={cn('mt-2.5 text-5xl font-semibold tracking-[-0.045em] leading-none num', tone(r.net))}>{money(r.net, true)}</div>
          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('residence.realized.gains')} value={money(r.gains, true)} tone="profit" size="sm" /></div>
            <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('residence.realized.losses')} value={money(r.losses)} tone={r.losses < 0 ? 'loss' : 'neutral'} size="sm" /></div>
            <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('residence.realized.proceeds')} value={money(r.proceeds)} size="sm" /></div>
            <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('residence.realized.sales')} value={r.rows.length} size="sm" /></div>
          </div>
          {r.missingFx.length > 0 && <p className="mt-3 text-xs text-warning">{t('residence.realized.missingFx', { dates: r.missingFx.slice(0, 5).map((d) => fmtDate(d)).join(', ') })}</p>}
          {r.unmatchedSells > 0 && <p className="mt-2 text-xs text-warning">{t('residence.realized.unmatched', { n: r.unmatchedSells })}</p>}
        </Panel>

        <Panel className="lg:col-span-7" title={t('residence.realized.dividends')} action={<span className="text-xs text-muted-foreground">{t('residence.realized.dividendsCount', { count: r.dividends.count })}</span>}>
          <div className="text-4xl font-semibold tracking-[-0.04em] text-profit num">{money(r.dividends.total)}</div>
          <p className="mt-3 text-xs text-muted-foreground">{r.dividends.grossRecorded > 0 ? t('residence.realized.dividendsNote', { gross: r.dividends.grossRecorded }) : t('residence.realized.dividendsNoteNet')}</p>
          {r.dividends.projected > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('residence.realized.dividendsProjected', { count: r.dividends.projected })}</p>}
        </Panel>

        <Panel className="lg:col-span-12" title={t('residence.realized.sales')}>
          {r.rows.length === 0 ? <EmptyNote>{t('residence.realized.empty', { year: r.year })}</EmptyNote> : (
            <div className="-mx-2 overflow-x-auto px-2">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead><tr className="text-left text-[11px] text-muted-foreground">
                  <th className="py-1.5 font-medium">{t('residence.realized.table.sold')}</th>
                  <th className="py-1.5 font-medium">{t('residence.realized.table.ticker')}</th>
                  <th className="py-1.5 font-medium">{t('residence.realized.table.bought')}</th>
                  <th className="py-1.5 text-right font-medium">{t('residence.realized.table.shares')}</th>
                  <th className="py-1.5 text-right font-medium">{t('residence.realized.table.proceeds')}</th>
                  <th className="py-1.5 text-right font-medium">{t('residence.realized.table.cost')}</th>
                  <th className="py-1.5 text-right font-medium">{t('residence.realized.table.gain')}</th>
                </tr></thead>
                <tbody>
                  {r.rows.map((x, i) => (
                    <tr key={`${x.ticker}-${x.soldDate}-${i}`} className="border-t border-white/[0.06]">
                      <td className="py-2 num">{fmtDate(x.soldDate)}</td>
                      <td className="py-2"><span className="flex items-center gap-1.5"><TickerLogo ticker={x.ticker} size="xs" className="!w-5 !h-5" />{x.ticker}<span className="text-[11px] text-muted-foreground">{x.broker}{x.account ? ` · ${x.account}` : ''}</span></span></td>
                      <td className="py-2 num text-muted-foreground">{fmtDate(x.acquiredDate)}</td>
                      <td className="py-2 text-right num">{fmtNum(x.shares, 4)}</td>
                      <td className="py-2 text-right num">{money(x.proceeds)}</td>
                      <td className="py-2 text-right num">{money(x.cost)}</td>
                      <td className={cn('py-2 text-right num', tone(x.gain))}>{money(x.gain, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{m.currency === 'CZK' ? t('residence.realized.fxCzk') : t('residence.realized.fxUsd')}</p>
        </Panel>
      </div>
      <Footnote>{t('residence.realized.footnote')}</Footnote>
    </div>
  );
}

/** Overview card in place of the Czech tax card. */
export function RealizedMini() {
  const { t } = useTranslation();
  const m = useRealizedModel();
  const r = m.report;
  const money = useBaseMoney(m.currency);
  return (
    <Panel to="/dane" title={`${t('residence.realized.card', { year: r.year })} →`} action={!r.complete ? <Pill tone="warning">{t('residence.realized.incomplete')}</Pill> : undefined}>
      <div className={cn('text-[28px] font-semibold tracking-[-0.03em] num', tone(r.net))}>{money(r.net, true)}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{t('residence.realized.cardSub', { gains: money(r.gains, true), losses: money(r.losses) })}</div>
      <div className="mt-3.5 flex justify-between border-t border-white/[0.08] pt-3 text-xs">
        <span className="text-muted-foreground">{t('residence.realized.cardDividends')}</span>
        <span className="num">{money(r.dividends.total)}</span>
      </div>
    </Panel>
  );
}
