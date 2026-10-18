// Nastavení — opened from the profile menu. Things a user may want to change about how the app
// treats them: tax residence and reporting currency, how taxes are calculated by default, how the
// app looks, and their sign-in (a password only for accounts that have one — Google sign-ins
// manage it at Google). No name or profile: nothing in the app shows a user to anyone else.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { supabase } from '@/integrations/supabase/client';
import { TaxResidencePanel } from '@/components/TaxResidence';
import { useTaxResidence } from '@/hooks/useTaxResidence';
import { useTaxPrefs } from '@/hooks/useTaxPrefs';
import { currentLang, setLanguage } from '@/i18n';
import { Footnote, PageTitle, Panel, Pill, Segmented } from '@/components/v2/ui';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const Row = ({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-2 border-t border-white/[0.06] py-3.5 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <div className="min-w-0">
      <div className="text-sm font-medium">{title}</div>
      {sub && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{sub}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

function TaxPrefsPanel() {
  const { t } = useTranslation();
  const [prefs, update] = useTaxPrefs();
  const { jurisdiction: { caps }, known } = useTaxResidence();
  if (known && !caps.taxEstimate) return null; // Czech tax rules only for Czech residents
  return (
    <Panel title={t('settings.tax.title')}>
      <p className="-mt-2 mb-3 text-xs text-muted-foreground">{t('settings.tax.sub')}</p>
      <Row title={t('settings.tax.fx')} sub={t('settings.tax.fxSub')}>
        <Segmented value={prefs.fxMethod} onChange={(v) => update({ fxMethod: v })}
          options={[{ value: 'cnb-daily', label: t('settings.tax.fxDaily') }, { value: 'gfr-annual', label: t('settings.tax.fxAnnual') }]} />
      </Row>
      <Row title={t('settings.tax.limit')} sub={t('settings.tax.limitSub')}>
        <Segmented value={prefs.limitIncludesExempt ? 'all' : 'taxable'} onChange={(v) => update({ limitIncludesExempt: v === 'all' })}
          options={[{ value: 'all', label: t('settings.tax.limitAll') }, { value: 'taxable', label: t('settings.tax.limitTaxable') }]} />
      </Row>
    </Panel>
  );
}

function DisplayPanel() {
  const { t } = useTranslation();
  const { currency, setCurrency, hidden, toggleHidden } = useCurrency();
  const lang = currentLang();
  return (
    <Panel title={t('settings.display.title')}>
      <Row title={t('settings.display.language')}>
        <Segmented value={lang} onChange={(v) => setLanguage(v)} options={[{ value: 'cs', label: 'Čeština' }, { value: 'en', label: 'English' }]} />
      </Row>
      <Row title={t('settings.display.currency')} sub={t('settings.display.currencySub')}>
        <Segmented value={currency} onChange={(v) => setCurrency(v)} options={[{ value: 'CZK', label: lang === 'en' ? 'CZK' : 'Kč' }, { value: 'USD', label: 'USD $' }]} />
      </Row>
      <Row title={t('settings.display.hide')} sub={t('settings.display.hideSub')}>
        <Segmented value={hidden ? 'on' : 'off'} onChange={(v) => { if ((v === 'on') !== hidden) toggleHidden(); }}
          options={[{ value: 'off', label: t('settings.display.show') }, { value: 'on', label: t('settings.display.hidden') }]} />
      </Row>
    </Panel>
  );
}

function PasswordForm() {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ok = pw.length >= 8 && pw.length <= 72 && pw === pw2;
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { toast.error(t('settings.account.pwError', { message: error.message })); return; }
    setPw(''); setPw2('');
    toast.success(t('settings.account.pwSaved'));
  };
  return (
    <form className="grid gap-2.5 sm:grid-cols-[1fr_1fr_auto] sm:items-start" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div>
        <Input type="password" autoComplete="new-password" placeholder={t('settings.account.pwNew')} value={pw} onChange={(e) => setPw(e.target.value)} className="h-10 rounded-xl" />
        {tooShort && <div className="mt-1 text-[11px] text-loss">{t('settings.account.pwShort')}</div>}
      </div>
      <div>
        <Input type="password" autoComplete="new-password" placeholder={t('settings.account.pwRepeat')} value={pw2} onChange={(e) => setPw2(e.target.value)} className="h-10 rounded-xl" />
        {mismatch && <div className="mt-1 text-[11px] text-loss">{t('settings.account.pwMismatch')}</div>}
      </div>
      <Button type="submit" disabled={!ok || busy} className="h-10 rounded-xl">{busy ? t('common.loading') : t('settings.account.pwSave')}</Button>
    </form>
  );
}

function AccountPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const providers: string[] = (user?.app_metadata?.providers as string[] | undefined)
    ?? (user?.identities ?? []).map((i) => i.provider);
  const hasPassword = providers.includes('email');
  const viaGoogle = providers.includes('google');
  const [busy, setBusy] = useState(false);
  const signOutEverywhere = async () => {
    if (!window.confirm(t('settings.account.everywhereConfirm'))) return;
    setBusy(true);
    await supabase.auth.signOut({ scope: 'global' });
    setBusy(false);
  };
  return (
    <Panel title={t('settings.account.title')}>
      <Row title={t('settings.account.email')} sub={user?.email ?? '—'}>
        <div className="flex flex-wrap gap-1.5">
          {viaGoogle && <Pill tone="primary">Google</Pill>}
          {hasPassword && <Pill tone="neutral">{t('settings.account.passwordLogin')}</Pill>}
        </div>
      </Row>
      <div className="border-t border-white/[0.06] py-3.5">
        <div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4 text-primary" /> {t('settings.account.password')}</div>
        {hasPassword ? (
          <>
            <div className="mb-2.5 mt-0.5 text-xs text-muted-foreground">{t('settings.account.passwordSub')}</div>
            <PasswordForm />
          </>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.account.passwordGoogle')}</div>
        )}
      </div>
      <Row title={t('settings.account.everywhere')} sub={t('settings.account.everywhereSub')}>
        <Button variant="outline" disabled={busy} onClick={signOutEverywhere} className="h-9 rounded-xl"><LogOut className="mr-2 h-4 w-4" />{t('settings.account.everywhereBtn')}</Button>
      </Row>
      <div className="mt-1 flex items-start gap-2 rounded-2xl bg-white/[0.03] p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-profit" />
        <span>{t('settings.account.privacy')}</span>
      </div>
    </Panel>
  );
}

const Settings = () => {
  const { t } = useTranslation();
  return (
    <div>
      <PageTitle eyebrow={t('settings.eyebrow')} title={t('settings.title')} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <TaxResidencePanel />
          <TaxPrefsPanel />
        </div>
        <div className="flex flex-col gap-4">
          <DisplayPanel />
          <AccountPanel />
        </div>
      </div>
      <Footnote><span className={cn('inline-flex items-center gap-1.5')}><Check className="h-3.5 w-3.5 text-profit" />{t('settings.footnote')}</span></Footnote>
    </div>
  );
};

export default Settings;
