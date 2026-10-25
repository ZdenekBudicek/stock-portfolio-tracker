// Read side of public.ticker_profiles — the shared, user-agnostic sector per instrument
// that sync-sectors (Finnhub, after every broker sync) and scripts/sector-worker.mjs
// (Yahoo, nightly) fill in. This replaces the hardcoded ~90-entry map in src/lib/sectors.ts
// as the PRIMARY source for the donut; that map stays as the offline fallback.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/hooks/usePortfolio";

import { buildProfileMap, type TickerProfileMap } from "@/lib/tickerProfileModel";
export { buildProfileMap, resolveSector, type TickerProfile, type TickerProfileMap } from "@/lib/tickerProfileModel";

// Sector profiles change slowly and are refreshed by the background sync jobs.
const PROFILES_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The whole table, keyed by UPPERCASE ticker. No WHERE clause on purpose: it holds one row
 * per instrument ANYONE has ever held (it is shared reference data, not per-user), which is
 * both why it is small enough to load whole and why there is no user column to filter on.
 * Paged like every other read in this app — PostgREST caps a select at 1000 rows and
 * returns the first page silently.
 */
export function useTickerProfiles() {
  return useQuery({
    queryKey: ["ticker-profiles"],
    queryFn: async (): Promise<TickerProfileMap> => {
      const [rows, aliases] = await Promise.all([
        fetchAllRows<{ ticker: string; sector: string | null }>((from, to) =>
          supabase.from("ticker_profiles").select("ticker,sector").order("ticker").range(from, to),
        ),
        fetchAllRows<{ alias: string; canonical: string }>((from, to) =>
          supabase.from("ticker_alias").select("alias,canonical").order("alias").range(from, to),
        ),
      ]);
      return buildProfileMap(rows, aliases);
    },
    staleTime: PROFILES_STALE_MS,
  });
}
