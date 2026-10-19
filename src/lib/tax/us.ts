import type { Profile } from "./profile";
import type { TaxInput, TaxReport, TaxTrade, TaxSaleRow } from "./types";
import { start, finish, makeEngine, dividends, warn, sum, positive, progressive, accountKey, days, addDays, overYear, EPS, inYear } from "./common";
import { ordinaryRates, rateStatus, US_RATES } from "./usRates";

interface Part {
  buy: TaxTrade; shares: number; unitCost: number; washPerShare: number;
  holdingDate: string; replacementUsed: boolean;
}
const order = (a: TaxTrade, b: TaxTrade) => a.taxDate.localeCompare(b.taxDate) || a.executed_at.localeCompare(b.executed_at)
  || (a.side === b.side ? a.id.localeCompare(b.id) : a.side === "BUY" ? -1 : 1);

/** FIFO / documented specific ID, plus wash-sale state across ALL imported taxpayer accounts.
 * Each partially matched replacement is a separate basis/holding-period segment.
 * IRS Pub 550; IRC §1091; IRA replacements: Rev. Rul. 2008-5 (permanent disallowance).
 */
export function matchUsLots(input: TaxInput, report: TaxReport): void {
  const trades = [...input.trades].sort(order);
  const parts: Part[] = trades.filter(t => t.side === "BUY" && t.accountType !== "sheltered").map(buy => ({ buy, shares: buy.shares,
    unitCost: buy.price_usd + (buy.fee_usd ?? 0) / buy.shares, washPerShare: 0,
    holdingDate: buy.taxDate, replacementUsed: false }));
  const active = new Set<string>();
  const rows: TaxSaleRow[] = [];
  const assetId = (t: TaxTrade) => input.instruments[t.ticker].assetId;
  const group = (t: TaxTrade) => input.instruments[t.ticker].washGroup ?? assetId(t);
  for (const t of trades) {
    if (t.accountType === "sheltered") continue;
    if (t.side === "BUY") { active.add(t.id); continue; }
    const candidates = parts.filter(p => p.shares > EPS && active.has(p.buy.id) && assetId(p.buy) === assetId(t)
      && accountKey(p.buy) === accountKey(t) && (p.buy.accountType ?? "taxable") === (t.accountType ?? "taxable"));
    const sold: Part[] = [];
    const take = (buyId: string | undefined, requested: number) => {
      let left = requested;
      for (const p of candidates) {
        if (left <= EPS) break;
        if (buyId && p.buy.id !== buyId) continue;
        const n = Math.min(left, p.shares);
        if (n <= EPS) continue;
        sold.push({ ...p, shares: n }); p.shares -= n; left -= n;
      }
      return left;
    };
    const missing = t.lots ? sum(t.lots, l => take(l.buyId, l.shares)) : take(undefined, t.shares);
    // Shares with no purchase on record: left out of the estimate and named, not a reason to
    // blank the year (an invalid specific ID still is).
    if (missing > EPS) { if (t.lots) warn(report, "unmatched-sell", `Missing ${missing} shares or invalid specific ID.`, true, t.id); else if (t.taxDate >= report.period.from && t.taxDate <= report.period.to) warn(report, "unmatched-sell", `Missing ${missing} shares — left out of the estimate.`, false, t.id); }
    if (t.accountType === "ira") continue;
    // Remove ALL shares in this disposal before looking for pre-sale replacement holdings.
    for (const p of sold) {
      const gain = p.shares * (t.price_usd - p.unitCost) - (t.fee_usd ?? 0) * p.shares / t.shares;
      const row: TaxSaleRow = { sellId: t.id, buyId: p.buy.id, ticker: t.ticker, asset: input.instruments[t.ticker].kind,
        acquired: p.buy.taxDate, sold: t.taxDate, shares: p.shares, proceeds: p.shares * t.price_usd,
        cost: p.shares * p.unitCost, fees: (t.fee_usd ?? 0) * p.shares / t.shares, gain,
        classification: overYear(p.holdingDate, t.taxDate) ? "long-term" : "short-term",
        exemptGain: 0, taxableGain: gain, washDisallowed: 0, fxRefs: [] };
      if (gain < -EPS && row.asset !== "crypto") {
        let left = p.shares;
        const lossPerShare = -gain / p.shares;
        // Purchase order, including pre-sale unconsumed lots, future buys and other brokers.
        const replacements = parts.filter(q => q.shares > EPS && !q.replacementUsed && group(q.buy) === group(t)
          && Math.abs(days(t.taxDate, q.buy.taxDate)) <= 30);
        for (const q of replacements) {
          if (left <= EPS) break;
          const n = Math.min(left, q.shares);
          // Preserve untouched segment ahead of / behind adjusted shares in deterministic order.
          const idx = parts.indexOf(q);
          if (q.shares > n + EPS) parts.splice(idx + 1, 0, { ...q, shares: q.shares - n });
          q.shares = n; q.replacementUsed = true;
          if (q.buy.accountType !== "ira") {
            q.unitCost += lossPerShare; q.washPerShare += lossPerShare;
            q.holdingDate = addDays(q.holdingDate, -days(p.holdingDate, t.taxDate));
          } else {
            warn(report, "ira-wash", "IRA replacement permanently disallows the loss without a basis increase.", false, t.id);
          }
          row.washDisallowed += n * lossPerShare;
          left -= n;
        }
        row.taxableGain = gain + row.washDisallowed;
      }
      rows.push(row);
    }
  }
  report.rows = rows.filter(r => inYear(report, r.sold));
  report.openLots = parts.filter(p => p.shares > EPS && active.has(p.buy.id)).map(p => ({ buyId: p.buy.id, ticker: p.buy.ticker,
    account: accountKey(p.buy), shares: p.shares, acquired: p.buy.taxDate, holdingDate: p.holdingDate,
    cost: p.shares * p.unitCost, washBasis: p.shares * p.washPerShare }));
}

export function buildUsReport(input: TaxInput): TaxReport {
  const r = start(input, "US", "USD"), p = input.profile as Profile<"US">;
  matchUsLots(input, r); dividends(input, r);
  for (const d of r.dividends) {
    if (typeof d.qualified !== "boolean") warn(r, "dividend-qualification", "Qualified/ordinary status must be verified, including holding-period and issuer tests.", true, d.id);
  }
  const ordinaryDiv = sum(r.dividends.filter(d => !d.qualified), d => d.gross ?? 0);
  const qualified = sum(r.dividends.filter(d => d.qualified), d => d.gross ?? 0);
  let st = sum(r.rows.filter(x => x.classification === "short-term"), x => x.taxableGain ?? 0) - p.shortTermLossCarry;
  let lt = sum(r.rows.filter(x => x.classification === "long-term"), x => x.taxableGain ?? 0) - p.longTermLossCarry;
  r.breakdown = { shortTermBeforeNetting: st, longTermBeforeNetting: lt, washDisallowed: sum(r.rows, x => x.washDisallowed), ordinaryDividends: ordinaryDiv, qualifiedDividends: qualified };
  if (st * lt < 0) {
    const offset = Math.min(Math.abs(st), Math.abs(lt));
    st += st < 0 ? offset : -offset; lt += lt < 0 ? offset : -offset;
  }
  const limit = p.filingStatus === "marriedSeparate" ? 1500 : 3000;
  const deduction = Math.min(limit, positive(-st - lt));
  // Schedule D carryover worksheet: deductions cannot consume a loss without taxable income.
  const used = Math.min(deduction, positive(p.otherOrdinaryTaxableIncome + ordinaryDiv + qualified));
  const usedSt = Math.min(positive(-st), used);
  r.carryforward = { shortTerm: positive(-st) - usedSt, longTerm: positive(-lt) - (used - usedSt) };
  const status = rateStatus(p.filingStatus), rates = US_RATES[p.year];
  const ordinaryIncome = positive(p.otherOrdinaryTaxableIncome + ordinaryDiv + positive(st) - deduction);
  const totalIncome = positive(p.otherOrdinaryTaxableIncome + ordinaryDiv + qualified + positive(st) + positive(lt) - deduction);
  const preferred = Math.min(positive(lt) + qualified, totalIncome);
  // Qualified dividends/capital-gain worksheet: preferential tax can never exceed ordinary tax.
  const ordinaryBase = positive(totalIncome - preferred);
  const capitalTax = progressive(ordinaryBase + preferred, rates.capital[status], [0, .15, .20])
    - progressive(ordinaryBase, rates.capital[status], [0, .15, .20]);
  const baseline = progressive(positive(p.otherOrdinaryTaxableIncome), rates.ordinary[status], ordinaryRates);
  const regular = Math.min(progressive(ordinaryBase, rates.ordinary[status], ordinaryRates) + capitalTax,
    progressive(totalIncome, rates.ordinary[status], ordinaryRates));
  const threshold = status === "marriedJoint" ? 250000 : status === "marriedSeparate" ? 125000 : 200000;
  // MAGI and taxable income are separate inputs. Capital loss deduction can offset investment income.
  const portfolioIncome = ordinaryDiv + qualified + positive(st + lt) - deduction;
  const niit = .038 * Math.min(positive(p.otherNetInvestmentIncome + portfolioIncome), positive(p.otherMagi + portfolioIncome - threshold));
  const baselineNiit = .038 * Math.min(p.otherNetInvestmentIncome, positive(p.otherMagi - threshold));
  // A portfolio loss can reduce regular tax while foreign dividends still qualify for a credit.
  // The caller's Form 1116 limit is capped by total regular tax, not its incremental change.
  let availableCredit = Math.min(p.foreignTaxCreditLimit, positive(regular));
  for (const d of r.dividends) {
    d.credit = Math.min(d.withheld ?? 0, d.creditLimit, availableCredit);
    availableCredit -= d.credit;
  }
  r.foreignTaxCredit = sum(r.dividends, d => d.credit);
  r.taxableBase = positive(st) + positive(lt) + ordinaryDiv + qualified;
  r.taxBeforeCredit = regular - baseline + niit - baselineNiit;
  r.estimatedTax = r.taxBeforeCredit - r.foreignTaxCredit;
  Object.assign(r.breakdown, { shortTermNet: st, longTermNet: lt, capitalLossDeduction: deduction,
    lossDeductionUsed: used, ordinaryIncome, preferentialIncome: preferred, capitalTax,
    regularTaxDelta: regular - baseline, niit: niit - baselineNiit });
  warn(r, "us-scope", "Federal only; no state/local tax, AMT, PFIC, collectibles, §1256, options, short sales, employee awards or automatic Form 1116. Import all spouse/IRA replacement activity; substantial identity and dividend qualification require verification.");
  return finish(r);
}
export const US_ENGINE = makeEngine("US", buildUsReport);
