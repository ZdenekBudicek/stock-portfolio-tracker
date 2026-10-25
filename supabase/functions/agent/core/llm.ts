import { MODEL_TIMEOUT_MS, type RequestBudget, withTimeout } from './budget.ts';
import { REJECTION_CODES, sanitizeReasons } from './attemptReasons.ts';
import { GROQ_MODELS, modelAllowed, type ModelPolicy, type ModelRef } from './modelPolicy.ts';
const modelOutputCap = (ref: ModelRef) => (ref.provider === 'groq' ? GROQ_MODELS[ref.id]?.maxOutput : undefined) ?? Number.POSITIVE_INFINITY;
import type { exportToolSchemas } from './registry.ts';

export const QUESTION_TOKEN_LIMIT = 8_000;
/**
 * Běh 27: a question answered by the news analyst (moves, companies, outlooks) may reserve 12,000 — by the byte upper
 * bound; its real Groq usage stays well under the 8,000 tokens a minute. Every other question keeps 8,000.
 */
export const ANALYSIS_QUESTION_TOKEN_LIMIT = 12_000;
export const CALL_TOKEN_LIMIT = 3_000;
/** The one larger call (Běh 23b, 9,000 since Běh 27): the news analyst reads page passages; its caller passes `callLimit`. */
export const ANALYST_CALL_TOKEN_LIMIT = 9_000;
/** A call's input + output cap: 3,000 unless the caller asks for more, never above the analyst's 9,000. */
export const callCap = (callLimit?: number) => Math.min(ANALYST_CALL_TOKEN_LIMIT, Math.max(0, Math.floor(callLimit ?? CALL_TOKEN_LIMIT)));
// Below this many output tokens no model can produce a usable answer; the call is not made.
const MIN_OUTPUT = 64;
const MAX_RESPONSE_BYTES = 512 * 1024;
/** A 429 whose limit lifts within this time is waited out once per model and request instead of failing over. */
export const SHORT_RESET_MAX_MS = 6_000;
const ENDPOINTS = { groq: 'https://api.groq.com/openai/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions' } as const;
const KEYS = { groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;

/* ----------------------------- token ledger ----------------------------- */

export type TokenUsage = { input: number; output: number; reasoning?: number };
export type AttemptPhase = 'router' | 'tools' | 'answer' | 'repair' | 'completion';
export type AttemptAudit = {
  id: string; phase: AttemptPhase; model: string | null; provider: string | null;
  /** The input + output cap this attempt was admitted under (3,000; the news analyst 5,000). */
  callLimit: number;
  inputUpperBound: number; outputLimit: number; chargedInput: number; chargedOutput: number;
  usageSource: 'reported' | 'reserved' | 'rejected'; reasoningTokens: number | null;
  finishReason: string | null; outcome: string; rejectionReasons: string[];
};
export type TokenBudget = {
  spent: number; reserved: number;
  /** Charged totals, including full reservations when usage is unknown. */
  input: number; output: number; maxCall: number;
  /** Observed provider tokens per estimated token (≥ 1); later estimates are scaled by it. */
  inflation: number;
  attempts: AttemptAudit[];
  /** The question's cap: 8,000, or 12,000 once the analysis path raises it (`allowAnalysis`). */
  limit: number;
  allowAnalysis(): void;
  breached: boolean;
  /** Models (`provider:id`) that already had their one short rate-limit wait in this question. */
  waited: Set<string>;
  reserve(inputUpperBound: number, maxOutput: number, meta?: { phase?: AttemptPhase; model: ModelRef; callLimit?: number }): string;
  settle(id: string, usage: TokenUsage | null, outcome?: string, finishReason?: string): void;
  available(): number;
};
export class TokenBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'TokenBudgetError'; }
}

/**
 * One ledger per question: every attempt (router, fallbacks, repair) reserves its input bound plus
 * its whole output allowance (reasoning included) first. A known usage replaces the reservation;
 * an unknown one (timeout, broken response) keeps all of it.
 */
export function createTokenBudget(): TokenBudget {
  const open = new Map<string, AttemptAudit>();
  let next = 0;
  const ledger: TokenBudget = {
    spent: 0, reserved: 0, input: 0, output: 0, maxCall: 0, inflation: 1, waited: new Set<string>(), attempts: [], breached: false,
    limit: QUESTION_TOKEN_LIMIT,
    allowAnalysis: () => { ledger.limit = ANALYSIS_QUESTION_TOKEN_LIMIT; },
    available: () => ledger.breached ? 0 : Math.max(0, ledger.limit - ledger.spent - ledger.reserved),
    reserve(inputUpperBound, maxOutput, meta) {
      if (![inputUpperBound, maxOutput].every(n => Number.isFinite(n) && n >= 0)) throw new TokenBudgetError('Invalid reservation.');
      const amount = Math.ceil(inputUpperBound) + Math.ceil(maxOutput);
      const cap = callCap(meta?.callLimit);
      if (!(amount >= 0) || amount > cap) throw new TokenBudgetError(`A model call may use at most ${cap} tokens.`);
      if (amount > ledger.available()) throw new TokenBudgetError('The question has no tokens left.');
      const id = `t${++next}`;
      const entry: AttemptAudit = { id, phase: meta?.phase ?? 'completion', model: meta?.model.id ?? null, provider: meta?.model.provider ?? null, callLimit: cap,
        inputUpperBound: Math.ceil(inputUpperBound), outputLimit: Math.ceil(maxOutput), chargedInput: 0, chargedOutput: 0,
        usageSource: 'reserved', reasoningTokens: null, finishReason: null, outcome: 'pending', rejectionReasons: [] };
      open.set(id, entry);
      ledger.attempts.push(entry);
      ledger.reserved += amount;
      return id;
    },
    settle(id, usage, outcome = 'ok', finishReason) {
      const entry = open.get(id);
      if (!entry) return;
      const amount = entry.inputUpperBound + entry.outputLimit;
      open.delete(id);
      ledger.reserved -= amount;
      if (usage && (![usage.input, usage.output].every(n => Number.isSafeInteger(n) && n >= 0)
        || (usage.reasoning !== undefined && (!Number.isSafeInteger(usage.reasoning) || usage.reasoning < 0 || usage.reasoning > usage.output)))) usage = null;
      entry.chargedInput = usage?.input ?? entry.inputUpperBound;
      entry.chargedOutput = usage?.output ?? entry.outputLimit;
      entry.usageSource = outcome === 'quota' ? 'rejected' : usage ? 'reported' : 'reserved';
      entry.reasoningTokens = usage?.reasoning ?? null;
      entry.outcome = outcome;
      entry.finishReason = finishReason === undefined ? null : safeFinishReason(finishReason);
      if (outcome !== 'ok') entry.rejectionReasons.push(outcome);
      if (entry.finishReason === 'length') entry.rejectionReasons.push('truncated');
      const used = entry.chargedInput + entry.chargedOutput;
      ledger.spent += used;
      ledger.input += entry.chargedInput; ledger.output += entry.chargedOutput;
      ledger.maxCall = Math.max(ledger.maxCall, used);
      if (usage && usage.input > entry.inputUpperBound) {
        ledger.inflation *= usage.input / Math.max(1, entry.inputUpperBound);
        entry.rejectionReasons.push('input_bound_exceeded');
      }
      if (used > amount || entry.chargedOutput > entry.outputLimit) {
        ledger.breached = true;
        entry.rejectionReasons.push('usage_exceeded');
      }
    },
  };
  return ledger;
}

/* ----------------------------- messages ----------------------------- */

export type LlmMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[] };
export type Completion = { message: LlmMessage; usage: TokenUsage; model: ModelRef; finishReason: string; latencyMs: number; attemptId?: string;
  resetAt: string | null; fellBack: boolean };
export type ToolSchemas = ReturnType<typeof exportToolSchemas>;

export class QuotaError extends Error {
  readonly retryAt: string | null;
  constructor(retryAt: string | null) { super('All models are rate-limited'); this.name = 'QuotaError'; this.retryAt = retryAt; }
}
export type FailureCode = 'timeout' | 'empty' | 'http' | 'provider' | 'budget' | 'policy' | 'config' | 'network';
export class AllModelsFailed extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(`No model answered (${code})`); this.name = 'AllModelsFailed'; this.code = code; }
}

const apiMessage = (m: LlmMessage) => ({ role: m.role, content: m.content,
  ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) });
const apiTools = (tools: ToolSchemas) => tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const encoder = new TextEncoder();

/**
 * Upper-bound estimate of the input tokens of a request: the UTF-8 bytes of everything that is sent
 * (messages, tool calls, tool schemas): byte-fallback tokenizers cannot emit more text tokens than
 * bytes. JSON framing plus explicit message/schema margins covers chat-template overhead.
 * See MODEL-BUDGET.md for the provider contract, historical evidence and breach handling.
 */
export function estimateInputTokens(messages: readonly LlmMessage[], tools: ToolSchemas, inflation = 1, responseFormat?: unknown): number {
  const bytes = encoder.encode(JSON.stringify({ messages: messages.map(apiMessage), tools: apiTools(tools),
    ...(responseFormat ? { response_format: responseFormat } : {}) })).length;
  return Math.ceil((bytes + 32 * messages.length + 64 + 128 * (tools.length + (responseFormat ? 1 : 0))) * Math.max(1, inflation));
}

export const safeFinishReason = (reason: string) => ['stop', 'tool_calls', 'length', 'content_filter'].includes(reason) ? reason : 'unknown';
/**
 * One JSON line per rejected attempt for the function log (Supabase logs): the phase, the outcome and the sanitized
 * audit codes only — never a provider message, draft text, figure, model, id or user detail.
 */
export function logRejection(entry: Pick<AttemptAudit, 'phase' | 'outcome' | 'rejectionReasons'>): void {
  try {
    console.log(JSON.stringify({ agent_attempt: { phase: entry.phase, outcome: /^[a-z_]+$/.test(entry.outcome) ? entry.outcome : 'invalid',
      codes: sanitizeReasons(entry.rejectionReasons) } }));
  } catch { /* logging never fails a request */ }
}
export function rejectCompletion(tokens: TokenBudget, completion: Completion, reasons: string[]): void {
  const entry = tokens.attempts.find(a => a.id === completion.attemptId);
  if (entry) { entry.outcome = 'invalid'; entry.rejectionReasons = sanitizeReasons([...entry.rejectionReasons, ...reasons]); logRejection(entry); }
}

/* ----------------------------- one request ----------------------------- */

type Attempt =
  | { kind: 'ok'; message: LlmMessage; usage: TokenUsage | null; finishReason: string }
  | { kind: 'quota'; resetAt: string | null }
  | { kind: 'fail'; code: FailureCode; usage: TokenUsage | null; finishReason?: string; reasons?: string[] };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accept only an explicit final channel, never JSON found inside reasoning or a printed tool call. */
function finalContent(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  if (!text.includes('<|')) return text;
  const final = /^(?:<\|start\|>assistant<\|channel\|>analysis<\|message\|>[\s\S]*?<\|end\|>)?<\|start\|>assistant<\|channel\|>final<\|message\|>((?:(?!<\|)[\s\S])*)<\|(?:return|end)\|>$/.exec(text);
  return final?.[1].trim() ?? '';
}

function providerReasons(status: number, raw?: unknown): string[] {
  const http = `http_${status}`;
  const error = record(raw) && record(raw.error) ? raw.error : null;
  return [REJECTION_CODES.has(http) ? http : 'http_other', ...error ? ['type', 'code'].flatMap(key =>
    typeof error[key] === 'string' && REJECTION_CODES.has(error[key] as string) ? [error[key] as string] : ['provider_error']) : [],
    ...(error && typeof error.param === 'string' && REJECTION_CODES.has(`param_${error.param}`) ? [`param_${error.param}`] : [])];
}

function durationMs(value: string | null): number | null {
  if (!value) return null;
  let total = 0, matched = false;
  for (const [, n, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(n) * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000);
  }
  return matched ? total : null;
}
/**
 * The time the provider says the limit lifts: Retry-After first, else the later of the reset headers of the
 * exhausted limits (a reset whose `x-ratelimit-remaining-*` is still positive is not why the call was refused,
 * e.g. Groq's daily request window next to a per-minute token limit); null when it does not say.
 */
function resetAt(headers: Headers, now: number): string | null {
  const retry = headers.get('retry-after');
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1000).toISOString();
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return new Date(date).toISOString();
  }
  const resets = (['tokens', 'requests'] as const)
    .filter(kind => !(Number(headers.get(`x-ratelimit-remaining-${kind}`) ?? NaN) > 0))
    .map(kind => durationMs(headers.get(`x-ratelimit-reset-${kind}`))).filter((n): n is number => n !== null);
  return resets.length ? new Date(now + Math.max(...resets)).toISOString() : null;
}
function usageOf(raw: unknown): TokenUsage | null {
  if (!record(raw)) return null;
  const input = raw.prompt_tokens, output = raw.completion_tokens;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!valid(input) || !valid(output)) return null;
  const total = raw.total_tokens;
  if (total !== undefined && (!valid(total) || total < input + output)) return null;
  const chargedOutput = total === undefined ? output : (total as number) - input;
  const reasoning = record(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : undefined;
  if (reasoning !== undefined && (!valid(reasoning) || reasoning > chargedOutput)) return null;
  return { input, output: chargedOutput, ...(reasoning === undefined ? {} : { reasoning: reasoning as number }) };
}

async function attempt(ref: ModelRef, key: string, body: unknown, signal: AbortSignal, fetchImpl: typeof fetch, now: () => number): Promise<Attempt> {
  const response = await fetchImpl(ENDPOINTS[ref.provider], { method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 429) {
    void response.body?.cancel().catch(() => {});
    return { kind: 'quota', resetAt: resetAt(response.headers, now()) };
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { void response.body?.cancel().catch(() => {}); return { kind: 'fail', code: 'http', usage: null, reasons: ['response_size', ...providerReasons(response.status)] }; }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return { kind: 'fail', code: 'http', usage: null, reasons: ['response_size', ...providerReasons(response.status)] };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { kind: 'fail', code: response.ok ? 'provider' : 'http', usage: null, reasons: response.ok ? ['schema'] : providerReasons(response.status) }; }
  if (!record(raw)) return { kind: 'fail', code: response.ok ? 'provider' : 'http', usage: null, reasons: response.ok ? ['schema'] : providerReasons(response.status) };
  const usage = usageOf(raw.usage);
  if (!response.ok) return { kind: 'fail', code: 'http', usage, reasons: providerReasons(response.status, raw) };
  // Some providers report errors inside HTTP 200.
  if (raw.error !== undefined && raw.error !== null) return { kind: 'fail', code: 'provider', usage, reasons: providerReasons(response.status, raw).slice(1) };
  const choice = Array.isArray(raw.choices) && record(raw.choices[0]) ? raw.choices[0] : null;
  const message = choice && record(choice.message) ? choice.message : null;
  if (!message) return { kind: 'fail', code: 'provider', usage, reasons: ['schema'] };
  // Reasoning never reaches the answer path, even from a model that inlines it.
  const content = finalContent(message.content);
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap(c => {
    const fn = record(c) && record(c.function) ? c.function : null;
    return fn && typeof fn.name === 'string' && typeof c.id === 'string'
      ? [{ id: c.id, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) }] : [];
  });
  if ((message.tool_calls != null && (!Array.isArray(message.tool_calls) || toolCalls.length !== message.tool_calls.length))
    || (choice!.finish_reason === 'tool_calls' && !toolCalls.length)) return { kind: 'fail', code: 'provider', usage,
      finishReason: typeof choice!.finish_reason === 'string' ? choice!.finish_reason : 'unknown', reasons: ['tool_call_format'] };
  if (!content && !toolCalls.length) return { kind: 'fail', code: 'empty', usage,
    finishReason: typeof choice!.finish_reason === 'string' ? choice!.finish_reason : 'unknown' };
  return { kind: 'ok', usage, finishReason: typeof choice!.finish_reason === 'string' ? choice!.finish_reason : 'unknown',
    message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { toolCalls } : {}) } };
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
/** Waits `ms`, or rejects with the request's abort reason as soon as it is cancelled. */
export const abortableSleep: Sleep = (ms, signal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); return; }
  const stop = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
});

/**
 * Tries each model of the chain in turn: an empty or broken answer, an error or a timeout moves
 * straight to the next model. A rate limit that the provider says lifts within 6 s is waited out once
 * per model and question — only when the request budget still holds the wait plus a full model call —
 * and the same model is retried; any other rate limit moves on at once. Every attempt is checked
 * against the policy and reserved in the token ledger before any network request.
 */
export async function complete(chain: readonly ModelRef[], input: { messages: LlmMessage[]; tools: ToolSchemas; maxOutput: number;
  minOutput?: number; keepTokens?: number; phase?: AttemptPhase; jsonSchema?: { name: string; strict: true; schema: unknown };
  /** Input + output cap of this call; default 3,000, at most 5,000 (news analyst only). */
  callLimit?: number },
  deps: { budget: RequestBudget; tokens: TokenBudget; policy: ModelPolicy; keys: Readonly<Record<string, string>>; fetchImpl: typeof fetch;
    now?: () => number; sleep?: Sleep }): Promise<Completion> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const failures: FailureCode[] = [];
  const resets: (string | null)[] = [];
  models: for (const [index, ref] of chain.entries()) {
    if (deps.budget.signal.aborted) throw deps.budget.signal.reason ?? new DOMException('Cancelled', 'AbortError');
    if (!modelAllowed(deps.policy, ref)) { failures.push('policy'); continue; }
    const key = deps.keys[KEYS[ref.provider]];
    if (typeof key !== 'string' || !key) { failures.push('config'); continue; }
    const started = now();
    // At most two attempts per model: the second only after one short rate-limit wait.
    while (true) {
      // Strict decoding for the callers that pass a schema (router, news analyst); other phases retain their wire contract.
      const responseFormat = !input.tools.length && ['router', 'answer', 'repair'].includes(input.phase ?? '') && input.jsonSchema
        && ref.provider === 'groq' && ref.id.startsWith('openai/gpt-oss-') ? { type: 'json_schema', json_schema: input.jsonSchema } : undefined;
      const format = !input.tools.length && ['router', 'answer', 'repair'].includes(input.phase ?? '') ? responseFormat ?? { type: 'json_object' } : undefined;
      // The news analyst's estimate counts its JSON-object format too (other writers keep the Běh 16 estimate).
      const estimate = estimateInputTokens(input.messages, input.tools, deps.tokens.inflation, input.callLimit !== undefined ? format : responseFormat);
      const maxOutput = Math.min(Math.floor(input.maxOutput), callCap(input.callLimit) - estimate, deps.tokens.available() - estimate - (input.keepTokens ?? 0),
        modelOutputCap(ref));
      // A model whose own output cap is below the call's minimum is skipped; the next one may still fit (Běh 27).
      if (modelOutputCap(ref) < (input.minOutput ?? MIN_OUTPUT)) { failures.push('budget'); continue models; }
      if (!Number.isFinite(maxOutput) || maxOutput < (input.minOutput ?? MIN_OUTPUT)) { failures.push('budget'); break models; }
      if (deps.budget.remainingMs() <= 0) { failures.push('timeout'); break models; }
      const body = {
        model: ref.id, messages: input.messages.map(apiMessage), max_completion_tokens: maxOutput, temperature: 0.2, stream: false,
        ...(input.tools.length ? { tools: apiTools(input.tools), tool_choice: 'auto' } : {}),
        ...(format ? { response_format: format } : {}),
        ...(ref.provider === 'groq' && ref.id.startsWith('openai/gpt-oss-') ? { include_reasoning: false } : {}),
        ...(ref.reasoningEffort ? { reasoning_effort: ref.reasoningEffort } : {}),
        // A verified :free model only: no data collection, zero price caps, no provider fallback to another (paid) route.
        ...(ref.provider === 'openrouter' ? { provider: { data_collection: 'deny', allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } } } : {}),
      };
      const reservation = deps.tokens.reserve(estimate, maxOutput, { model: ref, phase: input.phase, callLimit: input.callLimit });
      let result: Attempt;
      try {
        result = await withTimeout(signal => attempt(ref, key, body, signal, deps.fetchImpl, now), MODEL_TIMEOUT_MS, deps.budget);
      } catch (error) {
        // The provider may have processed the request: its usage is unknown and the reservation stays spent.
        deps.tokens.settle(reservation, null, deps.budget.signal.aborted ? 'cancelled' : (error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'network');
        logRejection(deps.tokens.attempts.find(a => a.id === reservation)!);
        if (deps.budget.signal.aborted) throw deps.budget.signal.reason ?? error;
        failures.push((error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'network');
        continue models;
      }
      if (result.kind === 'quota') {
        // A rate-limited request is rejected before processing and uses no tokens.
        deps.tokens.settle(reservation, { input: 0, output: 0 }, 'quota');
        logRejection(deps.tokens.attempts.find(a => a.id === reservation)!);
        const waitMs = result.resetAt === null ? null : Math.max(0, Date.parse(result.resetAt) - now());
        const model = `${ref.provider}:${ref.id}`;
        if (waitMs !== null && waitMs <= SHORT_RESET_MAX_MS && !deps.tokens.waited.has(model)
          && deps.budget.remainingMs() >= waitMs + MODEL_TIMEOUT_MS) {
          // The wait runs on the request clock, so it is spent from the same budget as the calls.
          deps.tokens.waited.add(model);
          await sleep(waitMs, deps.budget.signal);
          continue;
        }
        resets.push(result.resetAt);
        continue models;
      }
      deps.tokens.settle(reservation, result.usage, result.kind === 'fail' ? result.code : 'ok', result.finishReason);
      if (result.kind === 'fail' && result.reasons?.length) {
        const entry = deps.tokens.attempts.find(a => a.id === reservation)!;
        entry.rejectionReasons = sanitizeReasons([...entry.rejectionReasons, ...result.reasons]);
      }
      if (result.kind === 'fail') logRejection(deps.tokens.attempts.find(a => a.id === reservation)!);
      if (deps.tokens.breached) throw new AllModelsFailed('budget');
      if (result.kind === 'fail') { failures.push(result.code); continue models; }
      return { message: result.message, usage: result.usage ?? { input: estimate, output: maxOutput }, model: ref, finishReason: safeFinishReason(result.finishReason), attemptId: reservation,
        latencyMs: now() - started, resetAt: null, fellBack: index > 0 };
    }
  }
  if (resets.length && !failures.length) {
    const known = resets.filter((r): r is string => r !== null).sort();
    throw new QuotaError(known[0] ?? null);
  }
  const code = failures.includes('budget') ? 'budget' : failures.includes('timeout') ? 'timeout'
    : failures.every(f => f === 'config') && failures.length ? 'config' : failures.find(f => f !== 'config' && f !== 'policy') ?? failures[0] ?? 'provider';
  throw new AllModelsFailed(code);
}

/** What the router and the agent need to call models; tests replace `fetchImpl` (never a live provider). */
export type LlmDeps = { complete: typeof complete; policy: ModelPolicy; keys: Readonly<Record<string, string>>; tokens: TokenBudget;
  fetchImpl: typeof fetch; now?: () => number; sleep?: Sleep };
