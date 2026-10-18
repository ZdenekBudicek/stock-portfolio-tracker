// Upozornění — docs/design/V2-Upozorneni.dc.html
//
// The list is the CURRENT state derived from the loaded data (lib/alerts). Read/unread state,
// e-mail delivery and a history of past events need server-side storage that does not exist
// yet, so they are not offered here.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useComputedPortfolio, useDailySnapshots, useLivePrices } from '@/hooks/usePortfolio';
import { useBrokerSummary } from '@/hooks/useExtras';
import { EARNINGS_DAYS_AHEAD, MOVE_THRESHOLD_PCT, useAlerts } from '@/hooks/useInsights';
import { AlertRow, fmtDate } from '@/components/v2/widgets';
import { EmptyNote, Footnote, PageTitle, Panel, Pill, Segmented } from '@/components/v2/ui';
import { CNB_DATA_TO } from '@/lib/cnbRates';
import type { AlertKind } from '@/lib/alerts';
import { currentLocale } from '@/i18n';
import { fmtPercent } from '@/i18n/format';
import { cn } from '@/lib/utils';
import { useJurisdiction } from '@/hooks/useTaxResidence';

type Filter = 'all' | 'portfolio' | 'tax' | 'data';
const GROUP: Record<AlertKind, Filter> = { move: 'portfolio', watch: 'portfolio', earnings: 'portfolio', 'tax-limit': 'tax', exempt: 'tax', data: 'data' };

const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(currentLocale(), { day: 'numeric', month: 'numeric' });
};

function DataHealth() {
  const { t } = useTranslation();
  const live = useLivePrices();
  const p = useComputedPortfolio();
  const { data: summary } = useBrokerSummary('T212');
  const { data: snaps = [] } = useDailySnapshots();
  const lastSnap = snaps.length ? [...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))[snaps.length - 1].snapshot_date : null;
  const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  const syncAt = summary?.lastSyncAt ?? null;
  const rows = [
    { key: 'prices', label: t('alertsPage.health.prices'), ok: !p.error && !p.stale, warn: p.stale, value: p.error ? t('alertsPage.health.error') : fmtWhen(live.data?.fetchedAt) },
    { key: 't212', label: t('alertsPage.health.t212'), ok: !!syncAt, warn: !syncAt, value: syncAt ? fmtWhen(syncAt) : t('alertsPage.health.t212None') },
    { key: 'cnb', label: t('alertsPage.health.cnb'), ok: true, warn: false, value: t('alertsPage.health.until', { date: fmtDate(CNB_DATA_TO) }) },
    { key: 'history', label: t('alertsPage.health.history'), ok: !!lastSnap && lastSnap >= yesterday, warn: !lastSnap || lastSnap < yesterday, value: lastSnap ? t('alertsPage.health.until', { date: fmtDate(lastSnap) }) : '—' },
  ];
  const allOk = rows.every((r) => r.ok);
  return (
    <Panel title={t('alertsPage.health.title')} action={allOk ? <Pill tone="profit">{t('alertsPage.health.ok')}</Pill> : <Pill tone="warning">{t('alertsPage.health.check')}</Pill>}>
      <div className="divide-y divide-white/[0.06]">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[12px_1fr_auto] items-center gap-3 py-3 text-[13px]">
            <span className={cn('h-2.5 w-2.5 rounded-full', r.ok ? 'bg-profit shadow-[0_0_10px_hsl(var(--profit))]' : r.warn ? 'bg-warning shadow-[0_0_10px_hsl(var(--warning))]' : 'bg-loss')} />
            <span>{r.label}</span>
            <span className={cn('text-xs num', r.ok ? 'text-muted-foreground' : 'text-warning')}>{r.value}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

const Alerts = () => {
  const { t } = useTranslation();
  const alerts = useAlerts();
  const { caps } = useJurisdiction();
  const [filter, setFilter] = useState<Filter>('all');
  const shown = alerts.filter((a) => filter === 'all' || GROUP[a.kind] === filter);
  const watched: [string, string][] = [
    [t('alertsPage.watched.move'), `±${fmtPercent(MOVE_THRESHOLD_PCT, 0)}`],
    [t('alertsPage.watched.watch'), t('alertsPage.watched.watchRule')],
    [t('alertsPage.watched.earnings'), t('alertsPage.watched.earningsRule', { count: EARNINGS_DAYS_AHEAD })],
    // Tax alerts exist only where the user's jurisdiction has the exemption / the limit.
    ...(caps.holdingExemption ? [[t('alertsPage.watched.exempt'), t('alertsPage.watched.exemptRule')] as [string, string]] : []),
    ...(caps.annualProceedsLimit ? [[t('alertsPage.watched.limit'), t('alertsPage.watched.limitRule')] as [string, string]] : []),
    [t('alertsPage.watched.data'), t('alertsPage.watched.dataRule')],
  ];
  return (
    <div>
      <PageTitle
        eyebrow={t('alertsPage.count', { count: alerts.length })}
        title={t('nav.alerts')}
        right={<Segmented<Filter> value={filter} onChange={setFilter} options={(['all', 'portfolio', 'tax', 'data'] as const).filter((v) => v !== 'tax' || caps.holdingExemption || caps.annualProceedsLimit).map((v) => ({ value: v, label: t(`alertsPage.filter.${v}`) }))} />}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          {shown.length === 0 ? <EmptyNote>{t('alertsPage.empty')}</EmptyNote> : (
            <div className="space-y-2.5">{shown.map((a) => <AlertRow key={a.id} a={a} large />)}</div>
          )}
        </Panel>
        <div className="flex flex-col gap-4">
          <DataHealth />
          <Panel title={t('alertsPage.watched.title')}>
            <ul className="space-y-2.5 text-[13px]">
              {watched.map(([label, rule]) => (
                <li key={label} className="flex justify-between gap-3"><span>{label}</span><span className="text-muted-foreground num text-right">{rule}</span></li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      <Footnote>{t('alertsPage.footnote')}</Footnote>
    </div>
  );
};

export default Alerts;
