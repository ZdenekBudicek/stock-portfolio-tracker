import manifest from '../../_lib/manifest.json' with { type: 'json' };
import { factScope, isKnownTicker, markUnverifiedTicker, registerFact, toolRead, workLedger } from '../context.ts';
import type { Period, PortfolioSnapshot, Scope } from '../dataTypes.ts';
import type { MarketValue } from '../marketTypes.ts';
import { isCalendarDate, validateSchema } from '../schema.ts';
import { type Fact, type FactUnit, type Freshness, type JsonSchema, type ResultMeta, type ToolCtx, type ToolDef,
  ToolInputError, type ToolResult } from '../types.ts';
import type { WorkKind } from '../workBudget.ts';

export const MAX_ROWS = 50;
/** Live quote lookups in flight at once for one portfolio (audit A5): a large portfolio queues, it does not burst the shared providers. */
export const QUOTE_CONCURRENCY = 6;
/** `work` over `items` with at most `limit` running at once; results in the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}
export const CALCULATION_VERSION: string = manifest.calculationVersion;

/* ----------------------------- schema building blocks ----------------------------- */

export const object = (properties: Record<string, JsonSchema>, required: string[] = [], extra: JsonSchema = {}): JsonSchema =>
  ({ type: 'object', additionalProperties: false, properties, required, ...extra });
export const open = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required });
export const dateSchema: JsonSchema = { type: 'string', format: 'date', description: 'YYYY-MM-DD' };
export const periodSchema: JsonSchema = object({ from: dateSchema, to: dateSchema }, ['from', 'to']);
export const tickerSchema: JsonSchema = { type: 'string', minLength: 1, maxLength: 32, pattern: "^[\\p{L}\\p{N}][\\p{L}\\p{N} .&'-]*$",
  description: 'Ticker or instrument name as the user wrote it, e.g. AAPL, bitcoin, Rocket Lab' };
export const scopeSchema: JsonSchema = { anyOf: [
  object({ broker: { type: 'string', minLength: 1, maxLength: 64 }, account: { type: 'string', maxLength: 128 } }, ['broker', 'account']),
  object({ all: { const: true } }, ['all']),
], description: 'One broker account, or all accounts (default)' };
export const currencySchema: JsonSchema = { type: 'string', enum: ['USD', 'CZK', 'EUR', 'GBP', 'PLN'] };
export const num: JsonSchema = { type: 'number' };
export const numOrNull: JsonSchema = { type: ['number', 'null'] };
export const strOrNull: JsonSchema = { type: ['string', 'null'] };
export const factSchema: JsonSchema = open({ id: { type: 'string' }, value: { type: ['number', 'string', 'boolean', 'null'] },
  unit: { enum: ['money', 'shares', 'percent', 'ratio', 'count', 'date', 'text', 'boolean'] }, source: { type: 'string', minLength: 1 },
  as_of: { type: 'string', minLength: 1 } }, ['id', 'value', 'unit', 'source', 'as_of']);
export const arrayOf = (items: JsonSchema, maxItems?: number): JsonSchema => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
export const quoteSchema: JsonSchema = open({ ticker: { type: 'string' }, price: num, currency: { type: 'string' }, previousClose: numOrNull,
  changePct: numOrNull, kind: { enum: ['quote', 'close', 'cost'] } }, ['ticker', 'price', 'currency', 'previousClose', 'changePct', 'kind']);

/* ----------------------------- parsing ----------------------------- */

/** Schema validation first, then the given semantic checks; both fail as `invalid` before any read. */
export function parseWith<A>(schema: JsonSchema, check: (args: A) => void = () => {}) {
  return (raw: unknown): A => {
    const errors = validateSchema(schema, raw);
    if (errors.length) throw new ToolInputError('invalid', `Invalid arguments: ${errors.slice(0, 3).join('; ')}`);
    const args = raw as A;
    check(args);
    return args;
  };
}
export function checkPeriod(period: Period): void {
  if (!isCalendarDate(period.from) || !isCalendarDate(period.to)) throw new ToolInputError('invalid', 'Dates must be real calendar dates.');
  if (period.from > period.to) throw new ToolInputError('invalid', 'The period starts after it ends.');
  if (period.from < '1990-01-01') throw new ToolInputError('invalid', 'The period starts before any supported data.');
}
export const periodOf = (args: { from: string; to: string }): Period => ({ from: args.from, to: args.to });
export const yearOf = (date: string) => Number(date.slice(0, 4));
/** Per-year models loop over the calendar years of a period: a bounded period bounds the loop. */
export const MAX_PERIOD_YEARS = 30;
export function checkPeriodYears(period: Period): void {
  if (yearOf(period.to) - yearOf(period.from) > MAX_PERIOD_YEARS) throw new ToolInputError('invalid', 'The period is too long.');
}
export const yearsOf = (period: Period) => Array.from({ length: yearOf(period.to) - yearOf(period.from) + 1 }, (_, i) => yearOf(period.from) + i);

/* ----------------------------- guards ----------------------------- */

const sizeOf = (snapshot: PortfolioSnapshot) => ({ transactions: snapshot.transactions.length, snapshots: snapshot.snapshots.length });
/** Measured CPU envelope: an oversized history is refused before any read of market data or synchronous model. */
export function ensureWithinLimits(ctx: ToolCtx, snapshot: PortfolioSnapshot): void {
  workLedger(ctx).run('limits', sizeOf(snapshot), [], () => null);
}
/**
 * Runs one synchronous model over the full history, once per `key` in this request. Its estimated cost
 * (`kinds`) is charged to the request's work budget before it starts; over budget, the tool is refused
 * with a human message — the model never starts and nothing is truncated.
 */
export function compute<T>(ctx: ToolCtx, snapshot: PortfolioSnapshot, key: string, kinds: readonly WorkKind[], work: () => T): T {
  return workLedger(ctx).run(key, sizeOf(snapshot), kinds, work);
}

/* ----------------------------- tickers ----------------------------- */

/** Registry first (aliases, names, coin collisions); then tickers the user has traded or watches. */
export async function resolveTicker(ctx: ToolCtx, input: string): Promise<{ ticker: string; assetType: 'stock' | 'etf' | 'crypto' }> {
  const { data: snapshot } = await ctx.loadSnapshot();
  const resolution = await ctx.market.resolveTicker(input, snapshot.registry, toolRead(ctx));
  if (resolution.status === 'resolved') {
    if (resolution.unverified) markUnverifiedTicker(ctx, resolution.ticker);
    return { ticker: resolution.ticker, assetType: resolution.assetType };
  }
  if (resolution.status === 'ambiguous') {
    throw new ToolInputError('clarify', `Ambiguous instrument "${input}": ${resolution.candidates.join(', ')} (stock or crypto?)`);
  }
  const upper = input.trim().toUpperCase();
  const known = new Set([...snapshot.transactions, ...snapshot.dividends, ...snapshot.watchlist].map(r => String(r.ticker).toUpperCase()));
  if ((known.has(upper) || isKnownTicker(ctx, upper)) && /^[A-Z][A-Z0-9.-]{0,19}$/.test(upper)) return { ticker: upper, assetType: 'stock' };
  throw new ToolInputError('clarify', `Unknown instrument "${input}"; ask for the exact ticker.`);
}

/* ----------------------------- facts and results ----------------------------- */

export type FactSource = { source: string; as_of: string | null; currency?: string | null; ticker?: string | null; period?: Period | null };

/**
 * Collects facts for one result. A fact needs an observation time from its source: without one it
 * is recorded as a warning and left out, never stamped with today's date.
 */
export function factSink(ctx: ToolCtx, warnings: string[]) {
  const facts: Fact[] = [];
  const add = (id: string, value: Fact['value'] | undefined, unit: FactUnit, from: FactSource): Fact | null => {
    if (value === undefined) return null;
    if (!from.as_of) { warnings.push(`fact_undated:${id}`); return null; }
    if (typeof value === 'number' && !Number.isFinite(value)) { warnings.push(`fact_not_finite:${id}`); return null; }
    if (unit === 'money' && value !== null && !from.currency) warnings.push(`currency_unknown:${id}`);
    const fact: Fact = { id, value, unit, source: from.source, as_of: from.as_of,
      ...(from.currency ? { currency: from.currency } : {}), ...(from.ticker ? { ticker: from.ticker } : {}),
      ...(from.period ? { period: from.period } : {}) };
    if (!facts.includes(fact)) facts.push(fact);
    return fact;
  };
  return { facts, add };
}

export function meta(input: Partial<ResultMeta> & { snapshotId: string }): ResultMeta {
  return { scope: input.scope ?? { all: true }, ...(input.period ? { period: input.period } : {}), complete: input.complete ?? true,
    warnings: [...new Set(input.warnings ?? [])], omittedRows: input.omittedRows ?? 0, snapshotId: input.snapshotId,
    calculationVersion: CALCULATION_VERSION, freshness: input.freshness ?? 'fresh',
    ...(input.valuationFallback ? { valuationFallback: input.valuationFallback } : {}) };
}
export const marketSnapshotId = (value: MarketValue<unknown>) => `market:${value.source}:${value.asOf ?? value.fetchedAt ?? 'undated'}`;
export function worst(...values: Freshness[]): Freshness {
  return values.includes('missing') ? 'missing' : values.includes('stale') ? 'stale' : 'fresh';
}
export function success<R>(ctx: ToolCtx, data: R, facts: Fact[], resultMeta: ResultMeta): ToolResult<R> {
  const bound = new Map(facts.map(f => [f, ctx.facts.get(f.id) === f ? f : registerFact(ctx, { ...f,
    metric: f.metric ?? f.id, scope: f.scope ?? factScope(ctx, resultMeta.scope),
    quality: f.quality ?? { state: f.value === null ? 'unknown' : resultMeta.complete && (f.unit !== 'money' || !!f.currency) ? 'complete' : 'incomplete', freshness: resultMeta.freshness } })]));
  // Some tool data embeds its facts. Keep those references identical to the registered evidence.
  const replace = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (bound.has(value as Fact)) return bound.get(value as Fact);
    if (Array.isArray(value)) return value.map(replace);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
  };
  return { ok: true, data: replace(data) as R, facts: [...bound.values()], meta: resultMeta };
}
export function unavailable(message: string): never {
  throw new ToolInputError('unavailable', message);
}
export const scopeMatches = (scope: Scope | undefined, broker: string, account: string | null | undefined) =>
  !scope || 'all' in scope || (broker.toUpperCase() === scope.broker.toUpperCase() && (account ?? '') === scope.account);
export const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';

export function defineTool<A, R>(def: ToolDef<A, R>): ToolDef<A, R> {
  return Object.freeze(def);
}
