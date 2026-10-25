import { analysisPolicy, buildVerifiedTemplate, isNoDataText, renderMoveAnswer, renderWebAnswer, renderMoverThemes, renderSelectedFacts, type AnalysisPolicy } from './answerTemplate.ts';
import { nameKeywords, webSearchQuery } from './articleText.ts';
import { asksFrom, collectArticles, collectMoveEvidence, direction, moveAnalystInput, type MoveEvidence } from './moveExplanation.ts';
import { classifyAspects } from './aspects.ts';
import { ANALYST_FORMAT, type AnalystInput, outputOf, analystMessages, analystRepairPrompt, analystValidator,
  type NewsAnalysis } from './newsAnalyst.ts';
import { type RequestBudget, stageBudget } from './budget.ts';
import { generalAnswer, generalFallback } from './generalAnswer.ts';
import { recordRun, registerFact, runsOf } from './context.ts';
import type { RunMetrics, StoredAnswer } from './dataTypes.ts';
import { expandDraft, validateAnswer, type ValidateOptions } from './grounding.ts';
import { CONTRACT_TOOLS, modelToolSchemas, safeSourceLinks, sanitizeReasons, toolsForRoute, validateToolCall, wrapUntrusted } from './guards.ts';
import { AllModelsFailed, ANALYST_CALL_TOKEN_LIMIT, CALL_TOKEN_LIMIT, estimateInputTokens, type LlmDeps, type LlmMessage, QuotaError, rejectCompletion } from './llm.ts';
import type { NewsItem } from './marketTypes.ts';
import { explainPrompt, explainRepairPrompt, factLine, mainPrompt, repairPrompt, toolResultText, TOOLS_PROMPT } from './prompts.ts';
import type { AgentEvent, ChatMessage, ChatRequest, Lang, TraceItem } from './protocol.ts';
import { executeTool, projectForModel } from './registry.ts';
import { analystChain } from './modelPolicy.ts';
import { modelMessages } from './modelPrivacy.ts';
import { detectLang, isCompanyQuestion, isMoveQuestion, isOutlookQuestion, isPersonalQuestion, recentHistory, routeQuestion } from './router.ts';
import { followUpCalls, intentEvidence, MOVERS_ANALYZED, planIntent, topMovers, type IntentEvidence } from './intentContract.ts';
import { CALCULATION_VERSION, resolveTicker } from './tools/common.ts';
import { type AnalysisEvidence, type AnswerDraft, type Fact, type Intent, ToolInputError, type Route, type ToolCtx, type ToolResult } from './types.ts';
import { HISTORY_LIMIT_MESSAGE } from './workBudget.ts';

// Orchestration of one question: route → mandatory intent evidence or a bounded tool loop
// → model draft → validation → at most one repair → verified template. Every path ends with one
// verified answer or a human error, inside the request deadline; raw model text never streams.

export const MAX_ROUNDS = 2, CALLS_PER_ROUND = 4, MAX_TOOL_CALLS = 16, CONCURRENCY = 4;
// Buy writers get 1,500 output tokens and reserve a full repair call; output includes reasoning.
// A general explanation is prose (plus reasoning): 1,000 output tokens, still inside one 3,000-token call.
const TOOL_OUTPUT = 700, ANSWER_OUTPUT = 1500, EXPLAIN_OUTPUT = 1000, MIN_TOOL_OUTPUT = 300;

type T3 = Record<Lang, string>;
const TEXT = {
  understanding: { cs: 'Rozumím otázce…', sk: 'Rozumiem otázke…', en: 'Reading the question…' },
  loading: { cs: 'Načítám data…', sk: 'Načítavam údaje…', en: 'Loading data…' },
  searching: { cs: 'Hledám v ověřených zdrojích…', sk: 'Hľadám v overených zdrojoch…', en: 'Searching verified sources…' },
  writing: { cs: 'Připravuji odpověď…', sk: 'Pripravujem odpoveď…', en: 'Preparing the answer…' },
  offTopic: { cs: 'Pomáhám jen s otázkami k tvému portfoliu, investicím a trhům. Zeptej se prosím na ně.',
    sk: 'Pomáham len s otázkami k tvojmu portfóliu, investíciám a trhom. Opýtaj sa prosím na ne.',
    en: 'I can only help with your portfolio, investments and markets. Please ask about those.' },
  clarify: { cs: 'Kterou akcii nebo kryptoměnu myslíš? Napiš prosím přesný ticker.', sk: 'Ktorú akciu alebo kryptomenu myslíš? Napíš prosím presný ticker.',
    en: 'Which stock or crypto do you mean? Please write the exact ticker.' },
  quota: { cs: 'Dnešní kapacita bezplatných modelů je vyčerpaná. Zkus to prosím později.', sk: 'Dnešná kapacita bezplatných modelov je vyčerpaná. Skús to prosím neskôr.',
    en: 'Today\'s free model capacity is used up. Please try again later.' },
  timeout: { cs: 'Odpověď se nestihla připravit včas. Zkus to prosím znovu.', sk: 'Odpoveď sa nestihla pripraviť včas. Skús to prosím znova.',
    en: 'The answer could not be prepared in time. Please try again.' },
  notRun: 'Not run: limit.',
  refused: 'Refused: not allowed.',
  duplicate: 'Same call as an earlier one in this round; see its result.',
};
const TOOL_LABELS: Record<string, T3> = {
  get_portfolio_summary: { cs: 'Souhrn portfolia', sk: 'Súhrn portfólia', en: 'Portfolio summary' },
  get_holdings: { cs: 'Pozice', sk: 'Pozície', en: 'Holdings' }, get_transactions: { cs: 'Obchody', sk: 'Obchody', en: 'Trades' },
  get_realized_pnl: { cs: 'Realizované výsledky', sk: 'Realizované výsledky', en: 'Realized results' },
  get_tax_report: { cs: 'Daně', sk: 'Dane', en: 'Taxes' }, get_tax_lots: { cs: 'Nákupní loty', sk: 'Nákupné loty', en: 'Purchase lots' },
  simulate_sale: { cs: 'Simulace prodeje', sk: 'Simulácia predaja', en: 'Sale simulation' },
  get_performance: { cs: 'Výkonnost', sk: 'Výkonnosť', en: 'Performance' }, get_allocation: { cs: 'Rozložení portfolia', sk: 'Rozloženie portfólia', en: 'Allocation' },
  get_dividends: { cs: 'Dividendy', sk: 'Dividendy', en: 'Dividends' }, get_watchlist: { cs: 'Sledované', sk: 'Sledované', en: 'Watchlist' },
  get_quote: { cs: 'Cena', sk: 'Cena', en: 'Price' }, get_price_history: { cs: 'Historie ceny', sk: 'História ceny', en: 'Price history' },
  get_peers: { cs: 'Podobné firmy', sk: 'Podobné firmy', en: 'Peers' },
  get_fundamentals: { cs: 'Výkazy', sk: 'Výkazy', en: 'Financials' }, get_valuation_history: { cs: 'Historie ocenění', sk: 'História ocenenia', en: 'Valuation history' },
  get_fair_value: { cs: 'Férová hodnota', sk: 'Férová hodnota', en: 'Fair value' }, get_analyst_view: { cs: 'Názor analytiků', sk: 'Názor analytikov', en: 'Analyst view' },
  get_stock_news: { cs: 'Zprávy', sk: 'Správy', en: 'News' }, get_company_research: { cs: 'Informace o firmě z webu', sk: 'Informácie o firme z webu', en: 'Company research' },
  get_key_metrics: { cs: 'Klíčové ukazatele', sk: 'Kľúčové ukazovatele', en: 'Key metrics' }, search_web: { cs: 'Vyhledávání na webu', sk: 'Vyhľadávanie na webe', en: 'Web search' }, get_market_news: { cs: 'Zprávy z trhu', sk: 'Správy z trhu', en: 'Market news' },
  get_earnings_calendar: { cs: 'Výsledky hospodaření', sk: 'Hospodárske výsledky', en: 'Earnings' }, calculate: { cs: 'Výpočet', sk: 'Výpočet', en: 'Calculation' },
};

export type ChatOutcome = {
  outcome: 'ok' | 'fallback' | 'quota' | 'timeout' | 'error' | 'cancelled';
  answer: StoredAnswer | null;
  error?: { code: 'quota' | 'timeout' | 'failed'; text: string; retryAt?: string };
  metrics: RunMetrics;
};
type Deps = { ctx: ToolCtx; llm: LlmDeps };
type Emit = (event: AgentEvent) => void;

/* ----------------------------- tools ----------------------------- */

/** Runs tool calls at most four at a time on the stage budget (tools end 3 s before the deadline), recording full results. */
async function runTools(ctx: ToolCtx, calls: { name: string; args: unknown }[]): Promise<ToolResult<unknown>[]> {
  const staged: ToolCtx = { ...ctx, budget: stageBudget(ctx.budget) };
  const results: ToolResult<unknown>[] = new Array(calls.length);
  let next = 0;
  const worker = async () => {
    while (next < calls.length) {
      const i = next++;
      results[i] = await executeTool(calls[i].name, calls[i].args, staged);
      recordRun(ctx, { name: calls[i].name, args: calls[i].args, result: results[i] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, calls.length) }, worker));
  return results;
}

function traceOf(name: string, result: ToolResult<unknown>, lang: Lang): TraceItem {
  const label = TOOL_LABELS[name]?.[lang] ?? TOOL_LABELS.calculate[lang];
  if (!result.ok) return { label, state: 'unavailable' };
  const first = result.facts[0];
  return { label, state: 'ok', ...(first ? { asOf: first.as_of } : {}) };
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Loads every mandatory piece of a buy analysis itself; one failed branch leaves the others intact. */
export async function collectAnalysisEvidence(ticker: string, ctx: ToolCtx): Promise<AnalysisEvidence> {
  const period = { from: daysBefore(ctx.today, 30), to: ctx.today };
  const plan: [Exclude<keyof AnalysisEvidence, 'ticker'>, string, unknown][] = [
    ['quote', 'get_quote', { ticker }], ['analysts', 'get_analyst_view', { ticker }], ['fundamentals', 'get_fundamentals', { ticker }],
    ['valuationHistory', 'get_valuation_history', { ticker }], ['fairValue', 'get_fair_value', { ticker }], ['news', 'get_stock_news', { ticker, period }],
    ['earnings', 'get_earnings_calendar', { ticker }], ['holdings', 'get_holdings', { ticker }], ['allocation', 'get_allocation', {}],
  ];
  const results = await runTools(ctx, plan.map(([, name, args]) => ({ name, args })));
  const evidence = Object.fromEntries([['ticker', ticker], ...plan.map(([key], i) => [key, results[i]])]) as AnalysisEvidence;
  // The existing 3×3 sensitivity becomes a citable range: model outputs of a domain tool are first-hand facts.
  const fair = evidence.fairValue.ok ? evidence.fairValue.facts.find(f => f.metric === `fair_value:${ticker}:value`) : undefined;
  if (evidence.fairValue.ok && fair) {
    const cells = ((evidence.fairValue.data as { sensitivity?: { cells?: { value: number | null }[][] } }).sensitivity?.cells ?? [])
      .flat().map(c => c?.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (cells.length) {
      const base = { unit: 'money' as const, ...(fair.currency ? { currency: fair.currency } : {}), ticker, source: 'fair_value_model', as_of: fair.as_of,
        scope: fair.scope, quality: fair.quality };
      evidence.fairValue.facts.push(registerFact(ctx, { id: `fair_value:${ticker}:sensitivity_low`, value: Math.min(...cells), ...base }),
        registerFact(ctx, { id: `fair_value:${ticker}:sensitivity_high`, value: Math.max(...cells), ...base }));
    }
  }
  return evidence;
}

// What the writer sees of the evidence: the essentials, the verdict line and the headlines first;
// secondary facts last, so a tight budget trims those before anything mandatory.
const EVIDENCE_MAIN = [/^quote:[^:]+:price$/, /^fair_value:[^:]+:value$/, /^holding:[^:]+:allocation$/, /^calc:/,
  /^analysts:[^:]+:(target_mean|target_high|target_low|consensus)$/, /^fair_value:[^:]+:(sensitivity_low|sensitivity_high)$/, /^valuation:[^:]+:(current|median_5y|percentile):pe$/,
  /^earnings:[^:]+:next_date$/];
const EVIDENCE_MORE = [/^fair_value:[^:]+:(potential|margin_of_safety|implied_growth)$/, /^holding:[^:]+:value$/, /^analysts:[^:]+:(strong_buy|buy|hold|sell|strong_sell)$/,
  /^valuation:[^:]+:(current|median_5y|percentile):ps$/, /^fair_value:[^:]+:assumption:(growth|discount)$/, /^allocation:hhi$/];
function evidenceText(ctx: ToolCtx, evidence: AnalysisEvidence, policy: AnalysisPolicy): string {
  const facts = [...ctx.facts.values()], chosen = new Set<Fact>();
  const pick = (patterns: RegExp[]) => patterns.flatMap(re => facts.filter(f => re.test(f.id.split('#')[0]) && f.value !== null && !chosen.has(f) && chosen.add(f)));
  // A calculation is shown with what it computed, so the model can tell the ratio from the deviation.
  const line = (f: Fact) => {
    const rec = ctx.calculations.find(r => r.id === f.id);
    const value = typeof f.value === 'number' ? Number(f.value.toPrecision(6)) : f.value;
    return `[${f.id}] ${rec ? `${rec.op} ` : ''}=${value} ${f.currency ?? f.unit}`;
  };
  const essential = pick(EVIDENCE_MAIN.slice(0, 4)).map(line);
  const main = pick(EVIDENCE_MAIN.slice(4)).map(line), more = pick(EVIDENCE_MORE).map(line);
  const unavailable = (Object.entries(evidence) as [string, ToolResult<unknown> | string][]).flatMap(([k, r]) => typeof r === 'object' && !r.ok ? [k] : []);
  const items = evidence.news.ok ? ((evidence.news.data as { items?: NewsItem[] }).items ?? []) : [];
  return [`Evidence for ${evidence.ticker} (today ${ctx.today}):`,
    `Verdict line: verdict=${policy.verdict}; maximum confidence=${policy.maxConfidence}; basis=${policy.basis}${policy.conflict ? '; valuation and analysts disagree' : ''}${policy.stale ? '; some data stale' : ''}.`,
    ...essential,
    items.length ? wrapUntrusted(items.slice(0, 1).map(item => ({ ...item, title: item.title.slice(0, 120), summary: null }))) : 'No recent headlines.',
    ...main,
    unavailable.length ? `Unavailable: ${unavailable.join(', ')}` : '',
    ...more,
  ].filter(Boolean).join('\n');
}

/* ----------------------------- model loop ----------------------------- */

type DraftResult = { ok: true; draft: AnswerDraft } | { ok: false; reason: 'quota' | 'timeout' | 'budget' | 'invalid' | 'failed'; retryAt?: string | null; reasons?: string[] };
type Loop = { ctx: ToolCtx; llm: LlmDeps; route: Route; messages: LlmMessage[]; historyCount: number; toolNames: string[]; options: ValidateOptions;
  metrics: RunMetrics; emit: Emit; writerPrompt: string; output?: { max: number; min: number }; repair?: (reasons: readonly string[]) => string };

/** The analyst's JSON object, parsed strictly: the whole content (code fences aside) must be one JSON value. */
function parseAnalysis(content: string | null): unknown {
  if (!content) return null;
  try { return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}
function parseDraft(content: string | null): unknown {
  if (!content) return null;
  const text = content.replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Shrinks the request until it fits one call (≤ 3,000 tokens with room for an answer) and the
 * question's remaining tokens: the longest data message from its end (least important lines last),
 * then the oldest history, then data again down to a few lines.
 */
const TRIMMED = '(trimmed to fit the budget)';
function fit(messages: LlmMessage[], historyCount: number, tools: ReturnType<typeof modelToolSchemas>, llm: LlmDeps, output: number, keepTokens = 0): LlmMessage[] | null {
  const limit = () => Math.min(CALL_TOKEN_LIMIT, llm.tokens.available() - keepTokens);
  const room = tools.length ? MIN_TOOL_OUTPUT : output;
  const current = messages.map(m => ({ ...m }));
  let history = historyCount;
  for (let guard = 0; guard < 40; guard++) {
    if (estimateInputTokens(current, tools, llm.tokens.inflation) + room <= limit()) return current;
    let longest = -1;
    current.forEach((m, i) => { if (i > 0 && (m.content?.length ?? 0) > (longest < 0 ? 0 : current[longest].content?.length ?? 0)) longest = i; });
    const lines = (longest < 0 ? [] : current[longest].content?.split('\n') ?? []).filter(l => l !== TRIMMED);
    // Data is trimmed down to its most important lines before the conversation history goes.
    if (lines.length < 4 && history > 0) { current.splice(1, 1); history--; continue; }
    if (lines.length < (current[longest]?.role === 'tool' ? 2 : 4)) return null;
    const kept = lines.slice(0, Math.min(lines.length - 1, Math.ceil(lines.length * 0.75)));
    // A cut never leaves third-party text outside its untrusted block.
    const open = kept.lastIndexOf('<untrusted_news>') > kept.lastIndexOf('</untrusted_news>');
    current[longest] = { ...current[longest], content: [...kept, ...(open ? ['</untrusted_news>'] : []), TRIMMED].join('\n') };
  }
  return null;
}

async function modelDraft(loop: Loop): Promise<DraftResult> {
  const { ctx, llm, route, metrics } = loop;
  const project = await modelMessages(ctx);
  const stage = stageBudget(ctx.budget);
  let messages = loop.messages, history = loop.historyCount, rounds = 0, repaired = false;
  while (true) {
    if (stage.remainingMs() <= 0) return { ok: false, reason: 'timeout' };
    const offerTools = !repaired && loop.toolNames.length > 0 && rounds < MAX_ROUNDS && metrics.toolCalls < MAX_TOOL_CALLS && llm.tokens.available() > 4000;
    let tools = offerTools ? modelToolSchemas(loop.toolNames) : [];
    let answerOutput = loop.output?.max ?? (route.analysis ? ANSWER_OUTPUT : loop.options.explain ? EXPLAIN_OUTPUT : 800);
    // A writer with a range (move explanation) gets whatever the call leaves above its minimum, up to its maximum.
    let answerMin = Math.min(loop.output?.min ?? answerOutput, answerOutput);
    const output = offerTools ? TOOL_OUTPUT : answerMin;
    let keepTokens = tools.length ? 4000 : repaired ? 0 : 3000;
    const stageMessages = () => project([{ role: 'system', content: tools.length ? TOOLS_PROMPT : loop.writerPrompt }, ...messages.slice(1)]);
    // Offer fewer optional schemas before discarding a short conversation history.
    while (tools.length > 1 && estimateInputTokens(stageMessages(), tools, llm.tokens.inflation) + MIN_TOOL_OUTPUT
      > Math.min(CALL_TOKEN_LIMIT, llm.tokens.available() - keepTokens)) tools = tools.slice(0, -1);
    let fitted = fit(stageMessages(), history, tools, llm, output, keepTokens);
    // Schemas can exceed a byte-bound call: offer a useful prefix, still validated by the full route.
    while (!fitted && tools.length > 1) { tools = tools.slice(0, -1); fitted = fit(stageMessages(), history, tools, llm, output, keepTokens); }
    if (!fitted && tools.length) { tools = []; keepTokens = repaired ? 0 : 3000; fitted = fit(stageMessages(), history, tools, llm, answerMin, keepTokens); }
    if (!fitted && !route.analysis) { answerOutput = Math.min(answerOutput, 512); answerMin = Math.min(answerMin, 512); fitted = fit(stageMessages(), history, tools, llm, answerMin, keepTokens); }
    if (!fitted) return { ok: false, reason: 'budget' };
    let completion;
    try {
      completion = await llm.complete(llm.policy.main, { messages: fitted, tools, maxOutput: tools.length ? output : answerOutput,
        minOutput: tools.length ? MIN_TOOL_OUTPUT : answerMin, keepTokens, phase: repaired ? 'repair' : tools.length ? 'tools' : 'answer' },
        { budget: stage, tokens: llm.tokens, policy: llm.policy, keys: llm.keys, fetchImpl: llm.fetchImpl, now: llm.now, sleep: llm.sleep });
    } catch (error) {
      if (ctx.budget.signal.aborted) throw ctx.budget.signal.reason ?? error;
      if (error instanceof QuotaError) return { ok: false, reason: 'quota', retryAt: error.retryAt };
      if (error instanceof AllModelsFailed) return { ok: false, reason: error.code === 'timeout' ? 'timeout' : error.code === 'budget' ? 'budget' : 'failed' };
      throw error;
    }
    metrics.model = completion.model.id;
    history -= messages.length - fitted.length;
    messages = fitted;
    const calls = completion.message.toolCalls ?? [];
    const finishReasons = completion.finishReason === 'length' ? ['truncated']
      : calls.length ? completion.finishReason === 'tool_calls' && tools.length ? [] : ['finish_reason']
      : completion.finishReason === 'stop' ? [] : ['finish_reason'];
    if (!finishReasons.length && calls.length && tools.length) {
      rounds++;
      messages = [...messages, { role: 'assistant', content: null, toolCalls: calls }];
      const runnable: { index: number; name: string; args: unknown }[] = [];
      const replies: string[] = calls.map(() => TEXT.notRun);
      calls.forEach((call, index) => {
        let args: unknown;
        try { args = JSON.parse(call.arguments || '{}'); } catch { args = undefined; }
        if (!tools.some(t => t.name === call.name) || !validateToolCall(call.name, args, route)) {
          rejectCompletion(llm.tokens, completion, [args === undefined ? 'tool_call_format' : 'tool_not_allowed']);
          replies[index] = TEXT.refused; return;
        }
        const same = runnable.find(r => r.name === call.name && JSON.stringify(r.args) === JSON.stringify(args));
        if (same) { replies[index] = TEXT.duplicate; return; }
        if (runnable.length < CALLS_PER_ROUND && metrics.toolCalls + runnable.length < MAX_TOOL_CALLS) runnable.push({ index, name: call.name, args });
      });
      loop.emit({ type: 'status', text: TEXT.loading[route.lang] });
      const results = await runTools(ctx, runnable.map(r => ({ name: r.name, args: r.args })));
      metrics.toolCalls += runnable.length;
      runnable.forEach((r, i) => {
        if (!metrics.toolsUsed.includes(r.name)) metrics.toolsUsed.push(r.name);
        replies[r.index] = toolResultText(projectForModel(r.name, results[i]) as ToolResult<unknown>, route.lang, 30, true);
      });
      if (runnable.length) loop.emit({ type: 'trace', items: runnable.map((r, i) => traceOf(r.name, results[i], route.lang)) });
      messages = [...messages, ...calls.map((call, i) => ({ role: 'tool' as const, toolCallId: call.id, content: replies[i] }))];
      continue;
    }
    const checked = finishReasons.length ? { ok: false as const, reasons: finishReasons }
      : validateAnswer(expandDraft(parseDraft(completion.message.content), ctx.facts), ctx.facts, ctx.calculations, loop.options);
    if (checked.ok) return checked;
    const { reasons } = checked as { reasons: string[] };
    rejectCompletion(llm.tokens, completion, sanitizeReasons(reasons));
    if (repaired) return { ok: false, reason: 'invalid', reasons };
    // One repair: the reasons only — the rejected text is never sent back or shown.
    repaired = true;
    rounds = MAX_ROUNDS;
    messages = [...messages, { role: 'user', content: (loop.repair ?? (loop.options.explain ? explainRepairPrompt : repairPrompt))(sanitizeReasons(reasons)) }];
  }
}

/* ----------------------------- orchestration ----------------------------- */

function emptyMetrics(): RunMetrics {
  return { model: null, routerModel: null, tokensIn: 0, tokensOut: 0, maxCallTokens: 0, toolCalls: 0, toolsUsed: [], wallMs: 0, ttftMs: null,
    outcome: 'error', groundingOk: false, calculationVersion: CALCULATION_VERSION, errorCode: null };
}
const plainAnswer = (text: string, lang: Lang): StoredAnswer => ({ text, links: [], trace: [], lang, outcome: 'ok', verified: true });

/** Deterministic evidence for a non-analysis question when no model produced a draft. */
const FALLBACK_TOOLS: Record<Route['group'], (route: Route) => { name: string; args: unknown }[]> = {
  portfolio: () => [{ name: 'get_portfolio_summary', args: {} }, { name: 'get_holdings', args: {} }],
  dane: route => [{ name: 'get_realized_pnl', args: { ...route.period, currency: 'CZK' } }],
  trh: route => route.tickers.slice(0, 2).map(ticker => ({ name: 'get_quote', args: { ticker } })),
  valuace: route => route.tickers.slice(0, 1).flatMap(ticker => [{ name: 'get_quote', args: { ticker } }, { name: 'get_fair_value', args: { ticker } }]),
  obecne: () => [{ name: 'get_portfolio_summary', args: {} }],
  mimo_temu: () => [],
};
/** The keyword intent, when known, decides the fallback tools: the template then answers the question asked. */
const INTENT_TOOLS: Partial<Record<Exclude<Intent, 'buy'>, (route: Route, ctx: ToolCtx) => { name: string; args: unknown }[]>> = {
  summary: () => [{ name: 'get_portfolio_summary', args: {} }],
  transactions: route => [{ name: 'get_transactions', args: { ...route.period, ...(route.tickers.length === 1 ? { ticker: route.tickers[0] } : {}) } }],
  tax: (route, ctx) => [{ name: 'get_tax_report', args: { year: Number(route.period.from.slice(0, 4)) } },
    { name: 'get_realized_pnl', args: { ...route.period, currency: ctx.preferences.localCurrency } }],
  dividends: route => [{ name: 'get_dividends', args: { mode: 'received', ...route.period } }],
  quote: route => route.tickers.slice(0, 2).map(ticker => ({ name: 'get_quote', args: { ticker } })),
};
function fallbackCalls(route: Route, ctx: ToolCtx): { name: string; args: unknown }[] {
  return route.intent && route.intent !== 'buy' ? INTENT_TOOLS[route.intent]?.(route, ctx) ?? [] : FALLBACK_TOOLS[route.group](route);
}

type Finish = (outcome: ChatOutcome['outcome'], answer: StoredAnswer | null, error?: ChatOutcome['error']) => ChatOutcome;

/* ----------------------------- news analyst (Běh 23) ----------------------------- */

type AnalystResult = { ok: true; analysis: NewsAnalysis } | { ok: false; reason: 'quota' | 'timeout' | 'budget' | 'invalid' | 'failed'; retryAt?: string | null };
// The movers analysis allows its repair only when this much more remains.
const REPAIR_RESERVE = 3000;

/**
 * One JSON-object call of the main model over the article passages (no tools, no history), sized before the call so
 * that nothing is cut blindly: up to 5,000 tokens (input + output) within what the question's 8,000 still hold. The
 * validator decides, the rejected text is never sent back. At most one repair, and only when it fits what is left of
 * the question; otherwise the caller's extract fallback answers.
 */
async function runAnalyst(input: AnalystInput, { ctx, llm }: Deps, metrics: RunMetrics, repair: boolean): Promise<AnalystResult> {
  const project = await modelMessages(ctx);
  const stage = stageBudget(ctx.budget);
  const estimate = (m: LlmMessage[]) => estimateInputTokens(project(m), [], llm.tokens.inflation, ANALYST_FORMAT);
  let reasons: string[] | null = null, first: number | undefined;
  // A thin analysis (fewer themes than asked) is kept while its repair is tried; it answers when the repair does not do better.
  let thin: NewsAnalysis | null = null;
  const fallback = (reason: Extract<AnalystResult, { ok: false }>['reason']): AnalystResult => thin ? { ok: true, analysis: thin } : { ok: false, reason };
  for (let attempt = 0; attempt < (repair ? 2 : 1); attempt++) {
    if (stage.remainingMs() <= 0) return fallback('timeout');
    const fix: LlmMessage | null = reasons ? { role: 'user', content: analystRepairPrompt(sanitizeReasons(reasons)) } : null;
    // The estimate is of the redacted messages actually sent; the repair note is part of the same call, which resends
    // exactly the articles of the first one (shorter passages if needed).
    const limit = Math.min(ANALYST_CALL_TOKEN_LIMIT, llm.tokens.available()) - outputOf(input).min;
    // A repair that no longer fits the question is not attempted: the extracts answer instead.
    if (limit < 600) return fallback(attempt ? 'invalid' : 'budget');
    const { messages, shown, fits } = analystMessages(input, limit, estimate, fix ? [fix] : [], first);
    if (!fits) return fallback(attempt ? 'invalid' : 'budget');
    first ??= shown;
    const check = analystValidator(input, shown);
    let completion;
    try {
      completion = await llm.complete(analystChain(llm.policy), { messages: project(messages), tools: [], maxOutput: outputOf(input).max,
        minOutput: outputOf(input).min, phase: attempt ? 'repair' : 'answer', callLimit: ANALYST_CALL_TOKEN_LIMIT },
      { budget: stage, tokens: llm.tokens, policy: llm.policy, keys: llm.keys, fetchImpl: llm.fetchImpl, now: llm.now, sleep: llm.sleep });
    } catch (error) {
      if (ctx.budget.signal.aborted) throw ctx.budget.signal.reason ?? error;
      if (thin) return { ok: true, analysis: thin };
      if (error instanceof QuotaError) return { ok: false, reason: 'quota', retryAt: error.retryAt };
      if (error instanceof AllModelsFailed) return { ok: false, reason: error.code === 'timeout' ? 'timeout' : error.code === 'budget' ? 'budget' : 'failed' };
      throw error;
    }
    metrics.model = completion.model.id;
    const result = completion.finishReason === 'length' ? { ok: false as const, reasons: ['truncated'] }
      : completion.finishReason !== 'stop' || completion.message.toolCalls?.length ? { ok: false as const, reasons: ['finish_reason'] }
        : check(parseAnalysis(completion.message.content));
    if (result.ok && !result.thin) return { ok: true, analysis: result.analysis };
    if (result.ok) {
      if (!thin || result.analysis.themes.length > thin.themes.length) thin = result.analysis;
      reasons = result.reasons ?? ['themes_few'];
    } else reasons = result.reasons;
    rejectCompletion(llm.tokens, completion, sanitizeReasons(reasons));
  }
  return fallback('invalid');
}

/**
 * Any other investing question about no one's own data (Běh 27): its topic words are searched on verified publishers, the
 * analyst answers from the pages (a direct answer, attributed points), the server renders it with the sources. Null when
 * nothing was found or no analysis passed: the caller's usual path answers instead.
 */
async function webAnswer(route: Route, question: string, { ctx, llm }: Deps, emit: Emit, metrics: RunMetrics, finish: Finish): Promise<ChatOutcome | null> {
  const query = webSearchQuery(question);
  if (query.split(' ').length < 2 || stageBudget(ctx.budget).remainingMs() < NEWS_RESCUE_MS) return null;
  llm.tokens.allowAnalysis();
  emit({ type: 'status', text: TEXT.searching[route.lang] });
  const [found] = await runTools(ctx, [{ name: 'search_web', args: { query } }]);
  metrics.toolCalls += 1;
  if (!metrics.toolsUsed.includes('search_web')) metrics.toolsUsed.push('search_web');
  emit({ type: 'trace', items: [traceOf('search_web', found, route.lang)] });
  const { news } = collectArticles(ctx, [['WEB', found]], 8);
  if (!news.length) return null;
  emit({ type: 'status', text: TEXT.writing[route.lang] });
  const input: AnalystInput = { mode: 'move', focus: 'web', question, lang: route.lang, subject: 'the question', facts: [`Question: ${question}`, `Today: ${ctx.today}.`],
    articles: news, tickers: ['WEB', ...route.tickers], keywords: query.split(' ').filter(w => w.length >= 3) };
  const result = await runAnalyst(input, { ctx, llm }, metrics, true);
  if (!result.ok) return null;
  metrics.groundingOk = true;
  return finish('ok', { ...renderWebAnswer(ctx, news, (result as Extract<AnalystResult, { ok: true }>).analysis, route.lang),
    trace: runsOf(ctx).map(r => traceOf(r.name, r.result, route.lang)) });
}

// Words of a question about what is happening now or next (cs/sk/en): searched first, not explained from memory (Běh 27).
const CURRENT = /(?<![\p{L}])(?:dnes|dneska|teď|ted|nyní|momentálně|aktuáln\p{L}*|letos|letošn\p{L}*|příští\p{L}*|budouc\p{L}*|výhled\p{L}*|prognóz\p{L}*|předpově\p{L}*|poslední\p{L}*|nejnověj\p{L}*|novink\p{L}*|zprávy|děje|stalo|sazb\p{L}*|úrok\p{L}*|inflac\p{L}*|fed\p{L}*|čnb|ecb|recese|recesi|krize|krizi|cena|ceny|cenu|kurz\p{L}*|trh\p{L}*|trzích|burz\p{L}*|sektor\p{L}*|odvětví|teraz|aktuálne|budúc\p{L}*|výhľad\p{L}*|today|now|currently|this (?:year|week|month)|next (?:year|month)|latest|recent|outlook|forecast|rates?|inflation|recession|market\p{L}*|price\p{L}*|sector\p{L}*|20\d\d)(?![\p{L}])/iu;

// A failed answer about a named instrument is retried as the article analysis only with this much time left.
const NEWS_RESCUE_MS = 15_000;
// The movers analysis runs only with room for one full call and the time for it; otherwise the headlines stay.
const MOVERS_ANALYST_TOKENS = 2600, MOVERS_ANALYST_MS = 12_000;
/**
 * "Co se dnes děje s mými akciemi?": the top two movers' articles read by the analyst, one attributed theme each, as
 * the answer's notes instead of bare headlines. Null (keep the headline notes) without articles, budget or a valid analysis.
 */
async function moverNotes(route: Route, deps: Deps, metrics: RunMetrics): Promise<string | null> {
  const { ctx, llm } = deps;
  if (llm.tokens.available() < MOVERS_ANALYST_TOKENS || stageBudget(ctx.budget).remainingMs() < MOVERS_ANALYST_MS) return null;
  const runs = runsOf(ctx);
  const holdings = runs.find(r => r.name === 'get_holdings')?.result;
  const movers = topMovers(holdings).slice(0, MOVERS_ANALYZED);
  const newsOf = (t: string) => runs.find(r => r.name === 'get_stock_news' && (r.args as { ticker?: string }).ticker === t)?.result;
  const articles = [];
  for (const t of movers) articles.push(...collectArticles(ctx, [[t, newsOf(t)]], 2, articles.length).news);
  if (!articles.length) return null;
  const pct = (key: string) => {
    const f = holdings?.ok ? holdings.facts.find(x => (x.metric ?? x.id) === key) : undefined;
    return typeof f?.value === 'number' ? f.value : null;
  };
  const input: AnalystInput = { mode: 'movers', lang: route.lang, subject: 'portfolio', articles, tickers: movers,
    facts: [`Portfolio today: ${direction(pct('portfolio:day_change_pct'))}.`, ...movers.map(t => `${t} today: ${direction(pct(`holding:${t}:day_change_pct`))}.`)],
    keywords: movers.flatMap(t => { const r = newsOf(t); return nameKeywords(t, r?.ok ? (r as { data: { name?: string | null } }).data.name ?? null : null); }) };
  const result = await runAnalyst(input, deps, metrics, llm.tokens.available() >= REPAIR_RESERVE + MOVERS_ANALYST_TOKENS);
  return result.ok ? renderMoverThemes((result as Extract<AnalystResult, { ok: true }>).analysis, articles, route.lang) : null;
}

/**
 * "What is going on with X over the last days?" (Běh 22/23): every mandatory call runs before the analyst; the server
 * states the figures, the analyst (no tools, no history) reads the article excerpts and adds attributed likely drivers.
 * Without articles, or after two rejected analyses, the server answers with the move and attributed article extracts.
 */
async function explainMove(route: Route, question: string, { ctx, llm }: Deps, emit: Emit, metrics: RunMetrics, finish: Finish,
  focus?: MoveEvidence['focus']): Promise<ChatOutcome> {
  const lang = route.lang;
  // The article analysis may reserve the larger question budget (Běh 27).
  llm.tokens.allowAnalysis();
  let ticker: string;
  try {
    ticker = (await resolveTicker({ ...ctx, budget: stageBudget(ctx.budget) }, route.tickers[0])).ticker;
  } catch (error) {
    if (ctx.budget.signal.aborted) throw ctx.budget.signal.reason ?? error;
    if (error instanceof ToolInputError && error.code === 'clarify') {
      // A company name no provider could map to a symbol (Běh 30): the question is searched and answered from the pages.
      if (!/^[A-Z0-9.-]{1,10}$/.test(route.tickers[0] ?? '') && !isPersonalQuestion(question)) {
        const answered = await webAnswer({ ...route, tickers: [] }, question, { ctx, llm }, emit, metrics, finish);
        if (answered) return answered;
      }
      metrics.groundingOk = true; return finish('ok', plainAnswer(TEXT.clarify[lang], lang));
    }
    throw error;
  }
  emit({ type: 'status', text: TEXT.loading[lang] });
  // A company or outlook question: a small model reads what it asks (Běh 31), merged with the keyword reading.
  // Only a question about a price move reads as a move; any other question about the company is an outlook (Běh 31).
  const resolved = focus ?? (isOutlookQuestion(question) || isCompanyQuestion(question) || !isMoveQuestion(question) ? 'outlook' : 'move');
  const asks = resolved === 'outlook' ? asksFrom(await classifyAspects(question, ctx, llm)) : undefined;
  const { evidence, calls } = await collectMoveEvidence(ticker, question, ctx, lang, batch => runTools(ctx, batch), resolved, asks);
  metrics.toolCalls += calls.length;
  metrics.toolsUsed.push(...calls.map(c => c.name).filter((n, i, all) => all.indexOf(n) === i && !metrics.toolsUsed.includes(n)));
  const trace = () => runsOf(ctx).map(r => traceOf(r.name, r.result, lang));
  emit({ type: 'trace', items: trace() });
  let failed: Extract<AnalystResult, { ok: false }> | undefined;
  if (evidence.news.length) {
    emit({ type: 'status', text: TEXT.writing[lang] });
    const result = await runAnalyst(moveAnalystInput(evidence), { ctx, llm }, metrics, true);
    if (result.ok) {
      metrics.groundingOk = true;
      return finish('ok', { ...renderMoveAnswer(ctx, evidence, (result as Extract<AnalystResult, { ok: true }>).analysis), outcome: 'ok', trace: trace() });
    }
    failed = result as Extract<AnalystResult, { ok: false }>;
    metrics.errorCode = failed.reason;
  }
  if (!ctx.facts.size && failed?.reason === 'quota') return finish('quota', null, { code: 'quota', text: TEXT.quota[lang], ...(failed.retryAt ? { retryAt: failed.retryAt } : {}) });
  if (!ctx.facts.size && failed?.reason === 'timeout') return finish('timeout', null, { code: 'timeout', text: TEXT.timeout[lang] });
  const outcome = failed?.reason === 'timeout' ? 'timeout' : 'fallback';
  return finish(outcome, { ...renderMoveAnswer(ctx, evidence, null), outcome, trace: trace() });
}

/**
 * Answers one question. Progress goes to `emit` (status/trace only); the result is the verified
 * answer to store and send, or a human error. Cancellation ends with `cancelled` and no answer.
 */
export async function answerQuestion(input: { request: ChatRequest; history: ChatMessage[] }, deps: Deps, emit: Emit = () => {}): Promise<ChatOutcome> {
  const { ctx, llm } = deps;
  const now = llm.now ?? Date.now;
  const started = now();
  const metrics = emptyMetrics();
  // One canonical form for the keyword router, guards and the writer (decomposed accents hide keyword intents).
  const question = input.request.question.normalize('NFC');
  let lang: Lang = detectLang(question) ?? ctx.lang;
  let activeRoute: Route | undefined, contract: IntentEvidence | undefined;
  const finish = (outcome: ChatOutcome['outcome'], answer: StoredAnswer | null, error?: ChatOutcome['error']): ChatOutcome => {
    metrics.tokensIn = llm.tokens.input; metrics.tokensOut = llm.tokens.output; metrics.maxCallTokens = llm.tokens.maxCall;
    metrics.attempts = llm.tokens.attempts.map(a => ({ ...a, rejectionReasons: [...a.rejectionReasons] }));
    metrics.wallMs = now() - started; metrics.outcome = outcome;
    return { outcome, answer, ...(error ? { error } : {}), metrics };
  };
  try {
    emit({ type: 'status', text: TEXT.understanding[lang] });
    const explanation = generalAnswer(question, lang);
    if (explanation) { metrics.groundingOk = true; return finish('ok', plainAnswer(explanation, lang)); }
    const route = await routeQuestion(question, input.history, ctx, llm);
    activeRoute = route;
    lang = route.lang;
    metrics.routerModel = llm.policy.router[0]?.id ?? null;
    if (route.group === 'mimo_temu') { metrics.groundingOk = true; return finish('ok', plainAnswer(TEXT.offTopic[lang], lang)); }
    if (route.needsClarification) { metrics.groundingOk = true; return finish('ok', plainAnswer(TEXT.clarify[lang], lang)); }
    const history = recentHistory(input.history, await modelMessages(ctx));
    // A general investing question (no intent, no instrument analysis, not about own data, not a follow-up): the model
    // explains in its own words. Anything personal keeps the fact-selection path (Běh 14: no prose around own numbers).
    const explain = route.group === 'obecne' && !route.intent && !route.analysis && !input.history.length && !isPersonalQuestion(question);
    const system: LlmMessage = { role: 'system', content: explain ? explainPrompt(lang) : mainPrompt(lang, route.analysis) };
    if (route.intent === 'move_explanation' && route.tickers.length) return await explainMove(route, question, deps, emit, metrics, finish);
    // Any other investing question about no instrument and no one's own data (Běh 27): about markets, prices, outlooks or
    // current events it is searched and answered from the pages first; a concept the model explains itself, and only
    // when that explanation fails is it searched.
    const searchable = (!route.intent || route.intent === 'move_explanation') && !route.analysis && !route.tickers.length && !isPersonalQuestion(question)
      && ['obecne', 'trh', 'valuace'].includes(route.group);
    if (searchable && (route.group !== 'obecne' || CURRENT.test(question))) {
      const answered = await webAnswer(route, question, deps, emit, metrics, finish);
      if (answered) return answered;
    }
    let evidence: AnalysisEvidence | undefined;
    let options: ValidateOptions = { lang };
    let user: string;
    let toolNames: string[];
    if (route.analysis) {
      let ticker: string;
      try {
        ticker = (await resolveTicker({ ...ctx, budget: stageBudget(ctx.budget) }, route.tickers[0])).ticker;
      } catch (error) {
        if (ctx.budget.signal.aborted) throw ctx.budget.signal.reason ?? error;
        if (error instanceof ToolInputError && error.code === 'clarify') { metrics.groundingOk = true; return finish('ok', plainAnswer(TEXT.clarify[lang], lang)); }
        throw error;
      }
      emit({ type: 'status', text: TEXT.loading[lang] });
      evidence = await collectAnalysisEvidence(ticker, ctx);
      metrics.toolCalls += 9;
      metrics.toolsUsed.push(...runsOf(ctx).map(r => r.name).filter((n, i, all) => all.indexOf(n) === i));
      emit({ type: 'trace', items: runsOf(ctx).map(r => traceOf(r.name, r.result, lang)) });
      const policy = analysisPolicy(ctx, evidence);
      options = { lang, analysis: { verdict: policy.verdict, maxConfidence: policy.maxConfidence } };
      user = `${question}\n\n${evidenceText(ctx, evidence, policy)}`;
      toolNames = [];
    } else {
      user = `${question}\n\n(Today is ${ctx.today}.${route.tickers.length ? ` Instruments mentioned: ${route.tickers.join(', ')}.` : ''})`;
      toolNames = toolsForRoute(route);
      if (explain) {
        // Concepts need no portfolio tools; a named instrument's live quote is loaded here so a figure can be a fact.
        options = { lang, explain: true };
        toolNames = [];
        const calls = route.tickers.slice(0, 2).map(ticker => ({ name: 'get_quote', args: { ticker } }));
        if (calls.length) {
          emit({ type: 'status', text: TEXT.loading[lang] });
          const results = await runTools(ctx, calls);
          metrics.toolCalls += calls.length;
          metrics.toolsUsed.push(...calls.map(c => c.name));
          emit({ type: 'trace', items: calls.map((c, i) => traceOf(c.name, results[i], lang)) });
          const facts = results.flatMap(r => r.ok ? r.facts.filter(f => f.value !== null && f.source !== 'assumption') : []);
          if (facts.length) user += `\nFacts you may cite as {{slots}}:\n${facts.map(f => factLine(f, lang)).join('\n')}`;
        }
      }
      // A successful unrelated tool is not evidence for the requested total or annual tax.
      if (route.intent === 'summary' || route.intent === 'tax') options = { lang, requiredFactIds: [route.intent === 'summary'
        ? 'portfolio:total_value' : `tax:${route.period.from.slice(0, 4)}:estimated_tax`] };
      // Unsupported tax residence is established locally, never left to the model's tool choice.
      const unsupportedTax = route.intent === 'tax' && (await ctx.loadSnapshot()).data.settings.taxResidence === 'OTHER';
      if (route.intent && (CONTRACT_TOOLS[route.intent] || unsupportedTax)) {
        const plan = await planIntent(route, question, ctx);
        if (plan.clarification) { metrics.groundingOk = true; return finish('ok', plainAnswer(plan.clarification, lang)); }
        emit({ type: 'status', text: TEXT.loading[lang] });
        let results = await runTools(ctx, plan.calls);
        // Evidence that depends on the first results (headlines for today's top movers).
        const more = followUpCalls(route, results, ctx);
        if (more.length) { results = [...results, ...await runTools(ctx, more)]; plan.calls.push(...more); }
        metrics.toolCalls += plan.calls.length;
        metrics.toolsUsed.push(...plan.calls.map(c => c.name).filter((n, i, all) => all.indexOf(n) === i));
        emit({ type: 'trace', items: plan.calls.map((c, i) => traceOf(c.name, results[i], lang)) });
        contract = intentEvidence(route, results);
        options = { lang, requiredFactIds: contract.facts.map(f => f.id), evidenceMissing: contract.missing };
        user += `\nRequired answer facts: select every fact below, not a subset.\n${contract.facts.map(f => factLine(f, lang)).join('\n')}`;
        toolNames = [];
      }
    }
    emit({ type: 'status', text: TEXT.writing[lang] });
    const result = await modelDraft({ ctx, llm, route, messages: [system, ...history, { role: 'user', content: user }],
      historyCount: history.length, toolNames, options, metrics, emit, writerPrompt: system.content! });
    // Today's movers: the analyst explains the top two from their articles when the budget still allows it.
    if (route.intent === 'movers' && contract && !(!result.ok && ['quota', 'timeout'].includes((result as { reason: string }).reason))) {
      const notes = await moverNotes(route, deps, metrics);
      if (notes) contract.notes = [notes];
    }
    const links = safeSourceLinks(runsOf(ctx).flatMap(r => r.result.ok && (r.name === 'get_stock_news' || r.name === 'get_market_news')
      ? ((r.result.data as { items?: NewsItem[] }).items ?? []) : []));
    if (result.ok) {
      metrics.groundingOk = true;
      const answer = evidence ? buildVerifiedTemplate(ctx, route, evidence) : renderSelectedFacts(ctx, result.draft, links, contract, explain);
      return finish('ok', { ...answer, outcome: 'ok', trace: runsOf(ctx).map(r => traceOf(r.name, r.result, lang)) });
    }
    const failed = result as Extract<DraftResult, { ok: false }>;
    metrics.errorCode = failed.reason;
    // A question about a named instrument is never left at "could not load the data" or a generic note (Běh 26, SPCX):
    // the articles answer, read as an assessment of the company.
    const rescue = route.tickers.length > 0 && !isPersonalQuestion(question) && !['quota', 'timeout'].includes(failed.reason)
      && stageBudget(ctx.budget).remainingMs() > NEWS_RESCUE_MS;
    if (explain && rescue) { metrics.errorCode = null; return await explainMove(route, question, deps, emit, metrics, finish, 'company'); }
    // A concept the model could not explain: searched and answered from the pages before the authored fallback (Běh 27).
    if (explain && searchable && !['quota', 'timeout'].includes(failed.reason) && !ctx.facts.has('search:WEB:count')) {
      const answered = await webAnswer(route, question, deps, emit, metrics, finish);
      if (answered) { metrics.errorCode = null; return answered; }
    }
    if (explain) {
      // Two rejected explanations: a short honest general answer (authored, no figures), with any loaded quote verified.
      const general = generalFallback(question, lang);
      const loaded = ctx.facts.size ? buildVerifiedTemplate(ctx, { ...route, group: 'trh' }) : null;
      // Only loaded facts worth showing; never the "could not load the data" sentence under the explanation.
      const facts = loaded && !isNoDataText(loaded.text) ? loaded : null;
      const outcome = failed.reason === 'timeout' ? 'timeout' : 'fallback';
      return finish(outcome, { text: facts ? `${general}\n\n${facts.text}` : general, links: facts?.links ?? [], lang, verified: true, outcome,
        trace: runsOf(ctx).map(r => traceOf(r.name, r.result, lang)) });
    }
    if (!evidence && !contract && (!runsOf(ctx).some(r => r.result.ok)
      || options.requiredFactIds?.some(id => !ctx.facts.has(id))) && stageBudget(ctx.budget).remainingMs() > 0) {
      const calls = fallbackCalls(route, ctx);
      if (calls.length) { await runTools(ctx, calls); metrics.toolCalls += calls.length; metrics.toolsUsed.push(...calls.map(c => c.name)); }
    }
    const template = { ...buildVerifiedTemplate(ctx, route, evidence, contract), trace: runsOf(ctx).map(r => traceOf(r.name, r.result, lang)) };
    const hasFacts = ctx.facts.size > 0;
    if (!hasFacts && failed.reason === 'quota') {
      return finish('quota', null, { code: 'quota', text: TEXT.quota[lang], ...(failed.retryAt ? { retryAt: failed.retryAt } : {}) });
    }
    if (!hasFacts && failed.reason === 'timeout') return finish('timeout', null, { code: 'timeout', text: TEXT.timeout[lang] });
    if (rescue && (!hasFacts || isNoDataText(template.text))) {
      metrics.errorCode = null;
      return await explainMove(route, question, deps, emit, metrics, finish, 'company');
    }
    const outcome = failed.reason === 'timeout' ? 'timeout' : 'fallback';
    return finish(outcome, { ...template, outcome });
  } catch (error) {
    if (ctx.budget.signal.aborted) return finish('cancelled', null);
    metrics.errorCode = (error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'failed';
    // Whatever failed, verified facts already loaded still make an answer.
    try {
      if (ctx.facts.size) {
        const route: Route = activeRoute ?? { group: 'obecne', lang, tickers: [], period: { from: `${ctx.today.slice(0, 4)}-01-01`, to: ctx.today }, needsClarification: false, analysis: false };
        const template = buildVerifiedTemplate(ctx, route, undefined, contract);
        if (ctx.facts.size) return finish('fallback', template);
      }
    } catch { /* fall through to the human error */ }
    // A history over the calculation limits (refused before loading, audit A5) is final: no "try again".
    if (error instanceof ToolInputError && error.message === HISTORY_LIMIT_MESSAGE) {
      return finish('error', null, { code: 'failed', text: ({ cs: HISTORY_LIMIT_MESSAGE,
        sk: 'Takúto rozsiahlu históriu teraz neviem bezpečne dopočítať, otvor prehľad v Trackore.',
        en: 'This history is too large to calculate safely here; open the overview in Trackora.' })[lang] });
    }
    return finish('error', null, { code: metrics.errorCode === 'timeout' ? 'timeout' : 'failed', text: (metrics.errorCode === 'timeout' ? TEXT.timeout : {
      cs: 'Odpověď se nepodařila. Zkus to prosím znovu.', sk: 'Odpoveď sa nepodarila. Skús to prosím znova.', en: 'The answer failed. Please try again.' })[lang] });
  }
}

/** The chat stream: status/trace while working, then exactly one verified answer or error, then `done`. */
export async function* runChat(input: { request: ChatRequest; history: ChatMessage[] }, deps: Deps): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const work = answerQuestion(input, deps, event => { queue.push(event); wake?.(); })
    .finally(() => { finished = true; wake?.(); });
  while (!finished || queue.length) {
    if (queue.length) { yield queue.shift()!; continue; }
    await new Promise<void>(resolve => { wake = resolve; });
    wake = null;
  }
  const result = await work;
  if (result.answer) yield { type: 'answer', text: result.answer.text, links: result.answer.links, verified: true };
  else if (result.error) yield { type: 'error', code: result.error.code, text: result.error.text, ...(result.error.retryAt ? { retryAt: result.error.retryAt } : {}) };
  yield { type: 'done', requestId: input.request.requestId, persisted: false, outcome: result.outcome };
}

export type { RequestBudget };
