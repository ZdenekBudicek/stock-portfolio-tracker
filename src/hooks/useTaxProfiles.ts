// Yearly tax profiles (inputs a country's estimate needs beyond the trades: US filing status
// and other income, German church tax …), stored with the user in user_settings.tax_profile:
//   { "profiles": { "US-2025": { …validated profile… }, "US-2026": { … } } }
// One entry per country and year — a 2026 profile never overwrites 2025's, because income and
// loss carry-forwards change between years.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { validateTaxProfile, type Country, type TaxProfile } from "@/lib/tax/engines";

const KEY = "tax-profiles";
export const profileKey = (country: Country, year: number) => `${country}-${year}`;
type Stored = { profiles?: Record<string, unknown> };

export function useTaxProfiles() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, user?.id ?? null],
    enabled: !!user,
    queryFn: async (): Promise<Record<string, TaxProfile>> => {
      const { data, error } = await (supabase as any).from("user_settings").select("tax_profile").eq("user_id", user!.id).maybeSingle();
      if (error) throw error;
      const raw = ((data?.tax_profile ?? {}) as Stored).profiles ?? {};
      const out: Record<string, TaxProfile> = {};
      for (const [k, v] of Object.entries(raw)) {
        const parsed = validateTaxProfile(v);
        if (parsed.success) out[k] = parsed.data as TaxProfile; // an invalid stored entry is ignored, not trusted
      }
      return out;
    },
  });
}

export function useSaveTaxProfile() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profile: TaxProfile) => {
      const { data, error: readError } = await (supabase as any).from("user_settings").select("tax_profile").eq("user_id", user!.id).maybeSingle();
      if (readError) throw readError;
      const current = ((data?.tax_profile ?? {}) as Stored).profiles ?? {};
      // Other root keys of tax_profile are kept; only this country+year entry changes.
      const next = { ...((data?.tax_profile ?? {}) as Record<string, unknown>), profiles: { ...current, [profileKey(profile.residence, profile.year)]: profile } };
      const { error } = await (supabase as any).from("user_settings").update({ tax_profile: next }).eq("user_id", user!.id);
      if (error) throw error;
      return profile;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
