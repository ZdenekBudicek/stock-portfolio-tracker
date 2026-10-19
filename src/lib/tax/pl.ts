import type { Profile } from "./profile";
import type { TaxInput } from "./types";
import { start, finish, makeEngine, fifoRows, dividends, quote, sum, positive, inYear, warn } from "./common";

/** PIT art. 9(3),11a,22(14–16),30a,30b,30h. Crypto uses ANNUAL costs, never FIFO gain. */
export function buildPlReport(input: TaxInput) {
  const r = start(input, "PL", "PLN"), p = input.profile as Profile<"PL">;
  fifoRows({ ...input, trades: input.trades.filter(t => input.instruments[t.ticker].kind !== "crypto") }, r);
  dividends(input, r);
  const securityNet = sum(r.rows, x => x.gain ?? 0);
  let securityBase = positive(securityNet), lossUsed = 0;
  r.polishLossCarry = [];
  for (const l of [...p.securityLosses].sort((a, b) => a.year - b.year)) {
    if (p.year - l.year > 5) continue;
    const cap = l.oneOffUsed ? l.original / 2 : Math.max(5000000, l.original / 2);
    const used = Math.min(securityBase, l.remaining, cap);
    securityBase -= used; lossUsed += used;
    if (l.remaining > used && p.year - l.year < 5) r.polishLossCarry.push({ year: l.year, original: l.original, remaining: l.remaining - used,
      oneOffUsed: l.oneOffUsed || used > l.original / 2 });
  }
  if (securityNet < 0) r.polishLossCarry.push({ year: p.year, original: -securityNet, remaining: -securityNet, oneOffUsed: false });
  let cryptoProceeds = 0, cryptoCosts = p.cryptoCostCarry;
  for (const t of input.trades.filter(t => input.instruments[t.ticker].kind === "crypto" && inYear(r, t.taxDate)
    && (t.accountType ?? "taxable") === "taxable")) {
    if (t.cryptoExchange) continue;
    const q = quote(input, r, t.taxDate);
    if (t.side === "BUY") { if (q) cryptoCosts += (t.shares * t.price_usd + (t.fee_usd ?? 0)) * q.rate; }
    else {
      if (q) { cryptoProceeds += t.shares * t.price_usd * q.rate; cryptoCosts += (t.fee_usd ?? 0) * q.rate; }
      r.rows.push({ sellId: t.id, buyId: null, ticker: t.ticker, asset: "crypto", acquired: null, sold: t.taxDate,
        shares: t.shares, proceeds: q ? t.shares * t.price_usd * q.rate : null, fees: q ? (t.fee_usd ?? 0) * q.rate : null,
        cost: null, gain: null, taxableGain: null, exemptGain: 0, washDisallowed: 0,
        classification: "crypto-annual-cost-pool", fxRefs: q ? [`${q.source}:${q.ref}`] : [] });
    }
  }
  const cryptoBase = positive(cryptoProceeds - cryptoCosts);
  let dividendTax = 0;
  for (const d of r.dividends) {
    const tax = (d.gross ?? 0) * .19;
    d.credit = Math.min(d.withheld ?? 0, d.creditLimit, tax); dividendTax += tax;
  }
  const solidarity = .04 * (positive(p.otherSolidarityBase + securityBase + cryptoBase - 1000000) - positive(p.otherSolidarityBase - 1000000));
  r.carryforward = { securityLoss: sum(r.polishLossCarry, l => l.remaining), cryptoCosts: positive(cryptoCosts - cryptoProceeds) };
  r.taxableBase = securityBase + cryptoBase + sum(r.dividends, d => d.taxable ?? 0);
  r.taxBeforeCredit = (securityBase + cryptoBase) * .19 + dividendTax + solidarity;
  r.foreignTaxCredit = sum(r.dividends, d => d.credit);
  r.estimatedTax = r.taxBeforeCredit - r.foreignTaxCredit;
  r.breakdown = { securityNet, securityBase, securityLossUsed: lossUsed, cryptoProceeds, cryptoCosts, cryptoBase, dividendTax, solidarity };
  warn(r, "pl-scope", "Use prior-business-day NBP FX for filing. Crypto costs must include all eligible purchases, including unsold assets; carry unused costs from prior PIT-38. No IKE/IKZE, IPO exemption or business activity.");
  return finish(r);
}
export const PL_ENGINE = makeEngine("PL", buildPlReport);
