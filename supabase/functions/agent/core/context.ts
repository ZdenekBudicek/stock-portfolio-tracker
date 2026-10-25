import manifest from '../_lib/manifest.json' with { type: 'json' };
import type { CalculationCache } from '../_lib/trackora-lib.js';
import type { Loaded, PortfolioSnapshot, ReadContext, Scope } from './dataTypes.ts';
import type { Fact, ToolCtx, ToolResult } from './types.ts';
import { createWorkLedger, type WorkLedger, type WorkPolicy } from './workBudget.ts';

export type ToolRun = { name: string; args: unknown; result: ToolResult<unknown> };
// `known`: instrument tickers a market tool of this request named (peers); they resolve like stored instruments.
// `unverified`: symbols used although no provider could verify them (Běh 24); the answer says so.
type Request = { read: ReadContext; cache: CalculationCache; memo: Map<string, Promise<unknown>>; runs: ToolRun[]; scopes: string[]; work: WorkLedger;
  known: Set<string>; unverified: Set<string> };
// Keyed by the request's fact map, which every per-tool view of the context shares by reference.
const requests = new WeakMap<Map<string, Fact>, Request>();

/**
 * One context per chat request: facts, calculations, snapshot, models and the CPU work budget never
 * outlive it. `workPolicy` defaults to the measured policy distributed with the calculation bundle.
 */
export function createToolContext(deps: Omit<ToolCtx, 'facts' | 'calculations' | 'loadSnapshot'>,
  options: { workPolicy?: WorkPolicy } = {}): ToolCtx {
  const facts = new Map<string, Fact>();
  // Shared reads use the request deadline, so one tool's 8 s timeout cannot poison the others.
  const read: ReadContext = { signal: deps.budget.signal, deadline: deps.budget.deadline };
  requests.set(facts, { read, cache: deps.lib.createCalculationCache(), memo: new Map(), runs: [], scopes: [], known: new Set(), unverified: new Set(),
    work: createWorkLedger(options.workPolicy ?? manifest.cpuPolicy as unknown as WorkPolicy) });
  let snapshot: Promise<Loaded<PortfolioSnapshot>> | null = null;
  return { ...deps, facts, calculations: [], loadSnapshot: () => snapshot ??= deps.repo.load(read) };
}

function request(ctx: ToolCtx): Request {
  const found = requests.get(ctx.facts);
  if (!found) throw new Error('Tool context was not created by createToolContext');
  return found;
}

/** Request-scoped memo for shared async work (priced portfolio, quotes); failures are not cached. */
export function memo<T>(ctx: ToolCtx, key: string, work: () => Promise<T>): Promise<T> {
  const { memo: entries } = request(ctx);
  if (!entries.has(key)) {
    const pending = work();
    entries.set(key, pending);
    pending.catch(() => entries.delete(key));
  }
  return entries.get(key) as Promise<T>;
}
export const calculationCache = (ctx: ToolCtx) => request(ctx).cache;
/** The request's CPU work ledger: every synchronous model of every tool is charged here before it starts. */
export const workLedger = (ctx: ToolCtx): WorkLedger => request(ctx).work;
/** Full results of every tool run in this request: the evidence behind the answer, never sent whole to the model. */
export const recordRun = (ctx: ToolCtx, run: ToolRun) => { request(ctx).runs.push(run); };
export const runsOf = (ctx: ToolCtx): readonly ToolRun[] => request(ctx).runs;
export const requestRead = (ctx: ToolCtx) => request(ctx).read;
/** Peers named by the provider in this request are real instruments for the rest of it (never across requests). */
export const addKnownTickers = (ctx: ToolCtx, tickers: readonly string[]) => { for (const t of tickers) request(ctx).known.add(t.toUpperCase()); };
export const markUnverifiedTicker = (ctx: ToolCtx, ticker: string) => { request(ctx).unverified.add(ticker.toUpperCase()); };
export const hasUnverifiedTicker = (ctx: ToolCtx) => request(ctx).unverified.size > 0;
export const isKnownTicker = (ctx: ToolCtx, ticker: string) => request(ctx).known.has(ticker.toUpperCase());
/** The current tool's read context: its own signal and the earlier of the tool and request deadlines. */
export const toolRead = (ctx: ToolCtx): ReadContext => ({ signal: ctx.budget.signal, deadline: ctx.budget.deadline });

const same = (a: Omit<Fact, 'id'>, b: Omit<Fact, 'id'>) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = (f: Omit<Fact, 'id'>) => [f.value, f.unit, f.currency ?? null, f.ticker ?? null, f.period ?? null, f.source, f.as_of,
  f.metric, f.scope, f.quality];

/** Account scope is request-local evidence, never an account identifier sent to the model. */
export function factScope(ctx: ToolCtx, scope: Scope): string {
  if ('all' in scope) return 'all';
  const key = JSON.stringify([scope.broker.toUpperCase(), scope.account]), scopes = request(ctx).scopes;
  if (!scopes.includes(key)) scopes.push(key);
  return `scope_${scopes.indexOf(key) + 1}`;
}

/**
 * Registers a fact under a unique ID. Re-registering identical content returns the existing fact;
 * a different value under the same name gets a `#n` suffix and never overwrites the earlier one.
 */
export function registerFact(ctx: ToolCtx, draft: Fact): Fact {
  const content: Omit<Fact, 'id'> = { value: draft.value, unit: draft.unit, ...(draft.currency ? { currency: draft.currency } : {}),
    ...(draft.ticker ? { ticker: draft.ticker } : {}), ...(draft.period ? { period: { from: draft.period.from, to: draft.period.to } } : {}),
    source: draft.source, as_of: draft.as_of,
    metric: draft.metric ?? draft.id, scope: draft.scope ?? 'unknown',
    quality: Object.freeze(draft.quality ? { ...draft.quality } : { state: 'unknown', freshness: 'missing' }) };
  for (let n = 1; ; n++) {
    const id = n === 1 ? draft.id : `${draft.id}#${n}`;
    const existing = ctx.facts.get(id);
    if (!existing) {
      const fact = Object.freeze({ id, ...content }) as Fact;
      ctx.facts.set(id, fact);
      return fact;
    }
    if (same(existing, content)) return existing;
  }
}
