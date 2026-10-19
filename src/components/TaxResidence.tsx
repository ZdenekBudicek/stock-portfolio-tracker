// Tax residence ("Daňová rezidence"): asked once on first login, changeable under Accounts.
// It decides which tax rules apply (src/lib/tax/jurisdictions.ts) and is independent of the
// UI language.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/v2/ui';
import { useSaveUserSettings, useTaxResidence } from '@/hooks/useTaxResidence';
import { BASE_CURRENCIES, SUPPORTED_TAX_RESIDENCES, type BaseCurrency, type TaxResidence } from '@/lib/tax/jurisdictions';
import { cn } from '@/lib/utils';

// withCurrency: the first-login dialog also asks for the default currency; Settings has its
// own currency row (Display), so the residence form there leaves it alone.
function ResidenceForm({ onSaved, submitLabel, withCurrency = true }: { onSaved?: () => void; submitLabel: string; withCurrency?: boolean }) {
  const { t } = useTranslation();
  const current = useTaxResidence();
  const save = useSaveUserSettings();
  const [residence, setResidence] = useState<TaxResidence>(current.taxResidence ?? 'CZ');
  const [currency, setCurrency] = useState<BaseCurrency>(current.baseCurrency);
  useEffect(() => { setResidence(current.taxResidence ?? 'CZ'); setCurrency(current.baseCurrency); }, [current.taxResidence, current.baseCurrency]);
  const dirty = !current.confirmed || residence !== current.taxResidence || currency !== current.baseCurrency;
  // Without the currency field the saved default is kept as it is at the moment of saving.
  const submit = () => save.mutate({ taxResidence: residence, baseCurrency: withCurrency ? currency : current.baseCurrency }, {
    onSuccess: () => { toast.success(t('residence.settings.saved')); onSaved?.(); },
    onError: () => toast.error(t('residence.settings.error')),
  });
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t('residence.settings.title')} className="grid gap-2 sm:grid-cols-2">
        {SUPPORTED_TAX_RESIDENCES.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={residence === r} onClick={() => setResidence(r)}
            className={cn('rounded-2xl border p-3.5 text-left transition-colors',
              residence === r ? 'border-primary/60 bg-primary/10' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.07]')}>
            <div className="flex items-center gap-2 font-semibold">
              <span className={cn('h-3.5 w-3.5 rounded-full border', residence === r ? 'border-primary bg-primary' : 'border-white/30')} />
              {t(`residence.option.${r}`)}
            </div>
            <div className="mt-1 pl-[22px] text-xs text-muted-foreground">{t(`residence.option.${r}hint`)}</div>
          </button>
        ))}
      </div>
      {withCurrency && <label className="block text-xs text-muted-foreground">{t('residence.currency.label')}
        <select value={currency} onChange={(e) => setCurrency(e.target.value as BaseCurrency)}
          className="mt-1.5 h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-sm text-foreground outline-none">
          {BASE_CURRENCIES.map((c) => <option key={c} value={c} className="bg-popover">{t(`settings.display.currencyName.${c}`)}</option>)}
        </select>
      </label>}
      <Button onClick={submit} disabled={save.isPending || !dirty} className="w-full rounded-xl">{submitLabel}</Button>
    </div>
  );
}

/** The residence could not be read and none is remembered: no tax output until it loads. */
export function ResidenceLoadError() {
  const { t } = useTranslation();
  const { retry } = useTaxResidence();
  return (
    <div className="rounded-2xl border border-warning/25 bg-warning/10 p-4 text-sm" role="alert">
      <p className="text-muted-foreground">{t('residence.settings.loadError')}</p>
      <Button variant="outline" size="sm" className="mt-3 rounded-xl" onClick={retry}>{t('residence.settings.retry')}</Button>
    </div>
  );
}

/** First-login question; shown once, until the user saves an answer. */
export function TaxResidenceDialog() {
  const { t } = useTranslation();
  const { needsOnboarding } = useTaxResidence();
  const [dismissed, setDismissed] = useState(false);
  return (
    <Dialog open={needsOnboarding && !dismissed} onOpenChange={(o) => { if (!o) setDismissed(true); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('residence.dialog.title')}</DialogTitle>
          <DialogDescription>{t('residence.dialog.text')}</DialogDescription>
        </DialogHeader>
        <ResidenceForm submitLabel={t('residence.dialog.save')} onSaved={() => setDismissed(true)} />
        <p className="text-[11px] text-muted-foreground">{t('residence.dialog.later')}</p>
      </DialogContent>
    </Dialog>
  );
}

/** Settings card on the Accounts page. */
export function TaxResidencePanel() {
  const { t } = useTranslation();
  const { available, known, isError } = useTaxResidence();
  return (
    <Panel title={t('residence.settings.title')}>
      <p className="-mt-2 mb-3 text-xs text-muted-foreground">{t('residence.settings.sub')}</p>
      {!known ? (isError ? <ResidenceLoadError /> : <p className="text-sm text-muted-foreground">{t('common.loading')}</p>)
        : !available ? <p className="text-sm text-muted-foreground">{t('residence.settings.unavailable')}</p>
        : <ResidenceForm submitLabel={t('residence.settings.save')} withCurrency={false} />}
    </Panel>
  );
}
