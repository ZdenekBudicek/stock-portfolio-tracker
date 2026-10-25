// Key statistics above the company financials: market cap, multiples and the main TTM figures,
// recomputed on every live price tick from the latest statements (lib/keyStats).
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompanyFundamentals } from '@/hooks/useCompanyFundamentals';
import { keyStats } from '@/lib/keyStats';
import { compactMoney } from '@/components/fundamentals/CompanyFinancials';
import { Label, Panel, Pill } from '@/components/v2/ui';
import { currentLang, currentLocale } from '@/i18n';
import { fmtDay, fmtNum, fmtPercent } from '@/i18n/format';
import { formatUsd } from '@/data/portfolio';
import { cn } from '@/lib/utils';

type Stat = { id: string; value: string; tone?: 'profit' | 'loss'; sub?: string };

const multiple = (v: number | null) => (v == null ? '—' : `${fmtNum(v, 1, 1)}×`);
const pct = (v: number | null) => (v == null ? '—' : fmtPercent(v * 100, 1));
const tone = (v: number | null) => (v == null ? undefined : v < 0 ? 'loss' as const : undefined);

export default function KeyStats({ symbol, price }: { symbol: string; price: number | null }) {
  const { t } = useTranslation();
  const { data: f } = useCompanyFundamentals(symbol);
  const s = useMemo(() => (f ? keyStats(f, price) : null), [f, price]);
  if (!f || !s || f.annual.periods.length + f.quarterly.periods.length === 0) return null;

  const cur = f.currency || 'USD';
  const money = (v: number | null) => compactMoney(v, cur);
  const shares = s.shares == null ? undefined : t('keyStats.sharesSub', {
    shares: new Intl.NumberFormat(currentLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(s.shares),
    unit: currentLang() === 'en' ? 'sh' : 'ks',
  });
  const stats: Stat[] = [
    { id: 'marketCap', value: money(s.marketCap), sub: shares },
    { id: 'ev', value: money(s.ev) },
    { id: 'pe', value: multiple(s.pe), sub: s.pe == null && s.priced && s.eps != null && s.eps <= 0 ? t('keyStats.loss') : undefined },
    { id: 'ps', value: multiple(s.ps) },
    { id: 'pb', value: multiple(s.pb) },
    { id: 'pfcf', value: multiple(s.pfcf) },
    { id: 'evEbitda', value: multiple(s.evEbitda) },
    { id: 'eps', value: s.eps == null ? '—' : cur === 'USD' ? formatUsd(s.eps) : `${fmtNum(s.eps, 2, 2)} ${cur}`, tone: tone(s.eps) },
    { id: 'divYield', value: pct(s.divYield) },
    { id: 'revenue', value: money(s.revenue) },
    { id: 'netMargin', value: pct(s.netMargin), tone: tone(s.netMargin) },
    { id: 'roe', value: pct(s.roe), tone: tone(s.roe) },
    { id: 'debtToEquity', value: s.debtToEquity == null ? '—' : fmtNum(s.debtToEquity, 2, 2) },
    { id: 'netCash', value: money(s.netCash), tone: tone(s.netCash) },
  ];

  return (
    <Panel
      className="lg:col-span-12"
      title={t('keyStats.title')}
      action={s.marketCap != null ? <Pill tone="primary" className="num">{t('keyStats.live', { price: formatUsd(price!) })}</Pill> : null}
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7">
        {stats.map((x) => (
          <div key={x.id} title={t(`keyStats.s.${x.id}.explain`)} className="min-w-0 cursor-help rounded-2xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-3">
            <Label>{t(`keyStats.s.${x.id}.label`)}</Label>
            <div className={cn('mt-1 whitespace-nowrap text-base font-semibold xl:text-lg tracking-tight num', x.tone === 'loss' && 'text-loss')}>{x.value}</div>
            {x.sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{x.sub}</div>}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/70">
        {!s.priced ? t('keyStats.currency', { currency: cur }) + ' ' : ''}
        {t('keyStats.note', { ttm: s.ttmAsOf ? fmtDay(s.ttmAsOf) : '—', shares: s.sharesAsOf ? fmtDay(s.sharesAsOf) : '—' })}
      </p>
    </Panel>
  );
}
