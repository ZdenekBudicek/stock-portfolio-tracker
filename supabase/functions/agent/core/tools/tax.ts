import type { Country, CzTaxModel, DisplayCurrency, InternationalTaxModel, RealizedYear, SaleModelResult, SaleRequest, TaxOpenLot,
  TaxReport, TaxResidence } from '../../_lib/trackora-lib.js';
import { calculationCache } from '../context.ts';
import { selectedAccount } from '../accountChoices.ts';
import type { PortfolioSnapshot, Scope } from '../dataTypes.ts';
import { ToolInputError, type ToolCtx } from '../types.ts';
import { arrayOf, checkPeriod, checkPeriodYears, compute, currencySchema, dateSchema, defineTool, ensureWithinLimits, factSink, MAX_ROWS,
  meta, num, object, open, parseWith, periodOf, resolveTicker, scopeMatches, scopeSchema, success, tickerSchema, yearOf, yearsOf } from './common.ts';
import { pricedPortfolio, requireScope } from './portfolio.ts';

const FOREIGN: readonly string[] = ['SK', 'PL', 'DE', 'GB', 'US'];
type CzView = Omit<CzTaxModel, 'kindOf' | 'fifo'>;
type ReadyModel = Extract<InternationalTaxModel, { status: 'ready' }>;

// The resolver function and the raw FIFO stay internal: tool data must serialize.
const czView = ({ kindOf: _kindOf, fifo: _fifo, ...view }: CzTaxModel): CzView => view;

async function czModel(ctx: ToolCtx, year: number): Promise<{ model: CzTaxModel; usdCzk: number; asOf: string; snapshotId: string; complete: boolean; warnings: string[] }> {
  const p = await pricedPortfolio(ctx);
  const snap = p.loaded.data;
  const model = compute(ctx, snap, `cz_tax:${year}`, ['fifo_real', 'cz_tax'], () => ctx.lib.computeCzTaxModel({ transactions: snap.transactions, positions: p.portfolio.positions,
    registry: snap.registry, year, today: ctx.today, usdCzk: p.portfolio.usdCzk, settings: ctx.preferences.tax }, calculationCache(ctx)));
  return { model, usdCzk: p.portfolio.usdCzk, asOf: p.loaded.meta.asOf, snapshotId: p.loaded.meta.snapshotId, complete: p.complete, warnings: p.warnings };
}

function foreignModel(ctx: ToolCtx, snap: PortfolioSnapshot, residence: TaxResidence, year: number): ReadyModel {
  const model = compute(ctx, snap, `foreign_tax:${residence}:${year}`, ['foreign_tax'], () => ctx.lib.computeInternationalTaxModel({ transactions: snap.transactions, dividends: snap.dividends,
    registry: snap.registry, residence, year, today: ctx.today, storedProfiles: snap.settings.storedProfiles }));
  if (model.status === 'ready') return model;
  if (model.status === 'missing_profile') throw new ToolInputError('unsupported', `A ${residence} tax profile for ${year} is required; the user can fill it in Settings.`);
  if (model.status === 'unsupported') throw new ToolInputError('unsupported', model.reason);
  throw new ToolInputError('invalid', model.reason);
}

function residenceOf(snap: PortfolioSnapshot): 'CZ' | 'FOREIGN' {
  if (snap.settings.taxResidence === 'CZ') return 'CZ';
  if (FOREIGN.includes(snap.settings.taxResidence)) return 'FOREIGN';
  throw new ToolInputError('unsupported', 'Trackora has no tax model for this residence; get_realized_pnl gives the neutral realized view.', undefined, 'unsupported_residence');
}

/* ----------------------------- get_realized_pnl ----------------------------- */

type RealizedArgs = { from: string; to: string; ticker?: string; currency: DisplayCurrency; scope?: Scope };
const realizedInput = object({ from: dateSchema, to: dateSchema, ticker: tickerSchema, currency: currencySchema, scope: scopeSchema }, ['from', 'to', 'currency']);
const realized = defineTool<RealizedArgs, { reports: RealizedYear[] }>({
  name: 'get_realized_pnl', group: 'dane',
  description: 'Realized gains and losses (FIFO over the full history, then filtered) and recorded dividends per calendar year of the period, in the requested currency. Neutral view: no exemptions or tax.',
  inputSchema: realizedInput, parse: parseWith(realizedInput, a => { checkPeriod(a); checkPeriodYears(a); }),
  outputSchema: open({ reports: arrayOf(open({ year: { type: 'integer' }, currency: currencySchema, rows: arrayOf({ type: 'object' }, MAX_ROWS),
    proceeds: num, gains: num, losses: num, net: num, complete: { type: 'boolean' } }, ['year', 'currency', 'rows', 'net', 'complete'])) }, ['reports']),
  async run(args, ctx) {
    const loaded = await ctx.loadSnapshot();
    const snap = loaded.data, period = periodOf(args);
    ensureWithinLimits(ctx, snap);
    const ticker = args.ticker ? (await resolveTicker(ctx, args.ticker)).ticker : undefined;
    requireScope(ctx, snap.transactions.filter(t => ctx.lib.isRealTradeTx(t)), args.scope);
    const payDate = (d: { pay_date: string | null; ex_date: string }) => d.pay_date ?? d.ex_date;
    // Dividends are not lot-matched, so they can be narrowed before the model; sales only after FIFO.
    const dividends = snap.dividends.filter(d => payDate(d) >= period.from && payDate(d) <= period.to
      && (!ticker || d.ticker.toUpperCase() === ticker) && scopeMatches(args.scope, ctx.lib.brokerOf(d), d.broker_account));
    const warnings = [...loaded.meta.warnings], sink = factSink(ctx, warnings);
    let omitted = 0, complete = loaded.meta.complete;
    const reports: RealizedYear[] = [];
    // All years are charged together before the first one starts; an identical question in this request reuses them.
    const years = yearsOf(period);
    const computed = compute(ctx, snap, `realized:${JSON.stringify([period.from, period.to, args.currency, ticker ?? null, args.scope ?? null])}`,
      ['fifo_real', ...years.map(() => 'realized_year' as const)], () => years.map(year => ctx.lib.computeRealized({ transactions: snap.transactions,
        dividends, year, currency: args.currency, today: ctx.today }, calculationCache(ctx)).report));
    for (const [i, year] of years.entries()) {
      const report = computed[i];
      const rows = report.rows.filter(r => r.soldDate >= period.from && r.soldDate <= period.to
        && (!ticker || r.ticker.toUpperCase() === ticker) && scopeMatches(args.scope, r.broker, r.account));
      let proceeds = 0, gains = 0, losses = 0;
      for (const r of rows) {
        if (r.proceeds != null) proceeds += r.proceeds;
        if (r.gain == null) continue;
        if (r.gain >= 0) gains += r.gain; else losses += r.gain;
      }
      const filtered = rows.length === report.rows.length ? report : { ...report, rows, proceeds, gains, losses, net: gains + losses };
      if (!report.complete) complete = false;
      if (report.unmatchedSells) warnings.push(`unmatched_sells:${year}:${report.unmatchedSells}`);
      if (report.missingFx.length) warnings.push(`missing_fx:${year}:${report.missingFx.length}`);
      omitted += Math.max(0, filtered.rows.length - MAX_ROWS);
      reports.push({ ...filtered, rows: filtered.rows.slice(0, MAX_ROWS) });
      const yearPeriod = { from: period.from > `${year}-01-01` ? period.from : `${year}-01-01`, to: period.to < `${year}-12-31` ? period.to : `${year}-12-31` };
      const base = { source: 'realized_model', as_of: loaded.meta.asOf, currency: args.currency, ticker, period: yearPeriod };
      sink.add(`realized:${year}:net`, filtered.net, 'money', base);
      sink.add(`realized:${year}:gains`, filtered.gains, 'money', base);
      sink.add(`realized:${year}:losses`, filtered.losses, 'money', base);
      sink.add(`realized:${year}:proceeds`, filtered.proceeds, 'money', base);
      sink.add(`realized:${year}:dividends`, filtered.dividends.total, 'money', base);
    }
    return success(ctx, { reports }, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, scope: args.scope, period, complete, warnings, omittedRows: omitted }));
  },
});

/* ----------------------------- get_tax_report ----------------------------- */

type TaxData = { residence: TaxResidence; model: CzView | { status: 'ready'; report: TaxReport } };
const taxInput = object({ year: { type: 'integer', minimum: 2000, maximum: 2100 } }, ['year']);
const taxReport = defineTool<{ year: number }, TaxData>({
  name: 'get_tax_report', group: 'dane',
  description: 'Tax estimate for one year under the user\'s tax residence (Czech model or SK/PL/DE/GB/US engines with a saved profile). Estimates, not tax advice; warnings list missing rates or data.',
  inputSchema: taxInput, parse: parseWith(taxInput),
  outputSchema: open({ residence: { type: 'string' }, model: { type: 'object' } }, ['residence', 'model']),
  async run(args, ctx) {
    if (args.year > yearOf(ctx.today)) throw new ToolInputError('invalid', 'That tax year has not started yet.');
    const loaded = await ctx.loadSnapshot();
    const snap = loaded.data, period = { from: `${args.year}-01-01`, to: `${args.year}-12-31` };
    ensureWithinLimits(ctx, snap);
    if (residenceOf(snap) === 'CZ') {
      const cz = await czModel(ctx, args.year);
      const report = cz.model.report;
      const warnings = [...cz.warnings, 'estimate_not_tax_advice'];
      if (report.missingFx.length) warnings.push(`missing_fx:${report.missingFx.length}`);
      if (report.unmatched.length) warnings.push(`unmatched_sells:${report.unmatched.length}`);
      if (report.unresolvedTickers.length) warnings.push(`unresolved_asset_kind:${report.unresolvedTickers.join(',')}`);
      const sink = factSink(ctx, warnings), base = { source: 'cz_tax_model', as_of: cz.asOf, currency: 'CZK', period };
      sink.add(`tax:${args.year}:tax_base`, report.taxBaseCzk, 'money', base);
      sink.add(`tax:${args.year}:estimated_tax`, report.estTaxCzk, 'money', base);
      sink.add(`tax:${args.year}:proceeds`, report.proceedsCzk, 'money', base);
      sink.add(`tax:${args.year}:limit_base`, report.limitBaseCzk, 'money', base);
      sink.add(`tax:${args.year}:under_limit`, report.underLimit, 'boolean', { ...base, currency: null });
      return success(ctx, { residence: 'CZ', model: czView(cz.model) }, sink.facts, meta({ snapshotId: cz.snapshotId, period,
        complete: cz.complete && report.complete, warnings }));
    }
    const model = foreignModel(ctx, snap, snap.settings.taxResidence, args.year);
    const report = model.report;
    const warnings = [...loaded.meta.warnings, 'estimate_not_tax_advice', ...report.warnings.map(w => `tax:${JSON.stringify(w).slice(0, 120)}`)];
    const sink = factSink(ctx, warnings), base = { source: `${report.residence.toLowerCase()}_tax_engine`, as_of: loaded.meta.asOf, currency: report.currency, period };
    sink.add(`tax:${args.year}:taxable_base`, report.taxableBase, 'money', base);
    sink.add(`tax:${args.year}:estimated_tax`, report.estimatedTax, 'money', base);
    return success(ctx, { residence: report.residence, model: { status: 'ready', report } }, sink.facts,
      meta({ snapshotId: loaded.meta.snapshotId, period, complete: loaded.meta.complete && report.complete, warnings }));
  },
});

/* ----------------------------- get_tax_lots ----------------------------- */

type LotsData = { lots: CzTaxModel['lots'] | TaxOpenLot[]; residence: TaxResidence };
const lotsInput = object({ ticker: tickerSchema, scope: scopeSchema });
const taxLots = defineTool<{ ticker?: string; scope?: Scope }, LotsData>({
  name: 'get_tax_lots', group: 'dane',
  description: 'Open purchase lots (FIFO) for the user\'s tax residence: for Czech residents with the time-test exemption date; other countries without it. At most 50 lots.',
  inputSchema: lotsInput, parse: parseWith(lotsInput),
  outputSchema: open({ lots: arrayOf(open({ ticker: { type: 'string' }, shares: num }, ['ticker', 'shares']), MAX_ROWS), residence: { type: 'string' } }, ['lots', 'residence']),
  async run(args, ctx) {
    const loaded = await ctx.loadSnapshot();
    const snap = loaded.data, year = yearOf(ctx.today);
    ensureWithinLimits(ctx, snap);
    const ticker = args.ticker ? (await resolveTicker(ctx, args.ticker)).ticker : undefined;
    requireScope(ctx, snap.transactions.filter(t => ctx.lib.isRealTradeTx(t)), args.scope);
    let lots: LotsData['lots'], residence: TaxResidence, warnings: string[], complete: boolean;
    if (residenceOf(snap) === 'CZ') {
      const cz = await czModel(ctx, year);
      // allLots: lots of unpriced or dust holdings remain lots for tax purposes.
      lots = cz.model.allLots.filter(l => (!ticker || l.ticker.toUpperCase() === ticker) && scopeMatches(args.scope, l.broker, l.account));
      residence = 'CZ'; warnings = [...cz.warnings]; complete = cz.complete;
    } else {
      const report = foreignModel(ctx, snap, snap.settings.taxResidence, year).report;
      // Foreign lots carry no broker; a scope narrows them by account only.
      lots = report.openLots.filter(l => (!ticker || l.ticker.toUpperCase() === ticker) && (!args.scope || 'all' in args.scope || l.account === args.scope.account));
      residence = report.residence; warnings = [...loaded.meta.warnings]; complete = loaded.meta.complete && report.complete;
    }
    const sink = factSink(ctx, warnings), base = { source: 'tax_lots', as_of: loaded.meta.asOf, ticker };
    sink.add(`lots:${ticker ?? 'all'}:shares`, (lots as { shares: number }[]).reduce((s, l) => s + l.shares, 0), 'shares', base);
    sink.add(`lots:${ticker ?? 'all'}:count`, lots.length, 'count', base);
    for (const [i, lot] of lots.slice(0, MAX_ROWS).entries()) {
      // Ordinals identify lots only inside this result; underlying buy/account IDs stay local.
      const key = `lots:lot_${i + 1}`, lotBase = { ...base, ticker: lot.ticker };
      sink.add(`${key}:shares`, lot.shares, 'shares', lotBase);
      sink.add(`${key}:acquired`, 'acquiredDate' in lot ? lot.acquiredDate : lot.acquired, 'date', lotBase);
      if ('exemptFrom' in lot) {
        sink.add(`${key}:exempt_date`, lot.exemptFrom, 'date', lotBase);
        sink.add(`${key}:exempt`, lot.exempt, 'boolean', lotBase);
      }
    }
    return success(ctx, { lots: lots.slice(0, MAX_ROWS), residence }, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, scope: args.scope,
      complete, warnings, omittedRows: Math.max(0, lots.length - MAX_ROWS) }));
  },
});

/* ----------------------------- simulate_sale ----------------------------- */

type SaleArgs = { ticker: string; shares: number; priceUsd: number; feeUsd?: number; at?: string; broker?: string; account?: string; accountChoice?: string;
  saleFx?: number; assumedLocalFx?: number; lots?: { buyId: string; shares: number }[] };
const positive = { type: 'number', exclusiveMinimum: 0 };
const saleInput = object({ ticker: tickerSchema, shares: positive, priceUsd: positive, feeUsd: { type: 'number', minimum: 0 },
  accountChoice: { type: 'string', pattern: '^choice_[1-9][0-9]*$' },
  at: { type: 'string', format: 'date-time' }, broker: { type: 'string', minLength: 1, maxLength: 64 }, account: { type: 'string', maxLength: 128 },
  saleFx: positive, assumedLocalFx: positive,
  lots: arrayOf(object({ buyId: { type: 'string', minLength: 1, maxLength: 128 }, shares: positive }, ['buyId', 'shares']), 50) },
['ticker', 'shares', 'priceUsd']);
const pragueYear = (at: string, ctx: ToolCtx) => yearOf(ctx.lib.pragueDate(at));
const simulateSale = defineTool<SaleArgs, SaleModelResult>({
  name: 'simulate_sale', group: 'dane',
  description: 'Hypothetical sale of shares from one account at a given USD price: tax effect under the user\'s residence. An account is required when several hold the ticker; omitted fee, date and FX are explicit assumptions.',
  inputSchema: saleInput,
  parse: parseWith<SaleArgs>(saleInput, a => {
    if ((a.broker === undefined) !== (a.account === undefined)) throw new ToolInputError('invalid', 'Give both broker and account, or neither.');
    if (a.accountChoice && a.broker !== undefined) throw new ToolInputError('invalid', 'Give one account selection only.');
  }),
  outputSchema: open({ jurisdiction: { type: 'string' }, result: { type: 'object' } }, ['jurisdiction', 'result']),
  async run(args, ctx) {
    const loaded = await ctx.loadSnapshot();
    const snap = loaded.data;
    ensureWithinLimits(ctx, snap);
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const kind = residenceOf(snap);
    const warnings = [...loaded.meta.warnings], sink = factSink(ctx, warnings);
    let broker = args.broker, account = args.account;
    if (args.accountChoice) ({ broker, account } = selectedAccount(ctx, ticker, args.accountChoice));
    if (broker === undefined || account === undefined) {
      // The UI may preselect an account; the assistant never guesses between several.
      const resolved = ctx.lib.resolveSaleAccount(ticker, snap.transactions.filter(t => ctx.lib.isRealTradeTx(t)));
      if (resolved.status === 'clarify') {
        if (!resolved.choices.length) throw new ToolInputError('invalid', `No open lots of ${ticker} to sell.`);
        throw new ToolInputError('clarify', `Which account sells ${ticker}? ${resolved.choices.map(c => `${c.broker} / ${c.account || '-'}`).join('; ')}`,
          resolved.choices.map((c, i) => ({ id: `choice_${i + 1}`, broker: c.broker, account: c.account })));
      }
      broker = resolved.broker; account = resolved.account;
      warnings.push('account_only_holder');
    }
    const at = args.at ?? `${ctx.today}T12:00:00.000Z`, feeUsd = args.feeUsd ?? 0, asOf = loaded.meta.asOf;
    const origin = (given: unknown) => given === undefined ? 'assumption' : 'user';
    const input = { source: 'user', as_of: asOf, ticker };
    sink.add(`sale:${ticker}:shares`, args.shares, 'shares', input);
    sink.add(`sale:${ticker}:price`, args.priceUsd, 'money', { ...input, currency: 'USD' });
    sink.add(`sale:${ticker}:fee`, feeUsd, 'money', { ...input, source: origin(args.feeUsd), currency: 'USD' });
    sink.add(`sale:${ticker}:date`, at, 'date', { ...input, source: origin(args.at) });
    if (args.assumedLocalFx !== undefined) sink.add(`sale:${ticker}:assumed_local_fx`, args.assumedLocalFx, 'ratio', input);
    const sale: SaleRequest = { ticker, broker, account, shares: args.shares, priceUsd: args.priceUsd, feeUsd, at, saleFx: 0,
      ...(args.assumedLocalFx !== undefined ? { assumedLocalFx: args.assumedLocalFx } : {}), ...(args.lots ? { lots: args.lots } : {}) };
    let result: SaleModelResult, complete: boolean;
    try {
      if (kind === 'CZ') {
        const year = pragueYear(at, ctx);
        if (year > yearOf(ctx.today)) throw new ToolInputError('invalid', 'Simulations are limited to the current tax year.');
        const cz = await czModel(ctx, year);
        sale.saleFx = args.saleFx ?? cz.usdCzk;
        sink.add(`sale:${ticker}:sale_fx`, sale.saleFx, 'ratio', { ...input, source: origin(args.saleFx) });
        const simulated = compute(ctx, snap, `cz_sale:${year}:${JSON.stringify(sale)}`, ['cz_sale'],
          () => ctx.lib.computeSaleModel({ jurisdiction: 'CZ', model: cz.model, transactions: snap.transactions, sale }));
        if (simulated.jurisdiction !== 'CZ') throw new Error('Unexpected jurisdiction');
        warnings.push(...cz.warnings);
        complete = cz.complete && simulated.result.complete && simulated.result.yearComplete;
        result = simulated;
      } else {
        const residence = snap.settings.taxResidence as Country;
        // saleFx is the Czech engine's input; the foreign engines take statutory rates or assumedLocalFx.
        sale.saleFx = 1;
        const model = foreignModel(ctx, snap, residence, yearOf(at));
        const foreign = compute(ctx, snap, `foreign_sale:${residence}:${JSON.stringify(sale)}`, ['foreign_sale'],
          () => ctx.lib.computeSaleModel({ jurisdiction: residence, model, sale }));
        if (foreign.jurisdiction === 'CZ') throw new Error('Unexpected jurisdiction');
        complete = loaded.meta.complete && foreign.result.after.complete;
        result = foreign;
      }
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      throw new ToolInputError('invalid', error instanceof Error ? error.message : 'The sale cannot be simulated.');
    }
    const base = { source: 'sale_simulation', as_of: asOf, ticker };
    if (result.jurisdiction === 'CZ') {
      const r = result.result, czk = { ...base, currency: 'CZK' };
      sink.add(`sale:${ticker}:proceeds`, r.proceedsCzk, 'money', czk);
      sink.add(`sale:${ticker}:gain`, r.gainCzk, 'money', czk);
      sink.add(`sale:${ticker}:taxable_gain`, r.taxableGainCzk, 'money', czk);
      sink.add(`sale:${ticker}:extra_tax`, r.extraTaxCzk, 'money', czk);
      sink.add(`sale:${ticker}:missing_shares`, r.missingShares, 'shares', base);
      if (r.missingShares > 0) warnings.push('shares_exceed_account');
    } else {
      const r = result.result, local = { ...base, currency: r.after.currency };
      sink.add(`sale:${ticker}:tax_delta`, r.taxDelta, 'money', local);
      sink.add(`sale:${ticker}:estimated_tax_after`, r.after.estimatedTax, 'money', local);
    }
    return success(ctx, result, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, scope: { broker, account }, complete, warnings }));
  },
});

export const taxTools = [realized, taxReport, taxLots, simulateSale];
