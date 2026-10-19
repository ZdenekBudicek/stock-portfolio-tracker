// The yearly tax profile of a non-Czech country — the inputs its estimate needs beyond the
// trades. Fields per country follow src/lib/tax/profile.ts; values are validated there.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateTaxProfile, type Country, type TaxProfile } from '@/lib/tax/engines';
import { profileKey, useSaveTaxProfile, useTaxProfiles } from '@/hooks/useTaxProfiles';
import { cn } from '@/lib/utils';

type Field =
  | { key: string; type: 'money' | 'signed'; max?: number }
  | { key: string; type: 'select'; options: (string | number)[] }
  | { key: string; type: 'bool' };

export const PROFILE_FIELDS: Record<Country, Field[]> = {
  US: [
    { key: 'filingStatus', type: 'select', options: ['single', 'marriedJoint', 'marriedSeparate', 'headOfHousehold', 'qualifyingSurvivingSpouse'] },
    { key: 'otherOrdinaryTaxableIncome', type: 'signed' }, { key: 'otherMagi', type: 'signed' },
    { key: 'otherNetInvestmentIncome', type: 'money' }, { key: 'shortTermLossCarry', type: 'money' },
    { key: 'longTermLossCarry', type: 'money' }, { key: 'foreignTaxCreditLimit', type: 'money' },
  ],
  SK: [
    { key: 'otherTaxableIncome', type: 'money' }, { key: 'securitiesAllowanceRemaining', type: 'money', max: 500 },
    { key: 'healthInsurance', type: 'select', options: ['standard', 'disabled', 'not-insured'] },
    { key: 'deductibleHealthContributions', type: 'money' },
  ],
  DE: [
    { key: 'otherTaxableIncome', type: 'money' }, { key: 'jointAssessment', type: 'bool' },
    { key: 'churchTaxRate', type: 'select', options: [0, 0.08, 0.09] }, { key: 'saverAllowanceUsed', type: 'money' },
    { key: 'stockLossCarry', type: 'money' }, { key: 'generalLossCarry', type: 'money' }, { key: 'privateLossCarry', type: 'money' },
    { key: 'otherPrivateDisposalNet', type: 'signed' },
  ],
  GB: [
    { key: 'otherTaxableIncome', type: 'money' }, { key: 'unusedPersonalAllowance', type: 'money', max: 12570 },
    { key: 'basicRateBand', type: 'money' }, { key: 'higherRateBandEnd', type: 'money' }, { key: 'lossCarry', type: 'money' },
    { key: 'annualExemptAmount', type: 'money', max: 3000 }, { key: 'dividendAllowanceRemaining', type: 'money', max: 500 },
  ],
  PL: [{ key: 'otherSolidarityBase', type: 'money' }, { key: 'cryptoCostCarry', type: 'money' }],
};

/** Neutral starting values: nothing assumed about the user's other income. */
export function defaultProfile(country: Country, year: number): Record<string, unknown> {
  const base = { version: 1, residence: country, year };
  switch (country) {
    case 'US': return { ...base, filingStatus: 'single', otherOrdinaryTaxableIncome: 0, otherMagi: 0, otherNetInvestmentIncome: 0, shortTermLossCarry: 0, longTermLossCarry: 0, foreignTaxCreditLimit: 0 };
    case 'SK': return { ...base, otherTaxableIncome: 0, securitiesAllowanceRemaining: 500, healthInsurance: 'standard', deductibleHealthContributions: 0 };
    case 'DE': return { ...base, otherTaxableIncome: 0, jointAssessment: false, churchTaxRate: 0, saverAllowanceUsed: 0, stockLossCarry: 0, generalLossCarry: 0, privateLossCarry: 0, otherPrivateDisposalNet: 0 };
    case 'GB': return { ...base, otherTaxableIncome: 0, unusedPersonalAllowance: 0, basicRateBand: 37700, higherRateBandEnd: 125140, lossCarry: 0, annualExemptAmount: 3000, dividendAllowanceRemaining: 500 };
    case 'PL': return { ...base, otherSolidarityBase: 0, cryptoCostCarry: 0, securityLosses: [] };
  }
}

export const CURRENCY_OF: Record<Country, string> = { US: 'USD', SK: 'EUR', DE: 'EUR', GB: 'GBP', PL: 'PLN' };

export function TaxProfileForm({ country, year, onSaved }: { country: Country; year: number; onSaved?: () => void }) {
  const { t } = useTranslation();
  const { data: stored = {} } = useTaxProfiles();
  const save = useSaveTaxProfile();
  const existing = stored[profileKey(country, year)];
  const initial = useMemo(() => (existing ?? defaultProfile(country, year)) as Record<string, unknown>, [existing, country, year]);
  const [v, setV] = useState<Record<string, unknown>>(initial);
  useEffect(() => setV(initial), [initial]);
  const parsed = validateTaxProfile(v);
  const issues = parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), true]));
  const cur = CURRENCY_OF[country];
  const set = (k: string, val: unknown) => setV((o) => ({ ...o, [k]: val }));
  const submit = () => {
    if (!parsed.success) return;
    save.mutate(parsed.data as TaxProfile, {
      onSuccess: () => { toast.success(t('intl.profile.saved')); onSaved?.(); },
      onError: () => toast.error(t('intl.profile.error')),
    });
  };
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('intl.profile.intro', { year, currency: cur })}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {PROFILE_FIELDS[country].map((f) => (
          <label key={f.key} className="block text-xs text-muted-foreground">
            <span className="text-foreground/90">{t(`intl.field.${country}.${f.key}`)}</span>
            {f.type === 'select' ? (
              <select value={String(v[f.key])} onChange={(e) => set(f.key, typeof f.options[0] === 'number' ? Number(e.target.value) : e.target.value)}
                className="mt-1.5 h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-sm text-foreground outline-none">
                {f.options.map((o) => <option key={String(o)} value={String(o)} className="bg-popover">{t(`intl.option.${country}.${f.key}.${String(o).replace('.', '_')}`)}</option>)}
              </select>
            ) : f.type === 'bool' ? (
              <select value={v[f.key] ? 'yes' : 'no'} onChange={(e) => set(f.key, e.target.value === 'yes')}
                className="mt-1.5 h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-sm text-foreground outline-none">
                <option value="no" className="bg-popover">{t('intl.profile.no')}</option>
                <option value="yes" className="bg-popover">{t('intl.profile.yes')}</option>
              </select>
            ) : (
              <Input inputMode="decimal" value={String(v[f.key] ?? '')} onChange={(e) => {
                const raw = e.target.value.replace(/\s/g, '').replace(',', '.');
                set(f.key, raw === '' || raw === '-' ? raw : Number(raw));
              }} className={cn('mt-1.5 h-10 rounded-xl num', issues[f.key] && 'border-loss/60')} />
            )}
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/80">{t(`intl.hint.${country}.${f.key}`, { currency: cur })}</span>
          </label>
        ))}
      </div>
      {country === 'PL' && <p className="text-[11px] text-muted-foreground">{t('intl.profile.plLosses')}</p>}
      <Button type="submit" disabled={!parsed.success || save.isPending} className="w-full rounded-xl">{t('intl.profile.save', { year })}</Button>
    </form>
  );
}
