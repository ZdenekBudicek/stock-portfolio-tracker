import { createContext, useContext, useState, type ReactNode } from 'react';
import { useLivePrices } from '@/hooks/usePortfolio';

type Currency = 'USD' | 'CZK';

interface CurrencyContextType {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  convert: (usd: number) => number;
  format: (usd: number) => string;
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

  const format = (usd: number) => {
    if (hidden) return currency === 'USD' ? `$${MASK}` : `${MASK} Kč`;
    const val = convert(usd);
    const abs = Math.abs(val);
    if (currency === 'USD') {
      const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return val < 0 ? `-$${formatted}` : `$${formatted}`;
    } else {
      const formatted = abs.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      return val < 0 ? `-${formatted} Kč` : `${formatted} Kč`;
    }
  };

  const toggleHidden = () => setHidden((h) => {
    const next = !h;
    try { localStorage.setItem('amountsHidden', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, convert, format, symbol: currency === 'USD' ? '$' : 'Kč', rate, hidden, toggleHidden }}>
      {children}
    </CurrencyContext.Provider>
  );
};
