import { kindResolverFrom, type AssetKindResolver } from "@/lib/czTax";
import type { DbPosition } from "@/lib/portfolioTypes";
import type { AssetType } from "@/lib/tax/engines";

export interface InstrumentRegistry {
  positions: DbPosition[];
  aliases: { alias: string; canonical: string; yahoo_symbol: string | null }[];
  profiles: { ticker: string; asset_type: string; sector?: string | null }[];
}

export function createKindResolver(registry: InstrumentRegistry): AssetKindResolver {
  return kindResolverFrom(registry);
}

export function resolveTaxIdentity(registry: InstrumentRegistry): {
  kindOf: (ticker: string) => AssetType; canonical: (ticker: string) => string;
} {
  const kindResolver = createKindResolver(registry);
  const typeOf = new Map(registry.positions.map(p => [p.ticker, p.type ?? ""]));
  const profileType = new Map(registry.profiles.map(p => [p.ticker.toUpperCase(), p.asset_type ?? ""]));
  const alias = new Map(registry.aliases.map(a => [a.alias.toUpperCase(), (a.canonical || a.alias).toUpperCase()]));
  const canonical = (ticker: string) => alias.get(ticker.toUpperCase()) ?? ticker.toUpperCase();
  const kindOf = (ticker: string): AssetType => {
    if (kindResolver(ticker).kind === "crypto") return "crypto";
    const fund = /etf|fund/i;
    return fund.test(typeOf.get(ticker) ?? "") || fund.test(profileType.get(ticker.toUpperCase()) ?? "")
      || fund.test(profileType.get(canonical(ticker)) ?? "") ? "etf" : "stock";
  };
  return { kindOf, canonical };
}
