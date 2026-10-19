import type { Country } from "./profile";
import type { TaxEngine } from "./types";
import { US_ENGINE } from "./us";
import { SK_ENGINE } from "./sk";
import { DE_ENGINE } from "./de";
import { GB_ENGINE } from "./gb";
import { PL_ENGINE } from "./pl";

export const TAX_ENGINES: Readonly<Record<Country, TaxEngine>> = { US: US_ENGINE, SK: SK_ENGINE, DE: DE_ENGINE, GB: GB_ENGINE, PL: PL_ENGINE };
export const taxEngineFor = (country: Country): TaxEngine => {
  const engine = TAX_ENGINES[country];
  if (!engine) throw new Error(`No international tax engine for ${country}`);
  return engine;
};
export type * from "./types";
export { parseTaxProfile, validateTaxProfile } from "./profile";
export type { TaxProfile, Country, Profile } from "./profile";
