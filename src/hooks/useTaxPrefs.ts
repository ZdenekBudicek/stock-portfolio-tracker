// Default tax calculation choices (exchange-rate method, what the 100 000 Kč limit counts).
// They are a viewing preference of this device, chosen in Settings and used as the starting
// values on the Taxes screen (which can still switch them for one look).
import { useCallback, useState } from 'react';
import type { FxMethod } from '@/lib/cnbRates';

export interface TaxPrefs { fxMethod: FxMethod; limitIncludesExempt: boolean }
const KEY = 'trackora.taxPrefs';
export const DEFAULT_TAX_PREFS: TaxPrefs = { fxMethod: 'cnb-daily', limitIncludesExempt: true };

export function readTaxPrefs(): TaxPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return {
      fxMethod: v?.fxMethod === 'gfr-annual' || v?.fxMethod === 'cnb-daily' ? v.fxMethod : DEFAULT_TAX_PREFS.fxMethod,
      limitIncludesExempt: typeof v?.limitIncludesExempt === 'boolean' ? v.limitIncludesExempt : DEFAULT_TAX_PREFS.limitIncludesExempt,
    };
  } catch { return DEFAULT_TAX_PREFS; }
}

export function useTaxPrefs() {
  const [prefs, setPrefs] = useState<TaxPrefs>(readTaxPrefs);
  const update = useCallback((patch: Partial<TaxPrefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: this session only */ }
      return next;
    });
  }, []);
  return [prefs, update] as const;
}
