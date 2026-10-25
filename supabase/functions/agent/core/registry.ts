import { withTimeout } from './budget.ts';
import { modelError, modelWarnings } from './modelPrivacy.ts';
import { assertSupported, validateSchema } from './schema.ts';
import { calculateTool } from './tools/calculate.ts';
import { MAX_ROWS } from './tools/common.ts';
import { marketTools } from './tools/market.ts';
import { portfolioTools } from './tools/portfolio.ts';
import { taxTools } from './tools/tax.ts';
import { valuationTools } from './tools/valuation.ts';
import { type Fact, type JsonSchema, type ResultMeta, ToolInputError, type ToolCtx, type ToolDef, type ToolResult } from './types.ts';

export const TOOL_TIMEOUT_MS = 8_000;
const PROJECTION_CHARS = 6_000;
// Identifiers and free text the model never needs: accounts are a calculation scope, not prose.
const PRIVATE_KEYS = new Set(['id', 'ext_id', 'note', 'broker', 'broker_account', 'account', 'user_id', 'buyTxId', 'sellTxId', 'buyId', 'txId', 'key']);

// Read-only by construction: every tool reads through the caller-scoped repository or market source.
// There is no SQL, RPC, key, broker-connection, web search or write tool to register.
const TOOLS = [...portfolioTools, ...taxTools, ...marketTools, ...valuationTools, calculateTool] as unknown as ToolDef<unknown, unknown>[];
for (const tool of TOOLS) { assertSupported(tool.inputSchema, `${tool.name}.input`); assertSupported(tool.outputSchema, `${tool.name}.output`); }
const REGISTRY: ReadonlyMap<string, ToolDef<unknown, unknown>> = (() => {
  const map = new Map(TOOLS.map(tool => [tool.name, tool]));
  if (map.size !== TOOLS.length) throw new Error('Duplicate tool name');
  const refuse = () => { throw new Error('The tool registry is read-only'); };
  for (const method of ['set', 'delete', 'clear']) Object.defineProperty(map, method, { value: refuse });
  return Object.freeze(map);
})();

/** The single registry shared by the model loop, the HTTP handler and the Python evals. */
export function createRegistry(): ReadonlyMap<string, ToolDef<unknown, unknown>> {
  return REGISTRY;
}

export function exportToolSchemas(): { name: string; description: string; inputSchema: JsonSchema; outputSchema: JsonSchema; group: string }[] {
  return TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, group: t.group }));
}

const failure = (code: Extract<ToolResult<unknown>, { ok: false }>['error']['code'], message: string): ToolResult<unknown> =>
  ({ ok: false, error: { code, message } });

/**
 * Validates, runs within the 8 s tool limit (and the request deadline) and validates the output.
 * A timeout aborts the tool's own reads; expected refusals keep their code, anything else is
 * reported as `unavailable` without internal details.
 */
export async function executeTool(name: string, args: unknown, ctx: ToolCtx): Promise<ToolResult<unknown>> {
  const tool = typeof name === 'string' ? REGISTRY.get(name) : undefined;
  if (!tool) return failure('invalid', 'Unknown or unavailable tool.');
  let parsed: unknown;
  try {
    parsed = tool.parse(args);
  } catch (error) {
    return error instanceof ToolInputError ? failure(error.code, error.message) : failure('invalid', 'Invalid arguments.');
  }
  const { budget } = ctx;
  try {
    const result = await withTimeout(signal => {
      const now = budget.deadline - budget.remainingMs();
      const deadline = Math.min(budget.deadline, now + TOOL_TIMEOUT_MS);
      const toolBudget = { ...budget, signal, deadline, remainingMs: () => Math.max(0, budget.remainingMs() - (budget.deadline - deadline)) };
      return tool.run(parsed, { ...ctx, budget: toolBudget });
    }, TOOL_TIMEOUT_MS, budget);
    if (!result.ok) return result;
    if (validateSchema(tool.outputSchema, result.data).length) return failure('unavailable', 'The tool produced an unexpected result.');
    if (result.facts.some(f => ctx.facts.get(f.id) !== f)) return failure('unavailable', 'The tool produced unregistered facts.');
    return result;
  } catch (error) {
    if (budget.signal.aborted) throw budget.signal.reason ?? error;
    if (error instanceof ToolInputError) return { ok: false, error: { code: error.code, message: error.message, ...(error.choices ? { choices: error.choices } : {}), ...(error.reason ? { reason: error.reason } : {}) } };
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return failure('timeout', 'The data source did not answer in time.');
    return failure('unavailable', 'The data source is unavailable.');
  }
}

/* ----------------------------- model projection ----------------------------- */

type Projection = { ok: true; data: unknown; facts: Fact[]; meta: ResultMeta }
  | { ok: false; error: { code: Extract<ToolResult<unknown>, { ok: false }>['error']['code']; message: string; choices?: { id: string }[] } };

function strip(value: unknown, limit: number, omitted: { rows: number }): unknown {
  if (Array.isArray(value)) {
    if (value.length > limit) omitted.rows += value.length - limit;
    return value.slice(0, limit).map(v => strip(v, limit, omitted));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => {
      if (PRIVATE_KEYS.has(k) || typeof v === 'function') return [];
      if (k === 'warnings') return [[k, modelWarnings(Array.isArray(v) ? v.map(w => typeof w === 'string' ? w : 'additional_warning') : ['additional_warning'])]];
      return [[k, strip(v, limit, omitted)]];
    }));
  }
  return typeof value === 'function' ? undefined : value;
}

/**
 * What the model sees of a result: private identifiers removed, at most 50 rows per list and
 * 6,000 characters per tool. The full result stays in the request evidence. Warnings, completeness
 * categories and every fact's source and time are kept; dropped data is said in warnings.
 */
export function projectForModel(_name: string, result: ToolResult<unknown>): Projection {
  if (result.ok === false) return { ok: false, error: { code: result.error.code, message: modelError(result.error.code),
    ...(result.error.choices ? { choices: result.error.choices.map((_, i) => ({ id: `choice_${i + 1}` })) } : {}) } };
  const scope = 'all' in result.meta.scope ? result.meta.scope : { broker: 'selected', account: 'selected' };
  const fit = (data: unknown, facts: Fact[], extra: string[], omittedRows: number): Projection => ({ ok: true, data, facts,
    meta: { ...result.meta, scope, omittedRows: result.meta.omittedRows + omittedRows, warnings: modelWarnings([...result.meta.warnings, ...extra]) } });
  const size = (p: Projection) => JSON.stringify(p).length;
  for (const limit of [MAX_ROWS, 10, 3]) {
    const omitted = { rows: 0 };
    const candidate = fit(strip(result.data, limit, omitted), result.facts, omitted.rows ? ['projection_rows_trimmed'] : [], omitted.rows);
    if (size(candidate) <= PROJECTION_CHARS) return candidate;
  }
  // Facts carry the citable numbers; keep as many as fit and say how many were left out.
  let facts = result.facts;
  let candidate = fit(null, facts, ['projection_data_omitted'], 0);
  while (facts.length && size(candidate) > PROJECTION_CHARS) {
    let keep = Math.floor(facts.length * 0.8);
    const cutLot = _name === 'get_tax_lots' ? /^(lots:lot_\d+):/.exec(facts[keep]?.metric ?? '')?.[1] : undefined;
    while (keep > 0 && cutLot && facts[keep - 1].metric?.startsWith(`${cutLot}:`)) keep--;
    facts = facts.slice(0, keep);
    candidate = fit(null, facts, ['projection_data_omitted', `projection_facts_omitted:${result.facts.length - facts.length}`], 0);
  }
  return candidate;
}
