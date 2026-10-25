// Taxes for residents of a supported non-Czech country (US, SK, DE, GB, PL): the country's own
// engine (src/lib/tax/engines.ts) over the full ledger, in the country's currency, with the
// yearly profile the user filled in. Every blocking gap is shown instead of a made-up number.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info } from 'lucide-react';
import { useTransactions } from '@/hooks/usePortfolio';
import { useDividends } from '@/hooks/useExtras';
import { useInstrumentRegistry } from '@/hooks/useAssetKinds';
import { useTaxProfiles, profileKey } from '@/hooks/useTaxProfiles';
import type { Country, TaxReport } from '@/lib/tax/engines';
import { computeInternationalTaxModel } from '@/lib/internationalTaxModel';
import { TaxProfileForm, CURRENCY_OF } from '@/components/tax/TaxProfileForm';
import { TickerLogo } from '@/components/TickerLogo';
import { fmtDate } from '@/components/v2/widgets';
import { EmptyNote, Footnote, Kpi, PageTitle, Panel, Pill, Segmented } from '@/components/v2/ui';
import { useCurrency } from '@/contexts/CurrencyContext';
import { currentLocale } from '@/i18n';
import { fmtNum } from '@/i18n/format';
import { cn } from '@/lib/utils';

const YEARS = [2024, 2025, 2026] as const;

function useMoney(currency: string) {
  const { hidden } = useCurrency();
  return (v: number | null | undefined, signed = false) => {
    if (v == null || !Number.isFinite(v)) return '—';
    if (hidden) return '••••';
    const s = new Intl.NumberFormat(currentLocale(), { style: 'currency', currency, maximumFractionDigits: 0 }).format(Math.abs(v));
    return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}${s}`;
  };
}

function Report({ report, country, tickerById }: { report: TaxReport; country: Country; tickerById: Map<string, string> }) {
  const { t } = useTranslation();
  const { hidden } = useCurrency();
  const money = useMoney(report.currency);
  const [all, setAll] = useState(false);
  const blocking = report.warnings.filter((w) => w.blocking);
  const provisional = report.warnings.some((w) => w.code === 'incomplete-ledger' && !w.blocking);
  const realized = report.rows.reduce((a, r) => a + (r.gain ?? 0), 0);
  const exempt = report.rows.reduce((a, r) => a + (r.exemptGain ?? 0), 0);
  const wash = report.rows.reduce((a, r) => a + (r.washDisallowed ?? 0), 0);
  const divGross = report.dividends.reduce((a, d) => a + (d.gross ?? 0), 0);
  const rows = all ? report.rows : report.rows.slice(0, 15);
  // One line per kind of warning (with how many and which tickers), not one per transaction.
  const tickerOf = new Map<string, string>([...report.rows.map((r) => [r.sellId, r.ticker] as [string, string])]);
  const warnings = Object.values(report.warnings.filter((w) => w.code !== 'scope').reduce<Record<string, { code: string; message: string; blocking: boolean; count: number; tickers: string[] }>>((m, w) => {
    const g = (m[w.code] ??= { code: w.code, message: w.message, blocking: false, count: 0, tickers: [] });
    g.count++; g.blocking ||= w.blocking;
    const tk = (w.ref && (tickerOf.get(w.ref) ?? tickerById.get(w.ref))) || null;
    if (tk && !g.tickers.includes(tk)) g.tickers.push(tk);
    return m;
  }, {})).sort((x, y) => Number(y.blocking) - Number(x.blocking));
  const cls = (c: string) => t(`intl.class.${c}`, { defaultValue: c.replace(/-/g, ' ') });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Panel className="lg:col-span-5" glow="warning">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-warning/80">{t('intl.est.title')}</span>
          {blocking.length ? <Pill tone="loss">{t('intl.status.blocked')}</Pill> : provisional ? <Pill tone="warning">{t('intl.status.provisional')}</Pill> : <Pill tone="profit">{t('intl.status.complete')}</Pill>}
        </div>
        <div className={cn('mt-2.5 text-5xl font-semibold leading-none tracking-[-0.045em] num', (report.estimatedTax ?? 0) < 0 ? 'text-profit' : 'text-warning')}>{money(report.estimatedTax)}</div>
        <div className="mt-2.5 text-xs text-muted-foreground">{t(`intl.est.sub.${country}`, { defaultValue: t('intl.est.sub.generic') })}</div>
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('intl.kpi.base')} value={money(report.taxableBase)} size="sm" /></div>
          <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('intl.kpi.credit')} value={money(report.foreignTaxCredit)} size="sm" /></div>
          {report.healthContributions != null && <div className="col-span-2 rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('intl.kpi.health')} value={money(report.healthContributions)} size="sm" /></div>}
        </div>
      </Panel>

      <Panel className="lg:col-span-7" title={t('intl.sum.title', { year: report.year })} action={<span className="text-xs text-muted-foreground">{t('intl.sum.period', { from: fmtDate(report.period.from), to: fmtDate(report.period.to) })}</span>}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('intl.kpi.realized')} value={money(realized, true)} tone={realized >= 0 ? 'profit' : 'loss'} size="sm" /></div>
          <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('intl.kpi.exempt')} value={money(exempt, true)} size="sm" /></div>
          <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('intl.kpi.dividends')} value={money(divGross)} size="sm" /></div>
          <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('intl.kpi.sales')} value={report.rows.length} size="sm" /></div>
        </div>
        {wash > 0 && <p className="mt-3 rounded-xl border border-warning/25 bg-warning/[0.07] p-3 text-xs">{t('intl.wash', { amount: money(wash) })}</p>}
        {Object.keys(report.carryforward).length > 0 && (
          <div className="mt-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">{t('intl.carry')}</div>
            {Object.entries(report.carryforward).map(([k, v]) => <div key={k} className="flex justify-between gap-3"><span>{t(`intl.carryKey.${k}`, { defaultValue: k })}</span><span className="num">{money(v)}</span></div>)}
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">{t(`intl.fx.${report.fxMode}`)}</p>
      </Panel>

      {warnings.length > 0 && (
        <Panel className="lg:col-span-12" title={t('intl.warn.title')}>
          <ul className="space-y-2 text-sm">
            {warnings.map((w) => (
              <li key={w.code} className={cn('flex gap-2.5 rounded-xl p-3', w.blocking ? 'bg-loss/10' : 'bg-white/[0.04]')}>
                {w.blocking ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-loss" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                <span>
                  {t(`intl.warning.${w.code}`, { defaultValue: w.message })}
                  {w.count > 1 && <span className="text-muted-foreground"> · {t('intl.warnCount', { count: w.count })}</span>}
                  {w.tickers.length > 0 && <span className="text-muted-foreground"> · {w.tickers.slice(0, 6).join(', ')}{w.tickers.length > 6 ? ' …' : ''}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel className="lg:col-span-12" title={t('intl.rows.title')}>
        {report.rows.length === 0 ? <EmptyNote>{t('intl.rows.empty')}</EmptyNote> : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="text-[11px] text-muted-foreground">
                  <th className="py-2 text-left font-medium">{t('intl.rows.stock')}</th>
                  <th className="py-2 text-left font-medium">{t('intl.rows.dates')}</th>
                  <th className="py-2 text-right font-medium">{t('intl.rows.shares')}</th>
                  <th className="py-2 text-right font-medium">{t('intl.rows.proceeds')}</th>
                  <th className="py-2 text-right font-medium">{t('intl.rows.cost')}</th>
                  <th className="py-2 text-right font-medium">{t('intl.rows.gain')}</th>
                  <th className="py-2 pl-3 text-left font-medium">{t('intl.rows.type')}</th>
                </tr>
              </thead>
              <tbody className="focus-list">
                {rows.map((r, i) => (
                  <tr key={`${r.sellId}-${r.buyId}-${i}`} className="border-t border-white/[0.06]">
                    <td className="py-2"><span className="flex items-center gap-2"><TickerLogo ticker={r.ticker} size="xs" />{r.ticker}</span></td>
                    <td className="py-2 text-muted-foreground num">{r.acquired ? fmtDate(r.acquired) : '—'} → {fmtDate(r.sold)}</td>
                    <td className="py-2 text-right num">{fmtNum(r.shares, 4)}</td>
                    <td className="py-2 text-right num">{money(r.proceeds)}</td>
                    <td className="py-2 text-right num text-muted-foreground">{money(r.cost)}</td>
                    <td className={cn('py-2 text-right font-semibold num', (r.gain ?? 0) >= 0 ? 'text-profit' : 'text-loss')}>{money(r.gain, true)}</td>
                    <td className="py-2 pl-3 text-xs text-muted-foreground">{cls(r.classification)}{r.washDisallowed > 0 ? <span className="text-warning"> · {t('intl.rows.wash')}</span> : null}{r.exemptGain ? <span className="text-[hsl(194_85%_62%)]"> · {t('intl.rows.exempt')}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {report.rows.length > 15 && <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 text-xs font-medium text-primary hover:underline">{all ? t('taxes.brk.less') : t('intl.rows.more', { count: report.rows.length - 15 })}</button>}
      </Panel>

      {Object.keys(report.breakdown).length > 0 && (
        <Panel className="lg:col-span-12" title={t('intl.breakdown')}>
          <div className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
            {Object.entries(report.breakdown).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-white/[0.04] py-1"><span className="text-muted-foreground">{t(`intl.bk.${k}`, { defaultValue: k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() })}</span><span className="num">{hidden ? '••••' : fmtNum(v, 2)}</span></div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

export function InternationalTaxes({ country }: { country: Country }) {
  const { t } = useTranslation();
  const thisYear = new Date().getFullYear();
  const years = YEARS.filter((y) => y <= thisYear);
  const [year, setYear] = useState<number>(years[years.length - 1]);
  const [editing, setEditing] = useState(false);
  const profilesQ = useTaxProfiles();
  const txQ = useTransactions();
  const divQ = useDividends();
  const regQ = useInstrumentRegistry();
  const profiles = profilesQ.data ?? {};
  const txs = txQ.data ?? [];
  const divs = divQ.data ?? [];
  const isLoading = profilesQ.isLoading || txQ.isLoading || divQ.isLoading || regQ.loading;
  // A failed read must never look like an empty history with zero tax.
  const loadError = profilesQ.isError || txQ.isError || divQ.isError || !!regQ.error;
  const profile = profiles[profileKey(country, year)];
  const tickerById = useMemo(() => new Map(txs.map(x => [x.id, x.ticker])), [txs]);
  const today = new Date().toISOString().slice(0, 10);
  const result = useMemo(() => computeInternationalTaxModel({ transactions: txs, dividends: divs,
    registry: regQ.registry, residence: country, year, today, storedProfiles: { profiles } }),
  [txs, divs, regQ.registry, country, year, today, profiles]);

  return (
    <div>
      <PageTitle eyebrow={t('intl.eyebrow', { country: t(`residence.option.${country}`), currency: CURRENCY_OF[country] })} title={t('taxes.title', { year })}
        right={<Segmented value={String(year)} onChange={(v) => setYear(Number(v))} options={years.map((y) => ({ value: String(y), label: String(y) }))} />} />
      {isLoading ? <div className="h-48 animate-pulse rounded-3xl bg-white/[0.03]" /> : loadError ? (
        <Panel title={t('intl.error.loadTitle')}><p className="text-sm text-muted-foreground">{t('intl.error.load')}</p></Panel>
      ) : !profile || editing ? (
        <Panel title={t('intl.profile.title', { year })} className="max-w-3xl">
          <TaxProfileForm country={country} year={year} onSaved={() => setEditing(false)} />
        </Panel>
      ) : result.status !== 'ready' ? (
        <Panel title={t('intl.error.title')}><p className="text-sm text-muted-foreground">{t('intl.error.text')}</p><p className="mt-2 text-xs text-muted-foreground/80">{result.reason}</p></Panel>
      ) : result.status === 'ready' ? (
        <>
          <Report report={result.report} country={country} tickerById={tickerById} />
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <button type="button" onClick={() => setEditing(true)} className="font-medium text-primary hover:underline">{t('intl.profile.edit', { year })}</button>
            <Link to="/nastaveni" className="text-muted-foreground hover:text-foreground">{t('intl.profile.residence')}</Link>
          </div>
        </>
      ) : null}
      <Footnote>{t(`intl.footnote.${country}`, { defaultValue: t('intl.footnote.generic') })}</Footnote>
    </div>
  );
}
