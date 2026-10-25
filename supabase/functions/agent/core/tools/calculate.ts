import { registerFact } from '../context.ts';
import { type CalculationInput, type CalculationOp, type CalculationRecord, type Fact, type FactUnit, ToolInputError, type ToolCtx,
  type ToolResult } from '../types.ts';
import { arrayOf, defineTool, factSchema, meta, object, open, parseWith, success } from './common.ts';

// All arithmetic in an answer and between tools goes through here: inputs are fact IDs from this
// request, never literals, and the result is a new fact that records what it was computed from.
const NUMERIC = new Set<FactUnit>(['money', 'shares', 'percent', 'ratio', 'count']);
const SCALAR = new Set<FactUnit>(['ratio', 'count', 'percent']);
const OPS: readonly CalculationOp[] = ['add', 'subtract', 'multiply', 'divide', 'percentChange', 'sum'];
const inputSchema = object({ op: { type: 'string', enum: [...OPS] },
  inputs: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 160 } } }, ['op', 'inputs']);
const parse = parseWith<CalculationInput>(inputSchema);

type Shape = { unit: FactUnit; currency?: string; ticker?: string };
const fail = (message: string): never => { throw new ToolInputError('invalid', message); };
const scalar = (f: Fact) => f.unit === 'percent' ? (f.value as number) / 100 : f.value as number;

function sameTicker(facts: Fact[]): string | undefined {
  const tickers = new Set(facts.map(f => f.ticker));
  if (tickers.size > 1) fail('These facts belong to different instruments; use op "sum" to total them explicitly.');
  return facts[0].ticker;
}
function sameKind(facts: Fact[], explicitSum: boolean): Shape {
  const [first] = facts;
  if (facts.some(f => f.unit !== first.unit)) fail('Facts with different units cannot be combined.');
  if (facts.some(f => f.currency !== first.currency)) fail('Amounts in different currencies cannot be combined.');
  const ticker = explicitSum ? (new Set(facts.map(f => f.ticker)).size === 1 ? first.ticker : undefined) : sameTicker(facts);
  return { unit: first.unit, currency: first.currency, ticker };
}

function compute(op: CalculationOp, facts: Fact[]): { value: number; shape: Shape } {
  if (op === 'sum' ? facts.length < 2 : facts.length !== 2) fail(op === 'sum' ? 'A sum needs at least two facts.' : `"${op}" needs exactly two facts.`);
  const [a, b] = facts, x = a.value as number, y = b?.value as number;
  switch (op) {
    case 'add': case 'subtract': case 'sum': {
      const shape = sameKind(facts, op === 'sum');
      const value = op === 'subtract' ? x - y : facts.reduce((s, f) => s + (f.value as number), 0);
      return { value, shape };
    }
    case 'percentChange': {
      const shape = sameKind(facts, false);
      if (x === 0) fail('A change from zero has no percentage.');
      return { value: (y - x) / x * 100, shape: { unit: 'percent', ticker: shape.ticker } };
    }
    case 'multiply': {
      const ticker = sameTicker(facts);
      const money = facts.find(f => f.unit === 'money'), shares = facts.find(f => f.unit === 'shares');
      const other = facts.find(f => f !== (money ?? shares));
      if (money && other && (other.unit === 'shares' || SCALAR.has(other.unit))) {
        return { value: (money.value as number) * (other.unit === 'shares' ? other.value as number : scalar(other)), shape: { unit: 'money', currency: money.currency, ticker } };
      }
      if (shares && other && SCALAR.has(other.unit)) return { value: (shares.value as number) * scalar(other), shape: { unit: 'shares', ticker } };
      if (SCALAR.has(a.unit) && SCALAR.has(b.unit)) return { value: scalar(a) * scalar(b), shape: { unit: 'ratio', ticker } };
      return fail('These units cannot be multiplied.');
    }
    case 'divide': {
      const ticker = sameTicker(facts);
      if (y === 0) fail('Division by zero.');
      if (a.unit === b.unit && a.currency === b.currency) return { value: x / y, shape: { unit: 'ratio', ticker } };
      if (a.unit === 'money' && b.unit === 'shares') return { value: x / y, shape: { unit: 'money', currency: a.currency, ticker } };
      if ((a.unit === 'money' || a.unit === 'shares') && SCALAR.has(b.unit)) return { value: x / scalar(b), shape: { unit: a.unit, currency: a.currency, ticker } };
      return fail('These units cannot be divided.');
    }
  }
}

const oldest = (facts: Fact[]) => facts.reduce((min, f) => Date.parse(f.as_of) < Date.parse(min.as_of) ? f : min).as_of;
const samePeriod = (facts: Fact[]) => facts.every(f => JSON.stringify(f.period ?? null) === JSON.stringify(facts[0].period ?? null)) ? facts[0].period : undefined;

export function calculate(args: CalculationInput, ctx: ToolCtx): ToolResult<CalculationRecord> {
  try {
    const input = parse(args);
    const facts = input.inputs.map(id => ctx.facts.get(id) ?? fail(`Unknown fact ID "${id.slice(0, 40)}"; use IDs returned by tools in this conversation turn.`));
    for (const f of facts) {
      if (!NUMERIC.has(f.unit) || typeof f.value !== 'number' || !Number.isFinite(f.value)) fail(`Fact ${f.id} has no numeric value.`);
    }
    const { value, shape } = compute(input.op, facts);
    if (!Number.isFinite(value)) fail('The result is not a finite number.');
    const period = samePeriod(facts);
    if (facts.some(f => JSON.stringify(f.period ?? null) !== JSON.stringify(facts[0].period ?? null))) fail('Facts with different periods cannot be combined.');
    const scopes = new Set(facts.map(f => f.scope ?? 'unknown'));
    if (scopes.size > 1) fail('Facts with different scopes cannot be combined.');
    const quality = { state: facts.some(f => !f.quality || f.quality.state === 'unknown') ? 'unknown' as const
      : facts.some(f => f.quality?.state === 'incomplete') ? 'incomplete' as const : 'complete' as const,
    freshness: facts.some(f => !f.quality || f.quality.freshness === 'missing') ? 'missing' as const
      : facts.some(f => f.quality?.freshness === 'stale') ? 'stale' as const : 'fresh' as const };
    const result = registerFact(ctx, { id: `calc:${ctx.calculations.length + 1}`, value, unit: shape.unit, ...(shape.currency ? { currency: shape.currency } : {}),
      metric: `calculation:${input.op}`, scope: facts[0].scope, quality,
      ...(shape.ticker ? { ticker: shape.ticker } : {}), ...(period ? { period } : {}), source: 'calculate', as_of: oldest(facts) });
    const record: CalculationRecord = Object.freeze({ id: result.id, op: input.op, inputs: facts, result });
    ctx.calculations.push(record);
    return success(ctx, record, [result], meta({ snapshotId: 'calculation', complete: quality.state === 'complete', freshness: quality.freshness }));
  } catch (error) {
    if (error instanceof ToolInputError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
}

export const calculateTool = defineTool<CalculationInput, CalculationRecord>({
  name: 'calculate', group: 'obecne',
  description: 'The only way to do arithmetic: add, subtract, multiply, divide, percentChange (from first to second, percent) or sum over fact IDs returned by tools in this request. Units and currencies must be compatible; different instruments only with "sum".',
  inputSchema, parse,
  outputSchema: open({ id: { type: 'string' }, op: { enum: [...OPS] }, inputs: arrayOf(factSchema, 20), result: factSchema }, ['id', 'op', 'inputs', 'result']),
  run: async (args, ctx) => calculate(args, ctx),
});
