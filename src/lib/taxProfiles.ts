import { validateTaxProfile, type Country, type TaxProfile } from "@/lib/tax/engines";

export const profileKey = (country: Country, year: number): string => `${country}-${year}`;

export function parseStoredProfiles(raw: unknown): Record<string, TaxProfile> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return {};
  const out: Record<string, TaxProfile> = {};
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = validateTaxProfile(value);
    if (parsed.success && key === profileKey(parsed.data.residence, parsed.data.year)) {
      out[key] = parsed.data as TaxProfile;
    }
  }
  return out;
}
