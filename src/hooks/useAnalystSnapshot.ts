import { useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { MarketContext } from '@/lib/fairValue';

interface SnapshotData {
  targetMean?: number | null; targetLow?: number | null; targetHigh?: number | null; currency?: string | null;
  estimates?: MarketContext['estimates']; estimatesCurrency?: string | null;
  counts?: Record<string, number | null>;
}

/** Analyst targets and consensus estimates the nightly worker stores (scripts/analyst-worker.mjs) for the
 * valuation (Ocenění v2). Missing or unreadable data is not an error: the valuation then runs without them. */
export function useAnalystSnapshot(symbol: string | null | undefined) {
  const ticker = (symbol ?? '').trim().toUpperCase();
  return useQuery({
    queryKey: ['analyst-snapshot', ticker],
    enabled: !!ticker && ticker !== 'CASH',
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<MarketContext | null> => {
      const { data: alias } = await supabase.from('ticker_alias')
        .select('canonical').ilike('alias', ticker.replace(/[\\%_]/g, '\\$&')).maybeSingle();
      const canonical = alias?.canonical?.trim().toUpperCase() || ticker;
      // Not in the generated DB types yet (agent migration), like company_fundamentals.
      const { data, error } = await (supabase as SupabaseClient).from('analyst_snapshots')
        .select('data,status').eq('symbol', canonical).maybeSingle();
      const row = data as { data: SnapshotData | null; status: string } | null;
      if (error || !row?.data) return null;
      const d = row.data;
      return {
        estimates: Array.isArray(d.estimates) ? d.estimates : null, estimatesCurrency: d.estimatesCurrency ?? null,
        targetMean: d.targetMean ?? null, targetLow: d.targetLow ?? null, targetHigh: d.targetHigh ?? null, targetCurrency: d.currency ?? null,
        analystCount: Object.values(d.counts ?? {}).reduce<number>((sum, n) => sum + (typeof n === 'number' ? n : 0), 0) || null,
        asOf: new Date().toISOString().slice(0, 10),
      };
    },
  });
}
