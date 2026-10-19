import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLivePrices } from '@/hooks/usePortfolio';
import { useTaxResidence } from '@/hooks/useTaxResidence';
import { currentLang } from '@/i18n';
import { czkPer, formatMoney, localFx, wrapSymbol, symbolOf, type DisplayCurrency, type LocalCurrency, type LocalFx } from '@/lib/displayCurrency';

type Currency = DisplayCurrency;

interface CurrencyContextType {
  currency: Currency;
  /** Switches the shown currency for this session (the saved default is in Settings). */
  setCurrency: (c: Currency) => void;
  /** The user's saved default display currency. */
  defaultCurrency: Currency;
  /**
   * The non-USD currency the portfolio's "local" figures (the fields named …Czk) are computed
   * in: the shown currency, or the default one while dollars are shown.
   */
  local: LocalCurrency;
  /** Koruna → local conversion, per day and today. */
  fx: LocalFx;
  convert: (usd: number) => number;
  format: (usd: number) => string;
  /**
   * An amount known in BOTH currencies: USD mode shows `usd`, the local mode shows `local` as
   * is — for figures whose local value is not "USD × today's rate" (cost at the purchase-day
   * rate, profit including the currency move, history at each day's rate).
   */
  formatAt: (usd: number, local: number) => string;
  /** The number `formatAt` would show, for signs, colours and sorting. */
  pick: (usd: number, local: number) => number;
  /** Formats an amount already in the shown currency. */
  formatNative: (val: number) => string;
  symbol: string;
  /** Today's USD → shown currency (1 in USD). */
  rate: number;
  /** Today's USD → local currency. */
  usdLocal: number;
  /** Privacy/screen-share mode: mask money amounts (%s stay visible). */
  hidden: boolean;
  toggleHidden: () => void;
}

const CurrencyContext = createContext<CurrencyContextType | null>(null);

export const useCurrency = () => {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within CurrencyProvider');
  return ctx;
};

/** Like useCurrency, but CZK outside the provider (hooks shared with tests and tools). */
export const useLocalFxOptional = (): LocalFx => useContext(CurrencyContext)?.fx ?? CZK_FX;
const CZK_FX = localFx('CZK');

const MASK = '••••';

export const CurrencyProvider = ({ children }: { children: ReactNode }) => {
  const { baseCurrency } = useTaxResidence();
  const defaultCurrency = baseCurrency as Currency;
  const [chosen, setChosen] = useState<{ c: Currency; from: Currency } | null>(null);
  // A session switch holds until the saved default changes (then the new default applies).
  const currency: Currency = chosen && chosen.from === defaultCurrency ? chosen.c : defaultCurrency;
  const setCurrency = (c: Currency) => setChosen({ c, from: defaultCurrency });
  const local: LocalCurrency = currency !== 'USD' ? currency : defaultCurrency !== 'USD' ? defaultCurrency : 'CZK';

  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem('amountsHidden') === '1'; } catch { return false; }
  });
  const { data } = useLivePrices();
  const liveCzkPer = local === 'CZK' ? undefined : data?.fxCzk?.[local];
  const fx = useMemo(() => localFx(local, czkPer, liveCzkPer), [local, liveCzkPer]);
  const usdCzk = data?.usdCzk ?? 23;
  const usdLocal = usdCzk * fx.perCzkToday;
  const rate = currency === 'USD' ? 1 : usdLocal;
  const lang = currentLang() === 'en' ? 'en' : 'cs';

  const convert = (usd: number) => usd * rate;
  const formatNative = (val: number) => {
    if (hidden) return wrapSymbol(MASK, currency, lang);
    return formatMoney(val, currency, lang);
  };
  const format = (usd: number) => formatNative(convert(usd));
  const pick = (usd: number, loc: number) => (currency === 'USD' ? usd : loc);
  const formatAt = (usd: number, loc: number) => formatNative(pick(usd, loc));

  const toggleHidden = () => setHidden((h) => {
    const next = !h;
    try { localStorage.setItem('amountsHidden', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, defaultCurrency, local, fx, convert, format, formatAt, pick, formatNative, symbol: symbolOf(currency, lang), rate, usdLocal, hidden, toggleHidden }}>
      {children}
    </CurrencyContext.Provider>
  );
};
