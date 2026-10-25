import type { RequestBudget } from './budget.ts';
import type { AgentLib } from './calculations.ts';
import type { Loaded, Period, PortfolioSnapshot, Scope } from './dataTypes.ts';
import type { MarketSource, PortfolioRepo } from './ports.ts';
import type { Lang, ViewPreferences } from './protocol.ts';

export type JsonSchema = Record<string, unknown>;
export type FactUnit = 'money' | 'shares' | 'percent' | 'ratio' | 'count' | 'date' | 'text' | 'boolean';
export type FactQuality = { state: 'complete' | 'incomplete' | 'unknown'; freshness: Freshness };
export type ClaimBinding = { metric?: string; scope?: string; quality?: FactQuality };
// `as_of` is the observation time of the source. A source without one yields no fact: the value
// stays in `data`, but it can never back a numeric claim with today's date in its place.
export type Fact = ClaimBinding & { id: string; value: number | string | boolean | null; unit: FactUnit; currency?: string; ticker?: string;
  period?: Period; source: string; as_of: string };
export type Freshness = 'fresh' | 'stale' | 'missing';
export type ResultMeta = { scope: Scope; period?: Period; complete: boolean; warnings: string[]; omittedRows: number;
  snapshotId: string; calculationVersion: string; freshness: Freshness; valuationFallback?: 'close' | 'cost' };
export type ToolErrorCode = 'invalid' | 'clarify' | 'unsupported' | 'unavailable' | 'timeout';
export type AccountChoice = { id: string; broker: string; account: string };
export type ToolResult<T> = { ok: true; data: T; facts: Fact[]; meta: ResultMeta }
  | { ok: false; error: { code: ToolErrorCode; message: string; choices?: AccountChoice[]; reason?: 'unsupported_residence' } };
export type ToolGroup = 'portfolio' | 'dane' | 'trh' | 'valuace' | 'obecne';

export type CalculationOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'percentChange' | 'sum';
export type CalculationInput = { op: CalculationOp; inputs: string[] };
export type CalculationRecord = { id: string; op: CalculationOp; inputs: Fact[]; result: Fact };

export type ToolCtx = { repo: PortfolioRepo; market: MarketSource; lib: AgentLib; budget: RequestBudget; today: string; lang: Lang;
  preferences: ViewPreferences; facts: Map<string, Fact>; calculations: CalculationRecord[];
  loadSnapshot: () => Promise<Loaded<PortfolioSnapshot>> };
export type ToolDef<A, R> = { name: string; description: string; group: ToolGroup; inputSchema: JsonSchema; outputSchema: JsonSchema;
  parse: (raw: unknown) => A; run: (args: A, ctx: ToolCtx) => Promise<ToolResult<R>> };

// Thrown by parse/run for an expected refusal; anything else becomes `unavailable`.
export class ToolInputError extends Error {
  readonly code: Exclude<ToolErrorCode, 'timeout'>;
  constructor(code: Exclude<ToolErrorCode, 'timeout'>, message: string, readonly choices?: AccountChoice[], readonly reason?: 'unsupported_residence') { super(message); this.code = code; }
}

/* ----------------------------- routing and answers (Běh 9) ----------------------------- */

export type RouteGroup = ToolGroup | 'mimo_temu';
// `analysis` marks a buy/valuation question: the orchestrator then loads every mandatory piece of evidence itself.
// Explicit intents bind mandatory evidence and answer content; the model cannot replace that contract.
export type Intent = 'transactions' | 'realized' | 'simulation' | 'lots' | 'account_clarification' | 'tax' | 'dividends' | 'quote' | 'buy' | 'performance' | 'allocation' | 'holdings' | 'summary' | 'movers'
  // Why a named instrument moved over recent days: period move vs the S&P 500 and peers, likely drivers from attributed news.
  | 'move_explanation';
export type Route = { group: RouteGroup; lang: Lang; tickers: string[]; period: Period; needsClarification: boolean; analysis: boolean; intent?: Intent };

export type ClaimMeaning = 'value' | 'gain' | 'loss' | 'change' | 'assumption';
export type NumericClaim = ClaimBinding & { factId: string; value: number; unit: Fact['unit']; currency?: string; ticker?: string; period?: Period;
  decimals: number; meaning: ClaimMeaning };
export type ReferencedClaim = ClaimBinding & { factId: string; value: string | boolean; unit: 'date' | 'text' | 'boolean'; ticker?: string; period?: Period };
export type AnswerBlockKind = 'facts' | 'analysts' | 'valuation' | 'context' | 'risks' | 'verdict' | 'summary';
// Text carries `{{claimId}}` slots instead of numbers and dates; the renderer fills them from facts.
export type AnswerBlock = { kind: AnswerBlockKind; ticker?: string; text: string; claims: Record<string, NumericClaim | ReferencedClaim>; sourceIds: string[] };
export type Verdict = 'attractive' | 'fair' | 'expensive' | 'insufficient';
export type Confidence = 'low' | 'medium' | 'high';
export type AnswerDraft = { lang: Lang; blocks: AnswerBlock[]; verdict?: Verdict; confidence?: Confidence; wouldChange?: string };
// Mandatory evidence of a buy analysis, loaded by the orchestrator whatever the model asks for.
export type AnalysisEvidence = { ticker: string; quote: ToolResult<unknown>; analysts: ToolResult<unknown>; fundamentals: ToolResult<unknown>;
  valuationHistory: ToolResult<unknown>; fairValue: ToolResult<unknown>; news: ToolResult<unknown>; earnings: ToolResult<unknown>;
  holdings: ToolResult<unknown>; allocation: ToolResult<unknown> };
