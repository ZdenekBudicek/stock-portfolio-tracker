import { runFifo } from "@/lib/fifo";
import { addDays, addYearsClamped } from "@/lib/czTax";
import { parseTaxProfile, type Country } from "./profile";
import { cnbTaxFx } from "./fx";
import type { TaxInput, TaxReport, TaxSaleRow, TaxEngine, TaxTrade, FxQuote, TaxCurrency } from "./types";

export { addDays, addYearsClamped };
export const EPS = 1e-8;
export const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
export const positive = (x: number) => Math.max(0, x);
export const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
/** First day held more than one year after `a` (the day after its one-year anniversary). */
export const overYearFrom = (a: string) => addDays(addYearsClamped(a, 1), 1);
export const overYear = (a: string, b: string) => b > addYearsClamped(a, 1);
export const accountKey = (t: TaxTrade) => JSON.stringify([t.broker, t.broker_account ?? ""]);
export function period(country: Country, year: number) {
  return country === "GB" ? { from: `${year}-04-06`, to: `${year + 1}-04-05` } : { from: `${year}-01-01`, to: `${year}-12-31` };
}
export const inYear = (r: TaxReport, date: string) => date >= r.period.from && date <= r.period.to;
export function warn(r: TaxReport, code: string, message: string, blocking = false, ref?: string) {
  if (!r.warnings.some(w => w.code === code && w.ref === ref)) r.warnings.push({ code, message, blocking, ref });
}
const validDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function start(input: TaxInput, country: Country, currency: TaxCurrency): TaxReport {
  const p = parseTaxProfile(input.profile);
  if (p.residence !== country) throw new Error(`Expected ${country} tax profile`);
  if (!validDate(input.completeThrough)) throw new Error("Invalid completeThrough");
  const r: TaxReport = { residence: country, year: p.year, currency, period: period(country, p.year), rows: [], dividends: [], openLots: [],
    taxableBase: 0, estimatedTax: 0, taxBeforeCredit: 0, foreignTaxCredit: 0, healthContributions: 0,
    carryforward: {}, breakdown: {}, warnings: [], complete: true, fxMode: currency === "USD" ? "usd" : "statutory" };
  const ids = new Set<string>();
  const assets = new Map<string, string>();
  for (const t of input.trades) {
    if (!t.id || ids.has(t.id) || !validDate(t.taxDate) || !finite(t.shares) || t.shares <= 0 || !finite(t.price_usd)
      || !finite(t.fee_usd ?? 0) || !["BUY", "SELL"].includes(t.side) || !t.ticker || !t.broker
      || !Number.isFinite(Date.parse(t.executed_at)) || (t.accountType && !["taxable", "ira", "sheltered"].includes(t.accountType))
      || (t.priorFundIncome != null && !finite(t.priorFundIncome))) throw new Error(`Invalid tax trade ${t.id}`);
    ids.add(t.id);
    const a = input.instruments[t.ticker];
    if (!a || !a.assetId || !["stock", "etf", "crypto"].includes(a.kind)) throw new Error(`Missing instrument metadata: ${t.ticker}`);
    if (assets.has(a.assetId) && assets.get(a.assetId) !== a.kind) throw new Error(`Inconsistent asset type: ${a.assetId}`);
    assets.set(a.assetId, a.kind);
    if (a.regulatedMarketSince != null && !validDate(a.regulatedMarketSince)) throw new Error(`Invalid market date: ${t.ticker}`);
    if (t.taxDate > input.completeThrough) throw new Error(`Trade beyond completeThrough: ${t.id}`);
    // An unresolved corporate action blocks only the year it happened in; a 2022 buyout says
    // nothing about 2026 (a later sale of an unresolved exchange shows up as unmatched instead).
    if (/:split:|:merger:|:mergercash:/.test(t.ext_id ?? "")) warn(r, "corporate-action", "Corporate actions require jurisdiction-specific basis normalization before this API.", inYear(r, t.taxDate), t.id);
    if (t.lots && (t.side !== "SELL" || country !== "US" || t.lots.some(l => !l.buyId || !finite(l.shares) || l.shares <= 0)
      || new Set(t.lots.map(l => l.buyId)).size !== t.lots.length || Math.abs(sum(t.lots, l => l.shares) - t.shares) > EPS))
      throw new Error(`Invalid specific identification: ${t.id}`);
  }
  const dividendIds = new Set<string>();
  for (const d of input.dividends) {
    if (!d.id || dividendIds.has(d.id) || !input.instruments[d.ticker] || !validDate(d.taxDate) || !finite(d.grossUsd)
      || !finite(d.withholdingUsd) || d.withholdingUsd > d.grossUsd || !finite(d.creditLimit)
      || d.taxDate > input.completeThrough) throw new Error(`Invalid dividend ${d.id}`);
    dividendIds.add(d.id);
  }
  const fundIds = new Set<string>();
  for (const f of input.fundIncome ?? []) {
    if (!f.id || fundIds.has(f.id) || input.instruments[f.ticker]?.kind !== "etf" || !validDate(f.taxDate)
      || f.taxDate > input.completeThrough || !finite(f.amount)) throw new Error(`Invalid fund income ${f.id}`);
    fundIds.add(f.id);
  }
  const lookahead = country === "US" || country === "GB" ? 30 : 0;
  if (input.completeThrough < addDays(r.period.to, lookahead)) warn(r, "incomplete-ledger", `Ledger must be complete through ${addDays(r.period.to, lookahead)}.`, !input.provisional);
  if ((country === "GB" || country === "DE") && (input.trades.some(t => input.instruments[t.ticker].kind === "etf" && (t.accountType ?? "taxable") === "taxable")
    || input.dividends.some(d => input.instruments[d.ticker].kind === "etf")) && !input.fundDataComplete)
    warn(r, "fund-income-missing", "Supply deemed fund income and prior fund income basis adjustments (including explicit zero confirmation).", true);
  warn(r, "scope", "Private resident portfolio estimate; special regimes, business assets, derivatives and personal tax-return adjustments are outside this engine.");
  return r;
}

export function quote(input: TaxInput, r: TaxReport, date: string): FxQuote | null {
  const q = r.currency === "USD" ? { rate: 1, ref: date, source: "USD", statutory: true } : (input.fx ?? cnbTaxFx)(date, r.currency);
  if (!q || !Number.isFinite(q.rate) || q.rate <= 0) { warn(r, "missing-fx", `Missing ${r.currency} rate on ${date}.`, true, date); return null; }
  if (!q.statutory) { r.fxMode = "cnb-estimate"; warn(r, "fx-estimate", "CNB cross rates / assumed rates are an estimate; use the jurisdiction's permitted rate for filing."); }
  return q;
}
export function dividends(input: TaxInput, r: TaxReport) {
  for (const d of input.dividends.filter(d => inYear(r, d.taxDate))) {
    const q = quote(input, r, d.taxDate);
    r.dividends.push({ ...d, gross: q ? d.grossUsd * q.rate : null, withheld: q ? d.withholdingUsd * q.rate : null,
      taxable: q ? d.grossUsd * q.rate : null, credit: 0 });
  }
}
/** Tax on an income total, using upper bounds and corresponding rates. */
export function progressive(income: number, upper: readonly number[], rates: readonly number[]): number {
  let tax = 0, previous = 0;
  for (let i = 0; i < rates.length; i++) {
    tax += positive(Math.min(income, upper[i] ?? Infinity) - previous) * rates[i];
    previous = upper[i] ?? Infinity;
  }
  return tax;
}
export function finish(r: TaxReport): TaxReport {
  r.complete = !r.warnings.some(w => w.blocking);
  if (!r.complete) { r.taxableBase = null; r.estimatedTax = null; r.taxBeforeCredit = null; r.healthContributions = null; }
  return r;
}
/** New engines always re-run the entire period: allowances, netting and wash sales are nonlocal. */
export function makeEngine(residence: Country, report: (input: TaxInput) => TaxReport): TaxEngine {
  return { residence, report, simulate(input, scenario) {
    if (scenario.trade.side !== "SELL") throw new Error("A sale scenario must be a SELL");
    const bounds = period(residence, input.profile.year);
    if (scenario.trade.taxDate < bounds.from || scenario.trade.taxDate > bounds.to) throw new Error("Simulation outside profile year");
    if (scenario.assumedFx != null && (!Number.isFinite(scenario.assumedFx) || scenario.assumedFx <= 0)) throw new Error("Invalid assumed FX");
    const baseFx = input.fx ?? cnbTaxFx;
    const fx = scenario.assumedFx == null ? input.fx : (date: string, currency: TaxCurrency) => date === scenario.trade.taxDate
      ? { rate: scenario.assumedFx!, ref: date, source: "scenario", statutory: false } : baseFx(date, currency);
    const before = report({ ...input, fx });
    const after = report({ ...input, fx, trades: [...input.trades, scenario.trade] });
    warn(after, "simulation", "Hypothetical sale; future replacement purchases can change wash-sale / 30-day matching.");
    return { before, after, taxDelta: before.estimatedTax == null || after.estimatedTax == null ? null : after.estimatedTax - before.estimatedTax };
  } };
}

/** Shared FIFO only for SK/DE/PL. UK and US require their own state machines. */
export function fifoRows(input: TaxInput, r: TaxReport): TaxSaleRow[] {
  const trades = input.trades.filter(t => (t.accountType ?? "taxable") === "taxable" && t.taxDate <= r.period.to);
  const byId = new Map(trades.map(t => [t.id, t]));
  // Chronology from the real timestamps (a local date + the UTC time of day reordered trades
  // around midnight); the tax dates come from each trade row below.
  const result = runFifo(trades.map(t => ({ ...t, ticker: input.instruments[t.ticker].assetId })));
  // A sale with no purchase on record is left out of the estimate and named (as in the Czech
  // report), not a reason to blank the whole year; only one inside this period is reported.
  for (const w of result.warnings) {
    if (w.kind === "unmatched-sell") { if (inYear(r, byId.get(w.txId)?.taxDate ?? "")) warn(r, "unmatched-sell", "Sale without a recorded purchase — left out of the estimate.", false, w.txId); continue; }
    warn(r, w.kind, "FIFO history is incomplete or has an unsupported corporate action.", inYear(r, byId.get(w.txId)?.taxDate ?? ""), w.txId);
  }
  for (const d of result.disposals.filter(d => inYear(r, byId.get(d.sellTxId)?.taxDate ?? ""))) {
    const buy = byId.get(d.buyTxId)!, sell = byId.get(d.sellTxId)!, a = input.instruments[sell.ticker];
    const bq = d.costUsd === 0 ? { rate: 1, ref: "zero-cost" } : quote(input, r, buy.taxDate), sq = quote(input, r, sell.taxDate);
    const proceeds = sq ? d.proceedsUsd * sq.rate : null, fees = sq ? d.sellFeeUsd * sq.rate : null;
    const cost = bq ? d.costUsd * bq.rate : null;
    const gain = cost == null || proceeds == null || fees == null ? null : proceeds - fees - cost;
    r.rows.push({ sellId: sell.id, buyId: buy.id, ticker: sell.ticker, asset: a.kind, acquired: buy.taxDate, sold: sell.taxDate,
      shares: d.shares, proceeds, fees, cost, gain, classification: "taxable", exemptGain: 0, taxableGain: gain, washDisallowed: 0,
      fxRefs: [bq?.ref, sq?.ref].filter((s): s is string => !!s) });
  }
  return r.rows;
}
