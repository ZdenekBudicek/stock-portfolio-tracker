// The user's tax residence and base currency (table user_settings) and the jurisdiction they
// select. A signed-in user without a row has never answered: the first-login dialog asks once.
//
// While the residence is unknown (still loading, or the read failed and no earlier answer is
// remembered) the app shows NO Czech tax output — a non-resident must never get Czech
// estimates, exemptions or alerts because of an outage. A failed read is retried (React
// Query, then every 30 s); the last known answer is kept per user in localStorage. Only a
// missing table (migration not applied yet) falls back to the Czech rules, as before.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { jurisdictionFor, OTHER, type BaseCurrency, type Jurisdiction, type TaxResidence } from "@/lib/tax/jurisdictions";
import { effectiveSettings, readLastSettings, settingsFromResponse, writeLastSettings, type UserSettings } from "@/lib/tax/userSettings";

const KEY = "user_settings";

export function useUserSettings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, user?.id ?? null],
    enabled: !!user,
    staleTime: Infinity,
    refetchInterval: (q) => (q.state.status === "error" ? 30_000 : false),
    queryFn: async (): Promise<UserSettings> =>
      settingsFromResponse(await supabase.from("user_settings").select("*").eq("user_id", user!.id)),
  });
}

export interface TaxResidenceState {
  /** null while unknown. */
  taxResidence: TaxResidence | null;
  baseCurrency: BaseCurrency;
  confirmed: boolean;
  available: boolean;
  /** The residence is known (fetched or remembered); false = show no country-specific tax output. */
  known: boolean;
  /** Applied rules: neutral (no Czech outputs) while unknown. */
  jurisdiction: Jurisdiction;
  isLoading: boolean;
  /** Unknown because the read failed (retrying). */
  isError: boolean;
  retry: () => void;
  needsOnboarding: boolean;
}

export function useTaxResidence(): TaxResidenceState {
  const { user } = useAuth();
  const q = useUserSettings();
  const s = effectiveSettings(q.data, readLastSettings(user?.id));
  useEffect(() => { if (q.data) writeLastSettings(user?.id, q.data); }, [q.data, user?.id]);
  return {
    taxResidence: s?.taxResidence ?? null,
    baseCurrency: s?.baseCurrency ?? "CZK",
    confirmed: s?.confirmed ?? false,
    available: s?.available ?? false,
    known: !!s,
    jurisdiction: s ? jurisdictionFor(s.taxResidence) : OTHER,
    isLoading: !s && !q.isError,
    isError: !s && q.isError,
    retry: () => { void q.refetch(); },
    needsOnboarding: !!q.data && q.data.available && !q.data.confirmed,
  };
}

/** Shortcut for components that only need the rules (neutral while unknown). */
export const useJurisdiction = () => useTaxResidence().jurisdiction;

export function useSaveUserSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { taxResidence: TaxResidence; baseCurrency: BaseCurrency }) => {
      const { error } = await supabase.from("user_settings").upsert(
        { user_id: user!.id, tax_residence: v.taxResidence, base_currency: v.baseCurrency, confirmed_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (error) throw error;
      return { ...v, confirmed: true, available: true } as UserSettings;
    },
    onSuccess: (s) => { writeLastSettings(user?.id, s); qc.setQueryData([KEY, user?.id ?? null], s); },
  });
}
