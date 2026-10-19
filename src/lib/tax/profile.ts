import { z } from "zod";

const money = z.number().finite().nonnegative();
const signedMoney = z.number().finite();
export const taxYearSchema = z.union([z.literal(2024), z.literal(2025), z.literal(2026)]);
export const filingStatusSchema = z.enum(["single", "marriedJoint", "marriedSeparate", "headOfHousehold", "qualifyingSurvivingSpouse"]);
export type FilingStatus = z.infer<typeof filingStatusSchema>;
const base = { version: z.literal(1), year: taxYearSchema };
export const taxProfileSchema = z.discriminatedUnion("residence", [
  z.object({ ...base, residence: z.literal("US"), filingStatus: filingStatusSchema,
    // After deductions, before this portfolio. Negative = unused deductions (Schedule D worksheet).
    otherOrdinaryTaxableIncome: signedMoney, otherMagi: signedMoney, otherNetInvestmentIncome: money,
    shortTermLossCarry: money, longTermLossCarry: money,
    foreignTaxCreditLimit: money,
  }).strict(),
  z.object({ ...base, residence: z.literal("SK"), otherTaxableIncome: money,
    securitiesAllowanceRemaining: money.max(500), healthInsurance: z.enum(["standard", "disabled", "not-insured"]),
    deductibleHealthContributions: money,
  }).strict(),
  z.object({ ...base, residence: z.literal("DE"), otherTaxableIncome: money,
    jointAssessment: z.boolean(), churchTaxRate: z.union([z.literal(0), z.literal(0.08), z.literal(0.09)]),
    saverAllowanceUsed: money, stockLossCarry: money, generalLossCarry: money, privateLossCarry: money,
    otherPrivateDisposalNet: signedMoney,
  }).strict(),
  z.object({ ...base, residence: z.literal("GB"), otherTaxableIncome: money,
    unusedPersonalAllowance: money.max(12570), basicRateBand: money, higherRateBandEnd: money,
    lossCarry: money, annualExemptAmount: money.max(3000), dividendAllowanceRemaining: money.max(500),
  }).strict(),
  z.object({ ...base, residence: z.literal("PL"), otherSolidarityBase: money, cryptoCostCarry: money,
    securityLosses: z.array(z.object({ year: z.number().int().min(2019).max(2025), original: money,
      remaining: money, oneOffUsed: z.boolean() }).strict()),
  }).strict(),
]).superRefine((p, ctx) => {
  if (p.residence === "DE" && p.saverAllowanceUsed > (p.jointAssessment ? 2000 : 1000))
    ctx.addIssue({ code: "custom", path: ["saverAllowanceUsed"], message: "Allowance used exceeds statutory allowance" });
  if (p.residence === "GB" && p.higherRateBandEnd < p.basicRateBand)
    ctx.addIssue({ code: "custom", path: ["higherRateBandEnd"], message: "Invalid tax bands" });
  if (p.residence === "PL") {
    const years = new Set<number>();
    p.securityLosses.forEach((l, i) => {
      if (l.year >= p.year || l.remaining > l.original || years.has(l.year))
        ctx.addIssue({ code: "custom", path: ["securityLosses", i], message: "Invalid or duplicate loss vintage" });
      years.add(l.year);
    });
  }
});
// The application has strictNullChecks=false: Zod's inferred object keys otherwise appear optional.
type RequiredVariant<T> = T extends unknown ? Required<T> : never;
export type TaxProfile = RequiredVariant<z.infer<typeof taxProfileSchema>>;
export type Country = TaxProfile["residence"];
export type Profile<C extends Country> = Extract<TaxProfile, { residence: C }>;
/** No silent defaults for income, MAGI, loss balances or filing status. Safe for JSON from DB. */
export const validateTaxProfile = (value: unknown) => taxProfileSchema.safeParse(value);
export const parseTaxProfile = (value: unknown): TaxProfile => taxProfileSchema.parse(value) as TaxProfile;
