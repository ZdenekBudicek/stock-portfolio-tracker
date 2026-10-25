import type { Assumptions, CompanyFundamentals, FundamentalMetric, MarketContext, Multiple } from '../../_lib/trackora-lib.js';
import { toolRead } from '../context.ts';
import type { MarketValue } from '../marketTypes.ts';
import { type Fact, ToolInputError, type ToolCtx } from '../types.ts';
import { arrayOf, defineTool, factSchema, factSink, marketSnapshotId, meta, numOrNull, object, open, parseWith, resolveTicker,
  success, tickerSchema, unavailable, worst } from './common.ts';

const YEARS_OF_PRICES = 6;
const SHARE_METRICS = new Set<FundamentalMetric>(['sharesOutstanding', 'dilutedShares']);
const MULTIPLES: readonly Multiple[] = ['pe', 'ps', 'pfcf', 'evEbitda'];

async function fundamentalsOf(ctx: ToolCtx, input: string): Promise<{ ticker: string; value: MarketValue<CompanyFundamentals> & { data: CompanyFundamentals } }> {
  const { ticker, assetType } = await resolveTicker(ctx, input);
  if (assetType === 'crypto') throw new ToolInputError('unsupported', 'Company statements and valuation do not apply to crypto.');
  const value = await ctx.market.fundamentals(ticker, toolRead(ctx));
  if (!value.data) return unavailable(`No financial statements for ${ticker}.`);
  return { ticker, value: value as MarketValue<CompanyFundamentals> & { data: CompanyFundamentals } };
}
async function closesOf(ctx: ToolCtx, ticker: string) {
  const from = `${Number(ctx.today.slice(0, 4)) - YEARS_OF_PRICES}${ctx.today.slice(4)}`;
  const history = await ctx.market.history(ticker, { from, to: ctx.today }, toolRead(ctx));
  return { history, closes: (history.data ?? []).map(p => ({ date: p.date, close: p.close })) };
}

/** First day of the period a statement covers: the month 12 (annual) or 3 (quarterly) months back from its end. */
function periodStart(end: string, months: number): string {
  const [y, m] = end.split('-').map(Number);
  const index = y * 12 + (m - 1) - (months - 1);
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}-01`;
}

/* ----------------------------- get_fundamentals ----------------------------- */

const tickerInput = object({ ticker: tickerSchema }, ['ticker']);
const fundamentals = defineTool<{ ticker: string }, { metrics: Fact[] }>({
  name: 'get_fundamentals', group: 'valuace',
  description: 'Latest annual and quarterly financial statement figures (revenue, profit, cash flow, EPS, cash, debt, shares, …) as facts with their period and reporting currency. Unreported metrics are left out.',
  inputSchema: tickerInput, parse: parseWith(tickerInput),
  outputSchema: open({ metrics: arrayOf(factSchema) }, ['metrics']),
  async run(args, ctx) {
    const { ticker, value } = await fundamentalsOf(ctx, args.ticker);
    const f = value.data, warnings = [...value.warnings], sink = factSink(ctx, warnings);
    for (const [kind, series, months] of [['annual', f.annual, 12], ['quarterly', f.quarterly, 3]] as const) {
      const last = series.periods.length - 1;
      if (last < 0) { warnings.push(`no_${kind}_statements`); continue; }
      const end = series.periods[last];
      for (const [metric, values] of Object.entries(series.values) as [FundamentalMetric, (number | null)[] | undefined][]) {
        const v = values?.[last];
        if (v === null || v === undefined) continue;
        sink.add(`fundamentals:${ticker}:${kind}:${metric}`, v, SHARE_METRICS.has(metric) ? 'shares' : 'money', { source: value.source, as_of: end,
          ticker, currency: SHARE_METRICS.has(metric) ? null : f.currency, period: { from: periodStart(end, months), to: end } });
      }
    }
    return success(ctx, { metrics: sink.facts }, sink.facts, meta({ snapshotId: marketSnapshotId(value), complete: value.freshness === 'fresh', warnings, freshness: value.freshness }));
  },
});

/* ----------------------------- get_valuation_history ----------------------------- */

type ValuationData = { multiples: Fact[]; median5y: Fact[]; percentiles: Fact[]; sectorComparison: Fact[] };
const valuationHistory = defineTool<{ ticker: string }, ValuationData>({
  name: 'get_valuation_history', group: 'valuace',
  description: 'Current P/E, P/S, P/FCF and EV/EBITDA from stored prices and statements, their 5-year median and the current percentile (share of past values at or below today, with history length). No sector comparison is available.',
  inputSchema: tickerInput, parse: parseWith(tickerInput),
  outputSchema: open({ multiples: arrayOf(factSchema), median5y: arrayOf(factSchema), percentiles: arrayOf(factSchema), sectorComparison: { type: 'array', maxItems: 0 } },
    ['multiples', 'median5y', 'percentiles', 'sectorComparison']),
  async run(args, ctx) {
    const { ticker, value } = await fundamentalsOf(ctx, args.ticker);
    const { history, closes } = await closesOf(ctx, ticker);
    const fiveYears = `${Number(ctx.today.slice(0, 4)) - 5}${ctx.today.slice(4)}`;
    const points = ctx.lib.valuationSeries(value.data, closes).filter(p => p.date >= fiveYears);
    const warnings = [...value.warnings, ...history.warnings, 'sector_comparison_unavailable'], sink = factSink(ctx, warnings);
    const data: ValuationData = { multiples: [], median5y: [], percentiles: [], sectorComparison: [] };
    for (const m of MULTIPLES) {
      const series = points.filter(p => p[m] !== null);
      warnings.push(`history_points:${m}:${series.length}`);
      if (!series.length) continue;
      const current = series[series.length - 1], now = current[m]!;
      const base = { source: `valuation_series:${history.source}`, as_of: current.date, ticker };
      const span = { ...base, period: { from: series[0].date, to: current.date } };
      const push = (list: Fact[], fact: Fact | null) => { if (fact) list.push(fact); };
      push(data.multiples, sink.add(`valuation:${ticker}:current:${m}`, now, 'ratio', base));
      push(data.median5y, sink.add(`valuation:${ticker}:median_5y:${m}`, ctx.lib.medianOf(series, m), 'ratio', span));
      push(data.percentiles, sink.add(`valuation:${ticker}:percentile:${m}`, series.filter(p => p[m]! <= now).length / series.length, 'ratio', span));
    }
    return success(ctx, data, sink.facts, meta({ snapshotId: marketSnapshotId(value), warnings, complete: data.multiples.length > 0,
      freshness: worst(value.freshness, history.freshness === 'missing' ? 'stale' : history.freshness) }));
  },
});

/* ----------------------------- get_fair_value ----------------------------- */

type FairValue = ReturnType<ToolCtx['lib']['calculateFairValue']> & { scenarios: ReturnType<ToolCtx['lib']['priceScenarios']> };
const rate = (min: number, max: number) => ({ type: 'number', minimum: min, maximum: max });
const multiple = { type: 'number', exclusiveMinimum: 0, maximum: 200 };
const assumptionsSchema = object({ growth: rate(-0.5, 1), discount: rate(0.01, 0.5), terminalGrowth: rate(-0.05, 0.1), pe: multiple, pfcf: multiple,
  ps: { type: 'number', exclusiveMinimum: 0, maximum: 100 }, pb: { type: 'number', exclusiveMinimum: 0, maximum: 50 }, epsGrowth: rate(-0.5, 1),
  years: { type: 'integer', minimum: 1, maximum: 30 }, dividendGrowth: rate(-0.5, 0.5), fcfMode: { type: 'string', enum: ['latest', 'average3', 'normalized'] },
  includeNetCash: { type: 'boolean' }, revenueGrowth: rate(-0.5, 1.5), targetMargin: rate(0.01, 0.6), dilution: rate(0, 0.05) });
// `years`: the horizon of the price scenarios (Ocenění v2), 3 when not asked.
const fairInput = object({ ticker: tickerSchema, assumptions: assumptionsSchema, years: { type: 'integer', minimum: 1, maximum: 10 } }, ['ticker']);
const unitOf = (key: keyof Assumptions) => key === 'years' ? 'count' as const : key === 'fcfMode' ? 'text' as const : key === 'includeNetCash' ? 'boolean' as const : 'ratio' as const;
const fairValue = defineTool<{ ticker: string; assumptions?: Partial<Assumptions>; years?: number }, FairValue>({
  name: 'get_fair_value', group: 'valuace',
  description: 'Fair value per share from the Trackora valuation (fast growers: revenue → margin DCF and forward P/E from analyst consensus; others: DCF, multiples, Graham, dividends weighted by company type) with margin of safety, potential, reverse DCF, a 3×3 discount/growth sensitivity, the fair value against analyst targets and bear/base/bull price scenarios for `years` years. Default assumptions are labelled as assumptions; user-given ones as user input.',
  inputSchema: fairInput, parse: parseWith(fairInput),
  outputSchema: open({ value: numOrNull, methods: { type: 'object' }, weights: { type: 'object' }, marginOfSafety: numOrNull, potential: numOrNull,
    reverse: { type: 'object' }, sensitivity: open({ discounts: arrayOf({ type: 'number' }, 3), growths: arrayOf({ type: 'number' }, 3), cells: arrayOf(arrayOf({ type: 'object' }, 3), 3) },
      ['discounts', 'growths', 'cells']) }, ['value', 'methods', 'marginOfSafety', 'potential', 'reverse', 'sensitivity']),
  async run(args, ctx) {
    const { ticker, value } = await fundamentalsOf(ctx, args.ticker);
    const [{ history, closes }, quote] = await Promise.all([closesOf(ctx, ticker), ctx.market.quote(ticker, toolRead(ctx))]);
    const f = value.data, price = quote.data && quote.data.currency === f.currency ? quote.data.price : null;
    // Ocenění v2: analyst consensus and targets from the nightly snapshot; without them the model uses recent growth.
    const view = await ctx.market.analysts(ticker, toolRead(ctx)).catch(() => null);
    const a = view?.data;
    const market: MarketContext | null = a ? { estimates: a.estimates ?? null, estimatesCurrency: a.estimatesCurrency ?? null, targetMean: a.targetMean,
      targetLow: a.targetLow, targetHigh: a.targetHigh, targetCurrency: a.currency, asOf: ctx.today,
      analystCount: (Object.values(a.counts) as (number | null)[]).reduce<number>((sum, n) => sum + (n ?? 0), 0) || null } : null;
    const defaults = ctx.lib.defaultAssumptions(f, closes, market).assumptions;
    const assumptions: Assumptions = { ...defaults, ...(args.assumptions ?? {}) };
    if (assumptions.terminalGrowth >= assumptions.discount) throw new ToolInputError('invalid', 'Terminal growth must be below the discount rate.');
    const result = ctx.lib.calculateFairValue(f, price, assumptions, closes, market);
    const years = args.years ?? 3;
    const scenarios = ctx.lib.priceScenarios(f, price, years, market, closes);
    const warnings = [...value.warnings, ...history.warnings.map(w => `history:${w}`), `company_type:${result.companyType}`, `valuation_model:${result.model}`];
    if (result.model === 'revenue') warnings.push(result.growthSource === 'consensus' ? 'growth_from_consensus' : 'growth_from_recent_quarters');
    if (result.analystCheck?.status === 'outside') warnings.push('fair_value_outside_analyst_range');
    if (price === null) warnings.push(quote.data ? 'price_currency_mismatch' : 'price_missing');
    if (result.reason) warnings.push(`fair_value_unavailable:${result.reason}`);
    const sink = factSink(ctx, warnings);
    // The valuation is as of the newest statement it uses; price-relative figures as of the quote.
    const model = { source: 'fair_value_model', as_of: value.asOf, ticker, currency: f.currency };
    sink.add(`fair_value:${ticker}:value`, result.value, 'money', model);
    for (const [method, estimate] of Object.entries(result.methods)) {
      if (estimate.value !== null) sink.add(`fair_value:${ticker}:method:${method}`, estimate.value, 'money', model);
    }
    if (quote.data && price !== null) {
      const atQuote = { source: `fair_value_model:${quote.source}`, as_of: quote.asOf, ticker };
      sink.add(`quote:${ticker}:price`, quote.data.price, 'money', { source: quote.source, as_of: quote.asOf, ticker, currency: quote.data.currency });
      sink.add(`fair_value:${ticker}:margin_of_safety`, result.marginOfSafety, 'ratio', atQuote);
      sink.add(`fair_value:${ticker}:potential`, result.potential, 'ratio', atQuote);
      if (result.reverse.value !== null) sink.add(`fair_value:${ticker}:implied_growth`, result.reverse.value, 'ratio', atQuote);
    }
    // What the reverse DCF solves for: revenue growth (growth model) or FCF growth.
    sink.add(`fair_value:${ticker}:model`, result.model, 'text', model);
    sink.add(`fair_value:${ticker}:company_type`, result.companyType, 'text', model);
    if (result.forward) sink.add(`fair_value:${ticker}:forward_eps`, result.forward.eps, 'money', { ...model, source: `analyst_consensus:${view?.source ?? 'snapshot'}` });
    if (result.analystCheck) sink.add(`fair_value:${ticker}:analyst_check`, result.analystCheck.status, 'text', model);
    // Price scenarios (Ocenění v2): stated assumptions and prices, never a forecast.
    for (const s of scenarios.scenarios) {
      const id = `scenario:${ticker}:${s.kind}`, at = { source: 'scenario_model', as_of: value.asOf, ticker };
      sink.add(`${id}:price`, s.price, 'money', { ...at, currency: f.currency });
      sink.add(`${id}:assumption:growth`, s.startGrowth, 'ratio', { ...at, source: 'assumption' });
      sink.add(`${id}:assumption:${s.basis === 'sales' ? 'ps' : 'pe'}`, s.multiple, 'ratio', { ...at, source: 'assumption' });
      if (s.netMargin !== null) sink.add(`${id}:assumption:margin`, s.netMargin, 'ratio', { ...at, source: 'assumption' });
      if (s.annual !== null && quote.data) sink.add(`${id}:annual_return`, s.annual, 'ratio', { ...at, as_of: quote.asOf });
    }
    if (scenarios.scenarios.length) sink.add(`scenario:${ticker}:basis`, scenarios.scenarios[0].basis, 'text', { source: 'scenario_model', as_of: value.asOf, ticker });
    for (const key of Object.keys(assumptions) as (keyof Assumptions)[]) {
      const given = args.assumptions?.[key] !== undefined;
      sink.add(`fair_value:${ticker}:assumption:${key}`, assumptions[key], unitOf(key), { source: given ? 'user' : 'assumption',
        as_of: value.asOf, ticker });
    }
    return success(ctx, { ...result, scenarios }, sink.facts, meta({ snapshotId: marketSnapshotId(value), warnings, complete: result.value !== null && price !== null,
      freshness: worst(value.freshness, quote.freshness === 'missing' ? 'stale' : quote.freshness) }));
  },
});

export const valuationTools = [fundamentals, valuationHistory, fairValue];
