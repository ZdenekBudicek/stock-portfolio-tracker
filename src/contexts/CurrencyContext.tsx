import { createContext, useContext, useState, type ReactNode } from 'react';
import { useLivePrices } from '@/hooks/usePortfolio';
import { currentLang } from '@/i18n';

type Currency = 'USD' | 'CZK';

interface CurrencyContextType {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  convert: (usd: number) => number;
  format: (usd: number) => string;
  /**
   * An amount known in BOTH currencies: USD mode shows `usd`, CZK mode shows `czk` as is —
   * for figures whose koruna value is not "USD × today's rate" (cost at the purchase-day
   * rate, profit including the currency move, history at each day's rate).
   */
  formatAt: (usd: number, czk: number) => string;
  /** The number `formatAt` would show, for signs, colours and sorting. */
  pick: (usd: number, czk: number) => number;
  symbol: string;
  rate: number;
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

const MASK = '••••';

export const CurrencyProvider = ({ children }: { children: ReactNode }) => {
  const [currency, setCurrency] = useState<Currency>('USD');
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem('amountsHidden') === '1'; } catch { return false; }
  });
  const { data } = useLivePrices();
  const rate = data?.usdCzk ?? 23;

  const convert = (usd: number) => currency === 'USD' ? usd : usd * rate;

  // Formats a value already in the active currency.
  const formatNative = (val: number) => {
    const en = currentLang() === 'en';
    if (hidden) return currency === 'USD' ? `$${MASK}` : en ? `CZK ${MASK}` : `${MASK} Kč`;
    const abs = Math.abs(val);
    if (currency === 'USD') {
      const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return val < 0 ? `-$${formatted}` : `$${formatted}`;
    } else {
      const formatted = abs.toLocaleString(en ? 'en-US' : 'cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      // EN: 'CZK 1,234'; CZ: '1 234 Kč'.
      if (en) return val < 0 ? `-CZK ${formatted}` : `CZK ${formatted}`;
      return val < 0 ? `-${formatted} Kč` : `${formatted} Kč`;
    }
  };
  const format = (usd: number) => formatNative(convert(usd));
  const pick = (usd: number, czk: number) => (currency === 'USD' ? usd : czk);
  const formatAt = (usd: number, czk: number) => formatNative(pick(usd, czk));

  const toggleHidden = () => setHidden((h) => {
    const next = !h;
    try { localStorage.setItem('amountsHidden', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, convert, format, formatAt, pick, symbol: currency === 'USD' ? '$' : currentLang() === 'en' ? 'CZK' : 'Kč', rate, hidden, toggleHidden }}>
      {children}
    </CurrencyContext.Provider>
  );
};
