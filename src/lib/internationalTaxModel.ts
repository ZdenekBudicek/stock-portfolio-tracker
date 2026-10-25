import type { DbTransaction } from "@/lib/portfolioTypes";
import type { DividendRecord } from "@/lib/dividendTax";
import { resolveTaxIdentity, type InstrumentRegistry } from "@/lib/instrumentRegistry";
import { parseStoredProfiles, profileKey } from "@/lib/taxProfiles";
import { buildTaxInput } from "@/lib/tax/appInput";
import { taxEngineFor, type Country, type TaxInput, type TaxReport } from "@/lib/tax/engines";
import type { TaxResidence } from "@/lib/tax/jurisdictions";

export interface InternationalTaxInput {
  transactions: DbTransaction[];
  dividends: DividendRecord[];
  registry: InstrumentRegistry;
  residence: TaxResidence;
  year: number;
  today: string;
  storedProfiles: unknown;
}

export type InternationalTaxModel = { status: "ready"; input: TaxInput; report: TaxReport }
  | { status: "missing_profile" | "unsupported" | "invalid"; reason: string };

export function computeInternationalTaxModel(data: InternationalTaxInput): InternationalTaxModel {
  if (!["SK", "PL", "DE", "GB", "US"].includes(data.residence)) {
    return { status: "unsupported", reason: "No international tax engine for this residence." };
  }
  if (![2024, 2025, 2026].includes(data.year)) {
    return { status: "invalid", reason: "Unsupported tax year." };
  }
  const country = data.residence as Country;
  const profile = parseStoredProfiles(data.storedProfiles)[profileKey(country, data.year)];
  if (!profile) return { status: "missing_profile", reason: "A valid profile for this residence and year is required." };
  try {
    const input = buildTaxInput({ ...data, profile, ...resolveTaxIdentity(data.registry) });
    return { status: "ready", input, report: taxEngineFor(country).report(input) };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : "Invalid tax input." };
  }
}
