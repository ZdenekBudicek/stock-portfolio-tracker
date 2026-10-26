// Live US market status beside the portfolio value: green "Market Open" during the NYSE regular
// session, red "Market Closed" otherwise (nights, weekends, exchange holidays, after an early close).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usMarketSession } from '@/lib/marketHours';
import { currentLocale } from '@/i18n';
import { cn } from '@/lib/utils';

/** The current time, re-read every 15 s so the status flips within seconds of the open and the close. */
const useNow = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

export default function MarketStatus({ className }: { className?: string }) {
  const { t } = useTranslation();
  const now = useNow();
  const { open, closedDay } = usMarketSession(now);
  const hint = closedDay === 'holiday' ? `${t('overview.market.hint')} ${t('overview.market.holiday')}` : t('overview.market.hint');
  return (
    <div className={cn('flex items-center gap-2', className)} title={hint}>
      <span role="status" className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        open ? 'border-profit/30 bg-profit/10 text-profit' : 'border-loss/30 bg-loss/10 text-loss')}>
        <span aria-hidden className={cn('h-2 w-2 rounded-full bg-current', open && 'animate-pulse')} />
        <span className="text-[10px] font-bold uppercase tracking-wider">{open ? t('overview.market.open') : t('overview.market.closed')}</span>
      </span>
      <span className="text-[10px] text-muted-foreground/70 font-mono tabular-nums">
        {now.toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' })}
      </span>
    </div>
  );
}
