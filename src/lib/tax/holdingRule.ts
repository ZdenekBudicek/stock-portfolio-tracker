// The holding-period rule of the user's tax residence for one asset kind, for the stock and
// crypto detail card. The dates come from the engines themselves (czTax time test, the
// "more than one year" test of the international engines), so the card and the tax report
// never disagree about a lot.
//
//  - CZ: securities and crypto tax-free after more than 3 years (§ 4 odst. 1 písm. w ZDP;
//    crypto only for sales from 15. 2. 2025 — every sale from today on qualifies).
//  - DE: crypto tax-free after more than 1 year (§ 23 EStG); stocks/ETFs fall under the
//    Abgeltungsteuer with no holding exemption.
//  - SK: securities on a regulated market tax-free after more than 1 year (the engine
//    assumes a regulated market); crypto has no exemption (§ 8 other income).
//  - US: no tax-free period, only the rate changes: long-term after more than 1 year.
//  - GB, PL, OTHER: no holding-period rule.
import { timeTestExemptFrom, type AssetKind } from "@/lib/czTax";
import { overYearFrom } from "./common";
import type { TaxResidence } from "./jurisdictions";

export interface HoldingRule {
  /** 'exempt' = the gain becomes tax-free; 'long-term' = only a lower rate applies. */
  effect: "exempt" | "long-term";
  /** Lots held longer than this qualify. */
  years: number;
  /** First day a lot bought on `acquired` (YYYY-MM-DD) qualifies. */
  qualifiesFrom(acquired: string): string;
}

const CZ_RULE: HoldingRule = { effect: "exempt", years: 3, qualifiesFrom: timeTestExemptFrom };
const ONE_YEAR_EXEMPT: HoldingRule = { effect: "exempt", years: 1, qualifiesFrom: overYearFrom };
const US_LONG_TERM: HoldingRule = { effect: "long-term", years: 1, qualifiesFrom: overYearFrom };

/** The rule for this residence and asset kind; null = no holding-period rule (show "held since"). */
export function holdingRuleFor(residence: TaxResidence, kind: AssetKind): HoldingRule | null {
  switch (residence) {
    case "CZ": return CZ_RULE;
    case "DE": return kind === "crypto" ? ONE_YEAR_EXEMPT : null;
    case "SK": return kind === "security" ? ONE_YEAR_EXEMPT : null;
    case "US": return US_LONG_TERM;
    default: return null;
  }
}

export interface HoldingProgress {
  heldShares: number;
  /** Shares whose lot already qualifies (tax-free or long-term). */
  qualifiedShares: number;
  /** 0–100. */
  qualifiedPct: number;
  /** Earliest date a not-yet-qualified lot qualifies; null when all do. */
  next: string | null;
}

/** How far the open lots of one position are under the rule today. */
export function holdingProgress(
  lots: readonly { shares: number; acquiredDate: string }[],
  rule: HoldingRule,
  today: string,
): HoldingProgress {
  let heldShares = 0, qualifiedShares = 0, next: string | null = null;
  for (const l of lots) {
    const from = rule.qualifiesFrom(l.acquiredDate);
    heldShares += l.shares;
    if (today >= from) qualifiedShares += l.shares;
    else if (next == null || from < next) next = from;
  }
  return { heldShares, qualifiedShares, qualifiedPct: heldShares > 0 ? (qualifiedShares / heldShares) * 100 : 0, next };
}
