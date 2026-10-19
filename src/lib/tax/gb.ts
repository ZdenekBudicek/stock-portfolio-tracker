import type { Profile } from "./profile";
import type { TaxInput, TaxReport, TaxSaleRow, TaxTrade } from "./types";
import { start, finish, makeEngine, dividends, quote, sum, positive, days, EPS, warn, progressive, inYear } from "./common";

interface Daily {
  key: string; ticker: string; date: string; buys: TaxTrade[]; sells: TaxTrade[];
  bought: number; sold: number; buyLeft: number; sellLeft: number;
  cost: number | null; proceeds: number | null; fees: number | null; refs: string[];
  matches: { date: string | null; shares: number; cost: number | null; kind: string; ref?: string }[];
}
/** TCGA 1992 §§104,105,106A: same-day across all accounts, then 30-day, then S104.
 * Reserve EVERY same-day match before matching any preceding disposal to a later purchase.
 * Replay the residual pool only after all forward matches are reserved.
 */
export function matchUkPool(input: TaxInput, r: TaxReport) {
  const groups = new Map<string, Daily>();
  for (const t of [...input.trades].sort((a, b) => a.taxDate.localeCompare(b.taxDate) || a.id.localeCompare(b.id))) {
    if ((t.accountType ?? "taxable") !== "taxable") continue;
    const a = input.instruments[t.ticker];
    if (a.kind === "etf" && a.ukReportingFund !== true) warn(r, "non-reporting-fund", "Confirm reporting status throughout ownership; offshore income gains are outside this CGT engine.", true, t.ticker);
    const key = JSON.stringify([a.assetId, t.taxDate]);
    let g = groups.get(key);
    if (!g) { g = { key: a.assetId, ticker: t.ticker, date: t.taxDate, buys: [], sells: [], bought: 0, sold: 0,
      buyLeft: 0, sellLeft: 0, cost: 0, proceeds: 0, fees: 0, refs: [], matches: [] }; groups.set(key, g); }
    const q = quote(input, r, t.taxDate);
    if (q) g.refs.push(`${q.source}:${q.ref}`);
    if (t.side === "BUY") {
      g.buys.push(t); g.bought += t.shares; g.buyLeft += t.shares;
      g.cost = g.cost == null || !q ? null : g.cost + (t.shares * t.price_usd + (t.fee_usd ?? 0)) * q.rate + (t.priorFundIncome ?? 0);
    } else {
      g.sells.push(t); g.sold += t.shares; g.sellLeft += t.shares;
      g.proceeds = g.proceeds == null || !q ? null : g.proceeds + t.shares * t.price_usd * q.rate;
      g.fees = g.fees == null || !q ? null : g.fees + (t.fee_usd ?? 0) * q.rate;
    }
  }
  const daily = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  function match(sale: Daily, buy: Daily, n: number, kind: string) {
    if (n <= EPS) return;
    sale.matches.push({ date: buy.date, shares: n, cost: buy.cost == null ? null : buy.cost * n / buy.bought, kind, ref: buy.buys.map(t => t.id).join(",") });
    sale.refs.push(...buy.refs);
    sale.sellLeft -= n; buy.buyLeft -= n;
  }
  for (const g of daily) match(g, g, Math.min(g.buyLeft, g.sellLeft), "same-day");
  for (const sale of daily) {
    if (sale.sellLeft <= EPS) continue;
    for (const buy of daily) {
      if (buy.key !== sale.key || buy.date <= sale.date || days(sale.date, buy.date) > 30) continue;
      match(sale, buy, Math.min(sale.sellLeft, buy.buyLeft), "30-day");
      if (sale.sellLeft <= EPS) break;
    }
  }
  const pools = new Map<string, { shares: number; cost: number | null; ticker: string; refs: Set<string> }>();
  for (const g of daily) {
    let pool = pools.get(g.key);
    if (!pool) { pool = { shares: 0, cost: 0, ticker: g.ticker, refs: new Set() }; pools.set(g.key, pool); }
    if (g.buyLeft > EPS) {
      pool.cost = pool.cost == null || g.cost == null ? null : pool.cost + g.cost * g.buyLeft / g.bought;
      pool.shares += g.buyLeft;
      g.refs.forEach(ref => pool!.refs.add(ref));
    }
    if (g.sellLeft > EPS) {
      const n = Math.min(pool.shares, g.sellLeft);
      if (g.sellLeft - n > EPS) warn(r, "unmatched-sell", "Insufficient Section 104 pool — the shares without a recorded purchase are left out of the estimate.", false, g.sells.map(t => t.id).join(","));
      if (n > EPS) {
        const cost = pool.cost == null ? null : pool.cost * n / pool.shares;
        g.matches.push({ date: null, shares: n, cost, kind: "section-104" });
        g.refs.push(...pool.refs);
        if (pool.cost != null) pool.cost -= cost!;
        pool.shares -= n;
        if (pool.shares <= EPS) pool.refs.clear();
      }
    }
    if (!inYear(r, g.date)) continue;
    for (const m of g.matches) {
      const proceeds = g.proceeds == null ? null : g.proceeds * m.shares / g.sold;
      const fees = g.fees == null ? null : g.fees * m.shares / g.sold;
      const gain = proceeds == null || fees == null || m.cost == null ? null : proceeds - fees - m.cost;
      const row: TaxSaleRow = { sellId: g.sells.map(t => t.id).join(","), buyId: m.ref ?? null, ticker: g.ticker,
        asset: input.instruments[g.ticker].kind, acquired: m.date, sold: g.date, shares: m.shares,
        proceeds, cost: m.cost, fees, gain, taxableGain: gain, exemptGain: 0, washDisallowed: 0,
        classification: m.kind, fxRefs: [...new Set(g.refs)] };
      r.rows.push(row);
    }
  }
  for (const [key, pool] of pools) {
    r.breakdown[`poolShares:${key}`] = pool.shares;
    if (pool.cost != null) r.breakdown[`poolCost:${key}`] = pool.cost;
  }
}

export function buildGbReport(input: TaxInput) {
  const r = start(input, "GB", "GBP"), p = input.profile as Profile<"GB">;
  matchUkPool(input, r); dividends(input, r);
  const fundIncome = sum((input.fundIncome ?? []).filter(f => inYear(r, f.taxDate)), f => f.amount);
  const grossDividends = sum(r.dividends, d => d.gross ?? 0) + fundIncome;
  const taxableDividends = positive(grossDividends - p.unusedPersonalAllowance);
  const divAllowance = Math.min(taxableDividends, p.dividendAllowanceRemaining);
  const divRates = p.year === 2026 ? [.1075, .3575, .3935] : [.0875, .3375, .3935];
  // Nil-rate dividend allowance consumes the income-tax band, unlike personal allowance.
  const divTax = progressive(p.otherTaxableIncome + taxableDividends, [p.basicRateBand, p.higherRateBandEnd], divRates)
    - progressive(p.otherTaxableIncome + divAllowance, [p.basicRateBand, p.higherRateBandEnd], divRates);
  let creditRemaining = divTax;
  for (const d of r.dividends) {
    d.credit = Math.min(d.withheld ?? 0, d.creditLimit, grossDividends > 0 ? divTax * (d.gross ?? 0) / grossDividends : 0, creditRemaining);
    creditRemaining -= d.credit;
  }
  let early = sum(r.rows.filter(x => x.sold < "2024-10-30"), x => positive(x.gain ?? 0));
  let late = sum(r.rows.filter(x => x.sold >= "2024-10-30"), x => positive(x.gain ?? 0));
  const losses = -sum(r.rows, x => Math.min(0, x.gain ?? 0));
  const net = early + late - losses;
  const usedCarry = Math.min(p.lossCarry, positive(net - p.annualExemptAmount));
  let relief = losses + usedCarry + p.annualExemptAmount;
  // Most beneficial allocation: losses/AEA to 24/18% gains first; basic band to 20→10% first.
  const removeLate = Math.min(late, relief); late -= removeLate; relief -= removeLate;
  early = positive(early - relief);
  let basic = positive(p.basicRateBand - p.otherTaxableIncome - taxableDividends);
  const earlyBasic = Math.min(early, basic); basic -= earlyBasic;
  const lateBasic = Math.min(late, basic);
  const capitalTax = earlyBasic * .10 + (early - earlyBasic) * .20 + lateBasic * .18 + (late - lateBasic) * .24;
  r.carryforward = { capitalLoss: p.lossCarry - usedCarry + positive(-net) };
  r.taxableBase = early + late + positive(taxableDividends - divAllowance);
  r.taxBeforeCredit = capitalTax + divTax;
  r.foreignTaxCredit = sum(r.dividends, d => d.credit);
  r.estimatedTax = r.taxBeforeCredit - r.foreignTaxCredit;
  Object.assign(r.breakdown, { gainsNet: net, currentLosses: losses, carryUsed: usedCarry, capitalTax, dividendTax: divTax,
    earlyTaxable: early, lateTaxable: late, dividendAllowance: divAllowance, fundIncome });
  warn(r, "gb-scope", "Tax year begins 6 April. Supply adjusted income-tax bands and unused personal allowance after taper/reliefs. No FIG/remittance basis, non-reporting offshore income gains, bond-fund interest, trusts or residence changes. Foreign credit is a proportional estimate capped by supplied limits.");
  return finish(r);
}
export const GB_ENGINE = makeEngine("GB", buildGbReport);
