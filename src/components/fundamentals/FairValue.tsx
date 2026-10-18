import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, Kpi, Pill, Segmented } from '@/components/v2/ui';
import { useCompanyFundamentals } from '@/hooks/useCompanyFundamentals';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import type { CompanyFundamentals } from '@/types/fundamentals';
import { calculateFairValue, defaultAssumptions, METHOD_IDS, type Assumptions, type PriceClose } from '@/lib/fairValue';
import { fmtNum, fmtPercent } from '@/i18n/format';
import { cn } from '@/lib/utils';

interface Props { fundamentals: CompanyFundamentals; price: number | null; closes?: PriceClose[] }
const NO_CLOSES: PriceClose[] = [];

/** Keeps the stock page integration local and shares the existing query cache with the charts. */
export function FairValueForSymbol({ symbol, price }: { symbol: string; price: number | null }) {
  const { data } = useCompanyFundamentals(symbol);
  const { data: closes } = usePriceHistory(symbol);
  return data ? <FairValue fundamentals={data} price={price} closes={closes} /> : null;
}

export default function FairValue(props: Props) {
  return <Calculator key={props.fundamentals.symbol} {...props} />;
}

function Calculator({ fundamentals, price, closes = NO_CLOSES }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const defaults = useMemo(() => defaultAssumptions(fundamentals, closes), [fundamentals, closes]);
  const [overrides, setOverrides] = useState<Partial<Assumptions>>({});
  const assumptions = useMemo(() => ({ ...defaults.assumptions, ...overrides }), [defaults, overrides]);
  const report = useMemo(() => calculateFairValue(fundamentals, price, assumptions, closes), [fundamentals, price, assumptions, closes]);
  const set = <K extends keyof Assumptions>(key: K, value: Assumptions[K]) => setOverrides(prev => ({ ...prev, [key]: value }));
  const money = (value: number | null) => value == null || !Number.isFinite(value) ? t('fair.unavailable')
    // Same look as prices elsewhere in the app: $1,234.56 in either language.
    : `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const validPrice = price != null && Number.isFinite(price) && price > 0 ? price : null;
  const potential = report.potential;
  const position = potential == null ? null : Math.max(0, Math.min(100, 50 - potential * 100));
  const currencyBlocked = report.methods.dcf.reason === 'currency';
  const controls: { key: 'growth' | 'discount' | 'terminalGrowth' | 'pe' | 'pfcf' | 'pb' | 'ps' | 'epsGrowth' | 'years' | 'dividendGrowth'; min: number; max: number; step: number; percent?: boolean }[] = [
    { key: 'growth', min: -50, max: 50, step: 0.5, percent: true },
    { key: 'discount', min: 1, max: 25, step: 0.5, percent: true },
    { key: 'terminalGrowth', min: -2, max: 6, step: 0.25, percent: true },
    { key: 'pe', min: 1, max: 60, step: 0.5 },
    { key: 'pfcf', min: 1, max: 80, step: 0.5 },
    { key: 'pb', min: 0.1, max: 8, step: 0.1 },
    { key: 'ps', min: 0.1, max: 20, step: 0.1 },
    { key: 'epsGrowth', min: -50, max: 50, step: 0.5, percent: true },
    { key: 'years', min: 1, max: 10, step: 1 },
    { key: 'dividendGrowth', min: -10, max: 6, step: 0.25, percent: true },
  ];

  return (
    <Panel className="lg:col-span-12" title={t('fair.title')} glow="primary"
      action={<button type="button" className="rounded-full border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10" onClick={() => setOverrides({})}>{t('fair.reset')}</button>}>
      <p className="mb-4 text-sm text-muted-foreground">{t('fair.intro')}</p>
      <p className="mb-2 text-sm font-semibold">{t('fair.companyType', { type: t(`fair.types.${report.companyType}.title`) })}</p>
      <p className="mb-4 text-xs text-muted-foreground">{t(`fair.types.${report.companyType}.explain`)}</p>
      {fundamentals.status === 'error' && <p className="mb-4 text-sm text-warning">{t('fair.stale')}</p>}
      {currencyBlocked && <p role="status" className="mb-4 rounded-2xl bg-warning/10 p-4 text-sm text-warning">{t('fair.reason.currency', { currency: fundamentals.currency || t('fair.unknownCurrency') })}</p>}

      <div className="grid gap-5 sm:grid-cols-3" aria-live="polite" aria-atomic="true">
        <Kpi label={t(report.relativeOnly ? 'fair.relativeSummary' : 'fair.summary')} value={money(report.value)} tone="primary" size="lg" sub={t('fair.methodCount', { count: report.usableCount })} />
        <Kpi label={t('fair.price')} value={money(validPrice)} size="lg" />
        <Kpi label={t('fair.potential')} value={potential == null ? t('fair.unavailable') : fmtPercent(potential * 100, 1, true)}
          tone={potential == null || potential === 0 ? 'neutral' : potential > 0 ? 'profit' : 'loss'} size="lg" sub={t('fair.potentialExplain')} />
      </div>
      {report.reason && !currencyBlocked && <p role="status" className="mt-3 text-sm text-warning">{t(`fair.reason.${report.reason}`, { currency: fundamentals.currency || t('fair.unknownCurrency') })}</p>}
      {report.priceDeviation != null && <p className="mt-3 text-sm">{t(report.priceDeviation === 0 ? 'fair.priceEqual' : report.priceDeviation < 0 ? 'fair.priceBelow' : 'fair.priceAbove', { percent: fmtPercent(Math.abs(report.priceDeviation) * 100, 1) })}</p>}
      {report.marginOfSafety != null && <p className="mt-2 text-xs text-profit">{t('fair.margin')}: {fmtPercent(report.marginOfSafety * 100, 1)} · {t('fair.marginExplain')}</p>}
      <p className="mt-3 text-xs text-muted-foreground">{t('fair.summaryExplain')}</p>
      <p className="mt-2 text-xs text-muted-foreground">{report.included.map(method => `${t(`fair.methods.${method}.title`)}: ${fmtPercent(report.weights[method] * 100, 1)}`).join(' · ')}</p>
      {position != null ? (
        <div className="my-5" role="img" aria-label={t('fair.gauge', { potential: fmtPercent(potential! * 100, 1) })}>
          <div className="relative h-3 rounded-full bg-gradient-to-r from-profit/60 via-primary/40 to-loss/60">
            <span className="absolute top-0 h-3 border-l border-white/50" style={{ left: '50%' }} />
            <span className="absolute -top-1 h-5 w-1 -translate-x-1/2 rounded-full bg-foreground shadow" style={{ left: `${position}%` }} />
          </div>
          <div className="mt-2 flex justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="text-profit">{t('fair.undervalued')}</span><span>{t('fair.fairlyValued')}</span><span className="text-loss">{t('fair.overvalued')}</span>
          </div>
        </div>
      ) : <p className="my-4 text-xs text-muted-foreground">{t('fair.noComparison')}</p>}

      <fieldset disabled={currencyBlocked} className="my-5 rounded-2xl border border-white/10 bg-white/[0.025] p-4 disabled:opacity-50">
        <legend className="px-2 text-sm font-semibold">{t('fair.assumptions')}</legend>
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{t(`fair.defaults.${defaults.rationale}`, {
          historical: defaults.historicalGrowth == null ? t('fair.unavailable') : fmtPercent(defaults.historicalGrowth * 100, 1),
          growth: fmtPercent(defaults.assumptions.growth * 100, 1),
        })} {t('fair.defaults.common', { discount: fmtPercent(defaults.assumptions.discount * 100, 1), terminal: fmtPercent(defaults.assumptions.terminalGrowth * 100, 1) })}</p>
        {(['pe', 'pfcf', 'ps'] as const).map(metric => <p key={metric} className="mb-2 text-xs text-muted-foreground">{t(defaults.history[metric].median == null ? 'fair.multipleFallback' : 'fair.multipleHistory', {
          method: t(`fair.controls.${metric}`), value: fmtNum(defaults.assumptions[metric], 2),
          median: defaults.history[metric].median == null ? '' : fmtNum(defaults.history[metric].median!, 2),
          count: defaults.history[metric].count, from: defaults.history[metric].from, to: defaults.history[metric].to,
        })}</p>)}
        <p className="mb-3 text-xs text-muted-foreground">{t('fair.pbDefault')}</p>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          {controls.map(control => {
            const value = assumptions[control.key] * (control.percent ? 100 : 1);
            const label = t(`fair.controls.${control.key}`);
            const display = control.percent ? fmtPercent(value, 2) : control.key === 'years' ? t('fair.years', { count: value }) : fmtNum(value, 1);
            return <div key={control.key}>
              <div className="mb-2 flex justify-between gap-2 text-xs"><label htmlFor={`${id}-${control.key}`}>{label}</label><output htmlFor={`${id}-${control.key}`} className="num text-primary">{display}</output></div>
              <input id={`${id}-${control.key}`} type="range" className="w-full accent-primary" min={control.min} max={control.max} step={control.step}
                value={value} aria-valuetext={display} onChange={event => set(control.key, Number(event.target.value) / (control.percent ? 100 : 1))} />
            </div>;
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t('fair.fcfBase')}</span>
            <Segmented value={assumptions.fcfMode} onChange={value => set('fcfMode', value)} options={[
              { value: 'latest', label: t('fair.latest') }, { value: 'average3', label: t('fair.average3') }, { value: 'normalized', label: t('fair.normalized') },
            ]} />
          </div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={assumptions.includeNetCash} onChange={event => set('includeNetCash', event.target.checked)} />{t('fair.includeCash')}</label>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('fair.cashExplain')}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('fair.normalizationExplain')}</p>
      </fieldset>

      {!currencyBlocked && <div className="mb-4 flex flex-wrap gap-2">
        <Pill className="max-w-full whitespace-normal">{t('fair.baseFcf', { value: money(report.inputs.fcfPerShare), source: t(`fair.source.${report.inputs.fcf.source}`) })}</Pill>
        <Pill className="max-w-full whitespace-normal">{t('fair.baseEps', { value: money(report.inputs.eps.value), source: t(`fair.source.${report.inputs.eps.source}`) })}</Pill>
        <Pill className="max-w-full whitespace-normal">{t('fair.baseDividend', { source: t(`fair.source.${report.inputs.dividends.source}`) })}</Pill>
      </div>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {METHOD_IDS.map(method => {
          const estimate = report.methods[method];
          const tone = estimate.value == null ? 'warning' : validPrice == null || estimate.value === validPrice ? 'primary' : estimate.value > validPrice ? 'profit' : 'loss';
          return <div key={method} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
            <Kpi label={t(`fair.methods.${method}.title`)} value={money(estimate.value)} tone={tone} />
            <p className="mt-2 text-xs font-semibold">{report.weights[method] > 0 ? t('fair.methodWeight', { weight: fmtPercent(report.weights[method] * 100, 1) }) : t('fair.comparisonOnly')}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(`fair.methods.${method}.explain`)}</p>
            {estimate.reason && <p className="mt-2 text-xs text-warning">{t(`fair.reason.${estimate.reason}`, { currency: fundamentals.currency || t('fair.unknownCurrency') })}</p>}
          </div>;
        })}
        <div className="rounded-2xl border border-primary/20 bg-primary/[0.06] p-4">
          <Kpi label={t('fair.reverse.title')} value={report.reverse.value == null ? t('fair.unavailable') : fmtPercent(report.reverse.value * 100, 1)} tone="primary" />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('fair.reverse.explain')}</p>
          {report.reverse.reason && <p className="mt-2 text-xs text-warning">{t(`fair.reason.${report.reverse.reason}`, { currency: fundamentals.currency || t('fair.unknownCurrency') })}</p>}
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[360px] border-separate border-spacing-1 text-xs num">
          <caption className="mb-2 text-left text-sm font-semibold">{t('fair.sensitivity')}</caption>
          <thead><tr><th scope="col" className="p-2 text-left font-medium text-muted-foreground">{t('fair.sensitivityAxes')}</th>
            {report.sensitivity.growths.map(growth => <th scope="col" key={growth} className="p-2 font-medium">{fmtPercent(growth * 100, 1)}</th>)}
          </tr></thead>
          <tbody>{report.sensitivity.cells.map((row, i) => <tr key={i}>
            <th scope="row" className="p-2 text-left font-medium">{fmtPercent(report.sensitivity.discounts[i] * 100, 1)}</th>
            {row.map((cell, j) => <td key={j} title={cell.reason ? t(`fair.reason.${cell.reason}`, { currency: fundamentals.currency || t('fair.unknownCurrency') }) : undefined}
              className={cn('rounded-lg p-3 text-center', i === 1 && j === 1 && 'ring-1 ring-primary', cell.value == null || validPrice == null || cell.value === validPrice ? 'bg-white/5' : cell.value > validPrice ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss')}>
              {money(cell.value)}
            </td>)}
          </tr>)}</tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">{t('fair.sensitivityExplain')}</p>
      </div>
      <p className="mt-5 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">{t('fair.disclaimer')}</p>
    </Panel>
  );
}
