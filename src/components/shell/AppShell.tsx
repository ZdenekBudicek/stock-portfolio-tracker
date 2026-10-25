// App frame of the V2 design: aurora background (body), floating pill navigation, global
// controls (language, currency, privacy, refresh, trade, alerts, account) and the routed page.
import { Suspense } from 'react';
import { NavLink, Outlet, Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, Eye, EyeOff, RefreshCw, LogOut, Wallet, ChevronDown, Menu, Settings as SettingsIcon } from 'lucide-react';
import { DISPLAY_CURRENCIES, symbolOf } from '@/lib/displayCurrency';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useAuth } from '@/contexts/AuthContext';
import { useLivePrices } from '@/hooks/usePortfolio';
import { useAlerts } from '@/hooks/useInsights';
import QuickTradeDialog from '@/components/QuickTradeDialog';
import SplitsBanner from '@/components/SplitsBanner';
import { useSplits } from '@/hooks/useExtras';
import { setLanguage, currentLang, type Lang } from '@/i18n';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useTaxResidence } from '@/hooks/useTaxResidence';
import { TaxResidenceDialog } from '@/components/TaxResidence';
import { BrandMark, BrandName } from '@/components/brand/BrandMark';
import { useAutoRequestFundamentals } from '@/hooks/useFundamentalsRequests';
import { AssistantSlot } from '@/components/assistant/AssistantButton';
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher';

const NAV = [
  { to: '/', key: 'overview', end: true },
  { to: '/pozice', key: 'positions' },
  { to: '/vynosy', key: 'returns' },
  { to: '/dividendy', key: 'dividends' },
  { to: '/dane', key: 'taxes' },
] as const;

const Brand = () => {
  const { t } = useTranslation();
  return (
    <Link to="/" className="flex items-center gap-2.5 shrink-0" aria-label={t('nav.overview')}>
      <BrandMark size={32} />
      <BrandName className="hidden sm:inline text-[17px]" />
    </Link>
  );
};

const pill = 'inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors';

/** Two-option pill switch used for language and currency. */
function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { v: T; text: string; aria: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full border border-white/10 bg-white/[0.05] p-1">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} aria-pressed={value === o.v} aria-label={o.aria}
          className={cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', value === o.v ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

export default function AppShell() {
  const { t } = useTranslation();
  const { currency, setCurrency, hidden, toggleHidden } = useCurrency();
  const { user, signOut } = useAuth();
  const live = useLivePrices();
  const alerts = useAlerts();
  // Statements for a just-added company are fetched now, not at night.
  useAutoRequestFundamentals();
  const { jurisdiction: { caps }, known: residenceKnown, taxResidence } = useTaxResidence();
  const jurisdictionHasEngine = !!taxResidence && ['US', 'SK', 'DE', 'GB', 'PL'].includes(taxResidence);
  // Outside the supported jurisdictions "Daně" is a neutral realized-gains view.
  // Only the neutral view (a country without its own rules) is called realized gains.
  const navLabel = (key: string) => (key === 'taxes' && residenceKnown && !caps.taxEstimate && !jurisdictionHasEngine ? t('residence.nav.realized') : t(`nav.${key}`));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: pendingSplits = [] } = useSplits('pending');
  const urgent = alerts.filter((a) => a.tone === 'loss' || a.tone === 'warning' || a.kind === 'watch').length;
  const lang = currentLang();
  const langCode = lang === 'en' ? 'en' : 'cs';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['live-prices'] });
    qc.invalidateQueries({ queryKey: ['positions'] });
    qc.invalidateQueries({ queryKey: ['daily-snapshots'] });
  };

  const langOptions = [{ v: 'cs' as Lang, text: 'CZ', aria: 'Čeština' }, { v: 'en' as Lang, text: 'EN', aria: 'English' }] as const;
  const currencyOptions = DISPLAY_CURRENCIES.map((c) => ({ v: c, text: symbolOf(c, langCode), aria: t(`settings.display.currencyName.${c}`) }));

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[1320px] px-4 sm:px-8 pt-5 pb-24">
        <header className="flex items-center justify-between gap-3 mb-6 sm:mb-8">
          <Brand />

          <nav aria-label={t('shell.mainNav')} className="hidden md:flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] p-1.5 backdrop-blur-xl">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={'end' in n ? n.end : undefined}
                className={({ isActive }) => cn(
                  'rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors',
                  isActive ? 'bg-foreground text-background font-semibold' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {navLabel(n.key)}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden sm:block"><Toggle value={lang} options={langOptions} onChange={setLanguage} label={t('shell.language')} /></div>
            <div className="hidden sm:block"><Toggle value={currency} options={currencyOptions} onChange={setCurrency} label={t('shell.currency')} /></div>
            <button onClick={toggleHidden} className={cn(pill, 'px-2.5', hidden && 'text-primary border-primary/40')}
              title={hidden ? t('shell.showAmounts') : t('shell.hideAmountsLong')} aria-label={hidden ? t('shell.showAmounts') : t('shell.hideAmounts')}>
              {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button onClick={refresh} disabled={live.isFetching} className={cn(pill, 'px-2.5 hidden sm:inline-flex')} title={t('shell.refresh')} aria-label={t('shell.refresh')}>
              <RefreshCw className={cn('h-3.5 w-3.5', live.isFetching && 'animate-spin text-primary')} />
            </button>
            {/* Assistant (only when VITE_ASSISTANT_ENABLED): button next to the bell, panel as a side sheet. */}
            <AssistantSlot />
            <NavLink to="/upozorneni" className={({ isActive }) => cn(pill, 'relative px-2.5', isActive && 'bg-foreground text-background')} aria-label={t('shell.alertsCount', { count: urgent })}>
              <Bell className="h-3.5 w-3.5" />
              {urgent > 0 && (
                <span className="absolute -top-1.5 -right-1.5 rounded-full bg-loss px-1.5 text-[10px] font-semibold leading-4 text-white">{urgent}</span>
              )}
            </NavLink>
            <div className="hidden sm:block"><QuickTradeDialog /></div>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-full" aria-label={t('shell.accountMenu')}>
                <span className="h-8 w-8 rounded-full" style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--cyan)))' }} />
                <ChevronDown className="h-3 w-3 text-muted-foreground hidden sm:block" />
                <Menu className="h-4 w-4 text-muted-foreground sm:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{user?.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <div className="md:hidden">
                  {NAV.map((n) => <DropdownMenuItem key={n.to} onSelect={() => navigate(n.to)}>{navLabel(n.key)}</DropdownMenuItem>)}
                  <DropdownMenuItem onSelect={() => navigate('/upozorneni')}>{t('nav.alerts')}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </div>
                <div className="sm:hidden">
                  {DISPLAY_CURRENCIES.filter((c) => c !== currency).map((c) => (
                    <DropdownMenuItem key={c} onSelect={() => setCurrency(c)}>{t('shell.switchCurrency', { to: symbolOf(c, langCode) })}</DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => setLanguage(lang === 'cs' ? 'en' : 'cs')}>{lang === 'cs' ? 'Language: English' : 'Jazyk: čeština'}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </div>
                <DropdownMenuItem onSelect={() => navigate('/nastaveni')}><SettingsIcon className="mr-2 h-4 w-4" /> {t('shell.settings')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate('/ucty')}><Wallet className="mr-2 h-4 w-4" /> {t('shell.accounts')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate('/vynosy/historie')}>{t('shell.history')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={signOut}><LogOut className="mr-2 h-4 w-4" /> {t('shell.signOut')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {pendingSplits.length > 0 && <div className="mb-4"><SplitsBanner /></div>}
        {/* A lazily loaded page suspends here, so the frame and navigation stay on screen. */}
        <Suspense fallback={null}><Outlet /></Suspense>
        <TaxResidenceDialog />
      </div>
      {/* Floating "Ask AI" (only with the assistant on); the page keeps room below so it covers nothing at the end. */}
      <AssistantLauncher />
    </div>
  );
}
