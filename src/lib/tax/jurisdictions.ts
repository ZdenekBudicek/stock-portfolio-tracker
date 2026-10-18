// Which tax rules apply to a user — chosen by their tax residence (user_settings), never by
// the UI language.
//
// A jurisdiction is a set of capability flags (what the UI may show) plus per-year rules.
// 'CZ' wraps the existing Czech engine (czTax, saleSimulation, dividendTax) unchanged: it
// only points at it, so every Czech number stays exactly what it was. 'OTHER' has no
// exemptions, no limit and no tax estimate — the app shows realized gains/losses and
// dividends per year (src/lib/tax/realized.ts) and says that the user's country's rules are
// not supported. A new country is one more entry here plus its own engine.
import { buildSalesReport, isTimeTestExempt, SALE_INCOME_LIMIT_CZK, TAX_RATE, timeTestExemptFrom } from "@/lib/czTax";
import { simulateSale } from "@/lib/saleSimulation";
import { ASSUMED_WHT_RATE, buildDividendReport, CREDIT_CAP_RATE } from "@/lib/dividendTax";

/** Supported jurisdictions by ISO 3166-1 alpha-2, or 'OTHER' for everyone else. */
export type TaxResidence = "CZ" | "OTHER";
export const TAX_RESIDENCES: readonly TaxResidence[] = ["CZ", "OTHER"];

export type BaseCurrency = "USD" | "CZK";
export const BASE_CURRENCIES: readonly BaseCurrency[] = ["CZK", "USD"];

export interface JurisdictionCaps {
  /** A tax estimate (Taxes page, Overview tax card, simulator tax delta, tax-limit alert). */
  taxEstimate: boolean;
  /** Lots become tax-free after a holding period (exempt calendar, "tax-free" KPI, lot info, exempt alerts). */
  holdingExemption: boolean;
  /** Yearly proceeds below a limit are exempt (limit card, limit alert). */
  annualProceedsLimit: boolean;
  /** Dividend tax with a foreign-withholding credit. */
  dividendTaxCredit: boolean;
  /** The full tax-return report (TaxReport) and its CSV exports. */
  taxReport: boolean;
}

export interface YearRules {
  year: number;
  /** Lots held longer than this are exempt; null = no holding-period exemption. */
  holdingPeriodYears: number | null;
  /** Gross yearly proceeds up to this amount are exempt; null = no limit. */
  annualProceedsLimit: { amount: number; currency: "CZK" } | null;
  /** Flat rate on the taxable gain; null = no estimate. */
  capitalGainsRate: number | null;
  /** Withholding assumed when a broker reports only one side of a dividend; null = none assumed. */
  dividendWithholdingDefault: number | null;
  /** Cap on the creditable foreign withholding; null = no credit computed. */
  dividendCreditCap: number | null;
}

export interface Jurisdiction {
  code: TaxResidence;
  caps: JurisdictionCaps;
  /** Where exchange rates for tax amounts come from; null = no official source applied. */
  fxSource: "cnb" | null;
  /** How sold shares are matched to purchases. */
  lotMethod: "fifo-per-account";
  rulesFor(year: number): YearRules;
  /** First day a lot bought on `acquired` (YYYY-MM-DD) is exempt; null without a holding exemption. */
  exemptFrom(acquired: string): string | null;
  isHoldingExempt(acquired: string, sold: string): boolean;
  /** The jurisdiction's own engine; null for the neutral view. */
  engine: CzEngine | null;
}

/** The existing Czech calculations, referenced as they are. */
export interface CzEngine {
  buildSalesReport: typeof buildSalesReport;
  simulateSale: typeof simulateSale;
  buildDividendReport: typeof buildDividendReport;
}

const NO_CAPS: JurisdictionCaps = { taxEstimate: false, holdingExemption: false, annualProceedsLimit: false, dividendTaxCredit: false, taxReport: false };

export const CZ: Jurisdiction = {
  code: "CZ",
  caps: { taxEstimate: true, holdingExemption: true, annualProceedsLimit: true, dividendTaxCredit: true, taxReport: true },
  fxSource: "cnb",
  lotMethod: "fifo-per-account",
  rulesFor: (year) => ({
    year,
    holdingPeriodYears: 3,
    annualProceedsLimit: { amount: SALE_INCOME_LIMIT_CZK, currency: "CZK" },
    capitalGainsRate: TAX_RATE,
    dividendWithholdingDefault: ASSUMED_WHT_RATE,
    dividendCreditCap: CREDIT_CAP_RATE,
  }),
  exemptFrom: timeTestExemptFrom,
  isHoldingExempt: isTimeTestExempt,
  engine: { buildSalesReport, simulateSale, buildDividendReport },
};

export const OTHER: Jurisdiction = {
  code: "OTHER",
  caps: NO_CAPS,
  fxSource: null,
  lotMethod: "fifo-per-account",
  rulesFor: (year) => ({
    year, holdingPeriodYears: null, annualProceedsLimit: null, capitalGainsRate: null,
    dividendWithholdingDefault: null, dividendCreditCap: null,
  }),
  exemptFrom: () => null,
  isHoldingExempt: () => false,
  engine: null,
};

const BY_CODE: Record<TaxResidence, Jurisdiction> = { CZ, OTHER };

/** Normalises a stored value: a supported code, anything else (another country, junk) → 'OTHER'. */
export function normalizeResidence(raw: string | null | undefined): TaxResidence {
  const v = String(raw ?? "").trim().toUpperCase();
  return (TAX_RESIDENCES as readonly string[]).includes(v) ? (v as TaxResidence) : "OTHER";
}

export const normalizeBaseCurrency = (raw: string | null | undefined): BaseCurrency =>
  String(raw ?? "").toUpperCase() === "USD" ? "USD" : "CZK";

export function jurisdictionFor(residence: string | null | undefined): Jurisdiction {
  return BY_CODE[normalizeResidence(residence)];
}
