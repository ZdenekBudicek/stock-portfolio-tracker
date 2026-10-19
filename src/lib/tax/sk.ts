import type { TaxInput } from "./types";
import type { Profile } from "./profile";
import { start, finish, makeEngine, fifoRows, dividends, overYear, sum, positive, progressive, warn } from "./common";

// §15 ZDP; FS SR rate tables for 2024, 2025, 2026 (links in docs/TAX_JURISDICTIONS.md).
export const SK_BANDS = { 2024: [47537.98], 2025: [48441.43], 2026: [43983.32, 60349.21, 75010.32] };
export function buildSkReport(input: TaxInput) {
  const r = start(input, "SK", "EUR"), p = input.profile as Profile<"SK">;
  fifoRows(input, r); dividends(input, r);
  for (const row of r.rows) {
    const asset = input.instruments[row.ticker];
    if (row.asset === "crypto") { row.classification = "crypto-section-8"; continue; }
    if (asset.regulatedMarketSince === undefined) warn(r, "market-status", "Confirm regulated-market admission date or explicitly null.", true, row.ticker);
    if (row.acquired! < "2011-01-01") warn(r, "legacy-security", "Pre-2011 acquisition exemptions need separate assessment.", true, row.buyId!);
    if (asset.regulatedMarketSince && overYear(row.acquired!, row.sold) && overYear(asset.regulatedMarketSince, row.sold)) {
      row.classification = "regulated-market-one-year"; row.exemptGain = row.gain ?? 0; row.taxableGain = 0;
    } else row.classification = "security-section-8";
  }
  const securityNet = sum(r.rows.filter(x => x.asset !== "crypto"), x => x.taxableGain ?? 0);
  const cryptoNet = sum(r.rows.filter(x => x.asset === "crypto"), x => x.taxableGain ?? 0);
  const allowance = Math.min(p.securitiesAllowanceRemaining, positive(securityNet));
  const section8 = positive(securityNet - allowance) + positive(cryptoNet);
  const base = positive(section8 - p.deductibleHealthContributions);
  const rates = p.year === 2026 ? [.19, .25, .30, .35] : [.19, .25];
  const saleTax = progressive(p.otherTaxableIncome + base, SK_BANDS[p.year], rates) - progressive(p.otherTaxableIncome, SK_BANDS[p.year], rates);
  let dividendTax = 0, fundBase = 0;
  for (const d of r.dividends) {
    let rate = 0;
    if (d.skCategory === "fund") { rate = .19; fundBase += d.gross ?? 0; }
    else if (d.skCategory === "non-treaty") rate = .35;
    else if (d.skCategory === "corporate" && Number.isInteger(d.profitYear) && d.profitYear! >= 2017 && d.profitYear! <= p.year) rate = d.profitYear === 2024 ? .10 : .07;
    else warn(r, "dividend-period", "Provide corporate profit year (2017+) and legal category; payment year is insufficient.", true, d.id);
    const tax = (d.gross ?? 0) * rate;
    d.credit = Math.min(d.withheld ?? 0, d.creditLimit, tax);
    dividendTax += tax;
  }
  const healthRate = p.healthInsurance === "not-insured" ? 0 : (p.year === 2026 ? .16 : .15) / (p.healthInsurance === "disabled" ? 2 : 1);
  r.taxableBase = base + sum(r.dividends, d => d.taxable ?? 0);
  r.taxBeforeCredit = saleTax + dividendTax;
  r.foreignTaxCredit = sum(r.dividends, d => d.credit);
  r.estimatedTax = r.taxBeforeCredit - r.foreignTaxCredit;
  r.healthContributions = (base + fundBase) * healthRate;
  r.breakdown = { securityNet, cryptoNet, securitiesAllowance: allowance, section8Base: base, saleTax, dividendTax, healthRate };
  warn(r, "sk-scope", "FIFO is an explicitly selected identification convention. Excludes business assets, DIS, legacy securities and special fund redemptions. Health estimate is separate; actual paid deductible contributions must be supplied.");
  return finish(r);
}
export const SK_ENGINE = makeEngine("SK", buildSkReport);
