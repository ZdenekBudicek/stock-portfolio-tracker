// Crypto or security for the tax report — resolved from the WHOLE instrument registry, not
// from what is held today. useComputedPortfolio() drops closed positions and dust, so a fully
// sold ETF named like a coin (NEAR, LTC, ATOM) would be reclassified as crypto after the sale
// and the Overview and the tax report would disagree. ticker_profiles and ticker_alias are
// shared reference data that outlive a sold position; positions adds the user's own types.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows, usePositions } from "@/hooks/usePortfolio";
import { kindResolverFrom, type AssetKindResolver } from "@/lib/czTax";

const REGISTRY_STALE_MS = 6 * 3600_000;

export function useAssetKindResolver(): AssetKindResolver {
  const { data: positions = [] } = usePositions();
  const { data: registry } = useQuery({
    queryKey: ["instrument-registry"],
    queryFn: async () => {
      const [aliases, profiles] = await Promise.all([
        fetchAllRows<{ alias: string; canonical: string; yahoo_symbol: string | null }>((from, to) =>
          supabase.from("ticker_alias").select("alias,canonical,yahoo_symbol").order("alias").range(from, to),
        ),
        fetchAllRows<{ ticker: string; asset_type: string }>((from, to) =>
          supabase.from("ticker_profiles").select("ticker,asset_type").order("ticker").range(from, to),
        ),
      ]);
      return { aliases, profiles };
    },
    staleTime: REGISTRY_STALE_MS,
  });
  return useMemo(
    () => kindResolverFrom({ positions, aliases: registry?.aliases, profiles: registry?.profiles }),
    [positions, registry],
  );
}
