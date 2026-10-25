import { stageBudget } from './budget.ts';
import { AllModelsFailed, type LlmDeps, QuotaError, rejectCompletion } from './llm.ts';
import { modelMessages } from './modelPrivacy.ts';
import type { ToolCtx } from './types.ts';

// What a question about one company asks for (Běh 31). A small model classifies the question into these aspects with a
// strict schema; the keyword reading is the fallback and is merged in, so a clear keyword is never lost. The answer leads
// with the asked aspects, searches the web for them and leaves out what nobody asked.

export const ASPECTS = ['business', 'financials', 'valuation', 'scenarios', 'analysts', 'risks', 'moat', 'management', 'dividends',
  'catalysts', 'price_trend', 'industry'] as const;
export type Aspect = typeof ASPECTS[number];
/** The asked aspects (in the order they matter for the answer), the horizon in years and whether a full analysis is asked. */
export type AspectRead = { aspects: Aspect[]; years: number; full: boolean; source: 'model' | 'keywords'; question: string };

const YEAR_WORDS: Record<string, number> = { dva: 2, dvě: 2, dve: 2, two: 2, tři: 3, tri: 3, three: 3, čtyři: 4, štyri: 4, four: 4, pět: 5, päť: 5, five: 5,
  šest: 6, six: 6, sedm: 7, sedem: 7, seven: 7, deset: 10, desať: 10, ten: 10 };
// Keyword stems per aspect (cs/sk/en), matched on the lower-cased question.
const KEYWORDS: Record<Aspect, RegExp> = {
  business: /co dělá|čo robí|čím se (?:zabývá|živí)|čím sa (?:zaoberá|živí)|o čem je|o firmě|o firme|obchodní model|business model|produkt|zákazní|what (?:does|is)|co je (?:to )?za firm/u,
  financials: /tržb|tržie|marž|zisk|ztrát|strat|cash ?flow|dluh|zadluž|hotovost|výsled(?:ky|k) hospodaření|finanční zdrav|ředění|revenue|margin|profit|debt|balance sheet|earnings report/u,
  valuation: /valuac|ocenění|ocenenie|p\/e|p\/s|drah[áéý]|levn[áéý]|nadhodnoc|podhodnoc|férov|valuation|overvalued|undervalued|multiple/u,
  scenarios: /scénář|scenár|scenario|odhad|cenu|cena|cenov|cíl|target|kde (?:\p{L}+ ){0,3}(?:vidíš|bude|budú)|za (?:\d+|pár|několik|niekoľko|\p{L}+) (?:let|rok)|price|forecast|prognóz|předpověď/u,
  analysts: /analyti|analyst|doporučen|odporúčan|rating|konsenz|consensus|wall street/u,
  risks: /rizik|riziká|slabin|slabé|nebezpeč|hrozb|risk|weak|threat|budoucnost|budúcnos|future/u,
  moat: /konkuren|konkurenční výhod|výhod[auy] proti|tržní podíl|moat|competit|market share|edge|silné stránk|strength/u,
  management: /vedení|kdo (?:vede|řídí|riadi)|ceo|management|zakladatel|založil|insid|akcionář|vlastní(?:k|ci)|vlastní vedení|majitel|ownership|shareholder|founder|board/u,
  dividends: /dividend|odkup|buyback|výplat|payout|yield/u,
  catalysts: /katalyzátor|novink|zpráv|chystá|plánuj|oznámen|zakázk|kontrakt|čeká|nejbližší|catalyst|upcoming|announcement|contract|launch|earnings date/u,
  price_trend: /pad[áa]|spadl|klesl|kles[aá]|rost(?:e|ou)|vzrostl|propad|graf|trend|maxim|minim|technick|why (?:is|did) .* (?:up|down)|chart|drop|surge/u,
  industry: /odvětv|odvetv|sektor|trh(?:u|y)? s|průmysl|priemysel|konkurenti|industry|sector|market for/u,
};
const FULL = /analýz|analyz|rozbor|podrobn|detail|všechno|celkov|komplet|full analysis|in depth|deep dive/u;
// What a full analysis covers when nothing narrower is asked.
const FULL_SET: Aspect[] = ['business', 'financials', 'valuation', 'analysts', 'risks', 'moat', 'industry', 'scenarios'];

/** The horizon a question asks ("za 5 let", "in ten years"), else 3. */
export function horizonYears(question: string): number {
  const q = question.normalize('NFC').toLowerCase();
  const n = /(?<![\p{L}\d])(\d{1,2}|dva|dvě|dve|two|tři|tri|three|čtyři|štyri|four|pět|päť|five|šest|six|sedm|sedem|seven|deset|desať|ten)\s+(?:let|roky|rok\p{L}*|years?)(?![\p{L}])/u.exec(q);
  return n ? Math.min(10, Math.max(1, Number(n[1]) || YEAR_WORDS[n[1]] || 3)) : 3;
}

/** The keyword reading of a question's aspects (no model): every aspect whose stems it contains, in canonical order. */
export function keywordAspects(question: string): AspectRead {
  const q = question.normalize('NFC').toLowerCase();
  const full = FULL.test(q);
  let aspects = ASPECTS.filter(a => KEYWORDS[a].test(q));
  if (full) aspects = [...new Set([...aspects, ...FULL_SET])];
  // A bare "co si myslíš o X?" asks for a view: risks and the outlook carry it.
  if (!aspects.length) aspects = ['risks', 'analysts'];
  return { aspects, years: horizonYears(question), full, source: 'keywords', question: q };
}

export const ASPECT_PROMPT = 'Classify an investing question about one company. JSON {"aspects":[],"years":3,"full":false}. aspects: every one the user asks about: '
  + 'business (what it does), financials (revenue, margins, profit, cash, debt), valuation (cheap/expensive, P/E), scenarios (future price, targets), '
  + 'analysts, risks (weaknesses, future), moat (competition, edge), management (CEO, insiders, owners), dividends (also buybacks), '
  + 'catalysts (upcoming news, contracts), price_trend (why it moved, chart), industry. full: a broad analysis. years: horizon asked, else 3.';
export const ASPECT_SCHEMA = { name: 'aspects', strict: true as const, schema: {
  type: 'object', properties: { aspects: { type: 'array', items: { type: 'string', enum: [...ASPECTS] } }, years: { type: 'integer' }, full: { type: 'boolean' } },
  required: ['aspects', 'years', 'full'], additionalProperties: false,
} };
const CLASSIFY_TIMEOUT_MS = 5000;

/**
 * The aspects of a company question: the model's reading (strict schema, the router models, at most 5 s) merged with the
 * keyword reading; the keywords alone when the model is not available or answers out of shape.
 */
export async function classifyAspects(question: string, ctx: ToolCtx, deps: LlmDeps): Promise<AspectRead> {
  const keywords = keywordAspects(question);
  const stage = stageBudget(ctx.budget);
  const now = deps.now ?? Date.now;
  const cap = Math.min(stage.deadline, now() + CLASSIFY_TIMEOUT_MS);
  const budget = { ...stage, deadline: cap, remainingMs: () => Math.max(0, Math.min(stage.remainingMs(), cap - now())) };
  try {
    const project = await modelMessages(ctx);
    const completion = await deps.complete(deps.policy.router, { messages: project([{ role: 'system', content: ASPECT_PROMPT }, { role: 'user', content: question }]),
      tools: [], maxOutput: 400, phase: 'router', jsonSchema: ASPECT_SCHEMA },
    { budget, tokens: deps.tokens, policy: deps.policy, keys: deps.keys, fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep });
    const read = completion.finishReason === 'stop' ? parseAspects(completion.message.content) : null;
    if (!read) { rejectCompletion(deps.tokens, completion, ['route_schema']); return keywords; }
    return mergeAspects(read, keywords);
  } catch (error) {
    if (ctx.budget.signal.aborted) throw ctx.budget.signal.reason ?? error;
    if (!(error instanceof QuotaError || error instanceof AllModelsFailed)) throw error;
    return keywords;
  }
}

/** The model's reading merged with the keywords: every aspect either found, a full analysis's set, the written horizon first. */
export function mergeAspects(read: { aspects: Aspect[]; years: number; full: boolean }, keywords: AspectRead): AspectRead {
  // The keyword fallback for "no aspect" (risks, analysts) is not a finding when the model found something.
  const kw = keywords.aspects.length === 2 && keywords.aspects.every(a => a === 'risks' || a === 'analysts') && read.aspects.length
    && !KEYWORDS.risks.test(keywords.question) && !KEYWORDS.analysts.test(keywords.question) ? [] : keywords.aspects;
  const aspects = [...new Set([...read.aspects, ...kw])].sort((a, b) => ASPECTS.indexOf(a) - ASPECTS.indexOf(b));
  const full = read.full || keywords.full;
  return { aspects: full ? [...new Set([...aspects, ...FULL_SET])] : aspects, full, question: keywords.question,
    // A horizon written in the question wins; the model's only when the question names none.
    years: keywords.years !== 3 || !(read.years >= 1 && read.years <= 10) ? keywords.years : read.years, source: 'model' };
}

/** The model's JSON read strictly: known aspects only, an integer horizon, a boolean. */
export function parseAspects(content: string | null): { aspects: Aspect[]; years: number; full: boolean } | null {
  if (!content) return null;
  try {
    const raw = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as Record<string, unknown>;
    if (!Array.isArray(raw.aspects) || typeof raw.full !== 'boolean' || !Number.isInteger(raw.years)) return null;
    const aspects = raw.aspects.filter((a): a is Aspect => typeof a === 'string' && (ASPECTS as readonly string[]).includes(a));
    return { aspects: [...new Set(aspects)], years: raw.years as number, full: raw.full };
  } catch { return null; }
}
