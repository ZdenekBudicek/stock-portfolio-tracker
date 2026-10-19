import type { FifoTx } from "@/lib/fifo";
import type { Country, TaxProfile } from "./profile";

export type TaxCurrency = "USD" | "EUR" | "GBP" | "PLN";
export type AssetType = "stock" | "etf" | "crypto";
export interface TaxInstrument {
  kind: AssetType;
  /** Stable security identifier (ISIN/share class); aliases must be normalized before import. */
  assetId: string;
  /** US substantially identical group; defaults to assetId. Include all taxpayer accounts. */
  washGroup?: string;
  /** SK: null explicitly means not admitted to a qualifying regulated market. */
  regulatedMarketSince?: string | null;
  /** DE: legal fund classification, not inferred from the ticker. */
  deFundType?: "equity" | "mixed" | "realEstate" | "foreignRealEstate" | "other";
  /** GB: offshore reporting status throughout ownership; false is outside this CGT engine. */
  ukReportingFund?: boolean;
}
export interface TaxTrade extends FifoTx {
  /** Mandatory broker tax trade date, not a UTC date guessed from executed_at. */
  taxDate: string;
  accountType?: "taxable" | "ira" | "sheltered";
  /** US documented specific identification, shares from each original buy; otherwise FIFO. */
  lots?: { buyId: string; shares: number }[];
  /** PL: crypto-to-crypto exchanges are neutral. Both legs must be marked. */
  cryptoExchange?: boolean;
  /** DE prior assessed Vorabpauschalen / GB accumulated ERI, TOTAL for this buy lot, local currency. */
  priorFundIncome?: number;
}
export interface TaxDividend {
  id: string; ticker: string; taxDate: string;
  grossUsd: number; withholdingUsd: number;
  /** Legal treaty / domestic credit ceiling in report currency, verified by caller (0 if none). */
  creditLimit: number;
  qualified?: boolean;
  /** SK corporate profit period, not payment year. */
  profitYear?: number;
  skCategory?: "corporate" | "fund" | "non-treaty";
}
export interface FundIncome {
  id: string; ticker: string; taxDate: string;
  /** DE assessed Vorabpauschale or GB excess reportable income, BEFORE partial exemption. */
  amount: number;
}
export interface FxQuote { rate: number; ref: string; source: string; statutory: boolean }
export type FxProvider = (date: string, currency: TaxCurrency) => FxQuote | null;
export interface TaxInput {
  profile: TaxProfile;
  trades: readonly TaxTrade[];
  instruments: Readonly<Record<string, TaxInstrument>>;
  dividends: readonly TaxDividend[];
  fundIncome?: readonly FundIncome[];
  /** Confirmed full ledger horizon including transactions AFTER year end (US/GB +30 days). */
  completeThrough: string;
  /** Explicit confirmation that fund deemed income and buy-lot basis adjustments are supplied, including zeros. */
  fundDataComplete?: boolean;
  fx?: FxProvider;
  /**
   * A running estimate for a year whose ledger is not closed yet (the current year): the
   * incomplete-ledger warning is still reported, but it does not blank the totals.
   */
  provisional?: boolean;
}
export interface TaxWarning { code: string; message: string; blocking: boolean; ref?: string }
export interface TaxSaleRow {
  sellId: string; buyId: string | null; ticker: string; asset: AssetType;
  acquired: string | null; sold: string; shares: number;
  proceeds: number | null; cost: number | null; fees: number | null; gain: number | null;
  classification: string; exemptGain: number; taxableGain: number | null;
  washDisallowed: number; fxRefs: string[];
}
export interface TaxDividendRow extends TaxDividend {
  gross: number | null; withheld: number | null; taxable: number | null; credit: number;
}
export interface TaxOpenLot {
  buyId: string; ticker: string; account: string; shares: number;
  acquired: string; holdingDate: string; cost: number; washBasis: number;
}
export interface TaxReport {
  residence: Country; year: number; currency: TaxCurrency; period: { from: string; to: string };
  rows: TaxSaleRow[]; dividends: TaxDividendRow[]; openLots: TaxOpenLot[];
  taxableBase: number | null;
  /** Incremental income tax + surtaxes, after foreign credit; can be negative (US loss tax benefit). */
  estimatedTax: number | null;
  taxBeforeCredit: number | null; foreignTaxCredit: number;
  healthContributions: number | null;
  carryforward: Record<string, number>;
  polishLossCarry?: { year: number; original: number; remaining: number; oneOffUsed: boolean }[];
  breakdown: Record<string, number>;
  warnings: TaxWarning[];
  /** All required data present; NOT a promise that this is a complete personal tax return. */
  complete: boolean; fxMode: "usd" | "statutory" | "cnb-estimate";
}
export interface SaleScenario {
  trade: TaxTrade;
  /** Explicit future USD→local rate, only for the hypothetical sale day. */
  assumedFx?: number;
}
export interface TaxSimulation { before: TaxReport; after: TaxReport; taxDelta: number | null }
export interface TaxEngine {
  residence: Country;
  report(input: TaxInput): TaxReport;
  simulate(input: TaxInput, scenario: SaleScenario): TaxSimulation;
}
