import { useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { CompanyFundamentals } from '@/types/fundamentals';

interface FundamentalsRow {
  symbol: string;
  data: CompanyFundamentals;
  currency: string | null;
  fetched_at: string;
  status: 'ok' | 'error';
}

export function useCompanyFundamentals(symbol: string | null | undefined) {
  const ticker = (symbol ?? '').trim().toUpperCase();
  return useQuery({
    queryKey: ['company-fundamentals', ticker],
    enabled: !!ticker && ticker !== 'CASH',
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<CompanyFundamentals | null> => {
      // Match the worker's canonical row key, including aliases added after an import.
      const { data: alias, error: aliasError } = await supabase.from('ticker_alias')
        .select('canonical').ilike('alias', ticker.replace(/[\\%_]/g, '\\$&')).maybeSingle();
      if (aliasError) throw aliasError;
      const canonical = alias?.canonical?.trim().toUpperCase() || ticker;
      // The migration is new; keep its local row type until DB types are regenerated.
      const { data, error } = await (supabase as SupabaseClient).from('company_fundamentals')
        .select('symbol,data,currency,fetched_at,status').eq('symbol', canonical).maybeSingle();
      if (error) throw error;
      const row = data as FundamentalsRow | null;
      if (!row) return null;
      // A failed refresh retains the series and fetch time, but exposes its current status.
      return { ...row.data, symbol: row.symbol, currency: row.currency ?? row.data.currency, fetchedAt: row.fetched_at, status: row.status };
    },
  });
}
