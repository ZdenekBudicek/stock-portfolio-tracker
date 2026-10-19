import type { TaxInput, TaxInstrument, TaxReport } from "./types";
import type { Profile } from "./profile";
import { start, finish, makeEngine, fifoRows, dividends, overYear, sum, positive, warn, inYear } from "./common";

// §32a EStG, final annual tariffs (BMF tariff history and current legislation).
const TARIFF = {
  2024: [11784, 17005, 66760, 954.80, 181.19, 991.21, 10636.31, 18971.06],
  2025: [12096, 17443, 68480, 932.30, 176.64, 1015.13, 10911.92, 19246.67],
  2026: [12348, 17799, 69878, 914.51, 173.10, 1034.87, 11135.63, 19470.38],
};
export function germanIncomeTax(income: number, year: 2024 | 2025 | 2026, joint = false): number {
  const factor = joint ? 2 : 1, x = Math.floor(positive(income) / factor);
  const [zero, first, second, a, b, c, d, e] = TARIFF[year];
  const y = (x - zero) / 10000, z = (x - first) / 10000;
  const tax = x <= zero ? 0 : x <= first ? (a * y + 1400) * y : x <= second ? (b * z + 2397) * z + c
    : x <= 277825 ? .42 * x - d : .45 * x - e;
  return Math.floor(tax) * factor;
}
export function germanSoli(tax: number, year: number, joint: boolean): number {
  const threshold = ({ 2024: 18130, 2025: 19950, 2026: 20350 }[year]!) * (joint ? 2 : 1);
  return Math.min(tax * .055, positive(tax - threshold) * .119);
}
function fraction(a: TaxInstrument, r: TaxReport, ticker: string) {
  if (a.kind !== "etf") return 1;
  const f = { equity: .7, mixed: .85, realEstate: .4, foreignRealEstate: .2, other: 1 }[a.deFundType!];
  if (f == null) warn(r, "fund-classification", "DE fund classification is required for partial exemption.", true, ticker);
  return f ?? 1;
}
export function buildDeReport(input: TaxInput) {
  const r = start(input, "DE", "EUR"), p = input.profile as Profile<"DE">;
  fifoRows(input, r); dividends(input, r);
  const buys = new Map(input.trades.filter(t => t.side === "BUY").map(t => [t.id, t]));
  for (const row of r.rows) {
    if (row.asset === "crypto") {
      row.classification = overYear(row.acquired!, row.sold) ? "private-over-one-year" : "private-disposal";
      if (row.classification === "private-over-one-year") { row.exemptGain = row.gain ?? 0; row.taxableGain = 0; }
    } else {
      if (row.acquired! < "2009-01-01") warn(r, "legacy-security", "Pre-2009 security rules are outside this engine.", true, row.buyId!);
      const f = fraction(input.instruments[row.ticker], r, row.ticker), buy = buys.get(row.buyId!)!;
      if (row.asset === "etf" && buy.taxDate < "2018-01-01") warn(r, "legacy-fund", "Pre-2018 deemed sale and transition allowances need normalized basis.", true, buy.id);
      if (row.gain != null) {
        const adjustment = row.asset === "etf" ? (buy.priorFundIncome ?? 0) * row.shares / buy.shares : 0;
        row.taxableGain = (row.gain - adjustment) * f;
        row.exemptGain = (row.gain - adjustment) * (1 - f);
      }
      row.classification = row.asset === "stock" ? "stock-capital" : "fund-partial-exemption";
    }
  }
  for (const d of r.dividends) d.taxable = d.gross == null ? null : d.gross * fraction(input.instruments[d.ticker], r, d.ticker);
  const deemed = sum((input.fundIncome ?? []).filter(f => inYear(r, f.taxDate)), f => f.amount * fraction(input.instruments[f.ticker], r, f.ticker));
  const stock = sum(r.rows.filter(x => x.asset === "stock"), x => x.taxableGain ?? 0) - p.stockLossCarry;
  // Stock losses offset stock gains ONLY. General losses may offset both stocks and distributions.
  const general = sum(r.rows.filter(x => x.asset === "etf"), x => x.taxableGain ?? 0)
    + sum(r.dividends, d => d.taxable ?? 0) + deemed - p.generalLossCarry;
  const capitalNet = positive(stock) + general;
  const allowance = Math.min(positive(capitalNet), (p.jointAssessment ? 2000 : 1000) - p.saverAllowanceUsed);
  const capitalBase = positive(capitalNet - allowance);
  let creditRemaining = capitalBase / 4;
  for (const d of r.dividends) {
    // §32d(5): actual foreign tax, treaty ceiling, max 25% of the eligible foreign income.
    d.credit = Math.min(d.withheld ?? 0, d.creditLimit, (d.taxable ?? 0) * .25, creditRemaining);
    creditRemaining -= d.credit;
  }
  const credit = sum(r.dividends, d => d.credit), k = p.churchTaxRate;
  const capitalIncomeTax = positive(capitalBase - 4 * credit) / (4 + k);
  const capitalTax = capitalIncomeTax * (1 + .055 + k);
  const rawPrivate = sum(r.rows.filter(x => x.asset === "crypto"), x => x.taxableGain ?? 0) + p.otherPrivateDisposalNet;
  // Freigrenze, not allowance; test current-year total BEFORE carried losses.
  const privateBase = rawPrivate < 1000 ? 0 : positive(rawPrivate - p.privateLossCarry);
  const privateCarry = p.privateLossCarry + positive(-rawPrivate) - (rawPrivate >= 1000 ? Math.min(p.privateLossCarry, rawPrivate) : 0);
  const beforeTax = germanIncomeTax(p.otherTaxableIncome, p.year, p.jointAssessment);
  const afterTax = germanIncomeTax(p.otherTaxableIncome + privateBase, p.year, p.jointAssessment);
  const privateTax = afterTax - beforeTax;
  const privateSoli = germanSoli(afterTax, p.year, p.jointAssessment) - germanSoli(beforeTax, p.year, p.jointAssessment);
  const privateChurch = privateTax * k;
  r.carryforward = { stockLoss: positive(-stock), generalLoss: positive(-capitalNet), privateLoss: privateCarry };
  r.taxableBase = capitalBase + privateBase;
  r.foreignTaxCredit = credit;
  r.taxBeforeCredit = capitalBase / (4 + k) * (1 + .055 + k) + privateTax + privateSoli + privateChurch;
  r.estimatedTax = capitalTax + privateTax + privateSoli + privateChurch;
  r.breakdown = { stockNet: stock, generalNet: general, saverAllowance: allowance, capitalBase, deemedFundIncome: deemed,
    capitalIncomeTax, capitalSoli: capitalIncomeTax * .055, capitalChurch: capitalIncomeTax * k, privateNet: rawPrivate,
    privateBase, privateTax, privateSoli, privateChurch };
  warn(r, "de-scope", "No automatic Vorabpauschale calculation, Günstigerprüfung, loss carryback, church-tax deduction feedback, old investment regime or inter-bank loss certificate processing. Supply assessed fund income and reconciled loss pots.");
  return finish(r);
}
export const DE_ENGINE = makeEngine("DE", buildDeReport);
