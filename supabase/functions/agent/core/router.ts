import { stageBudget } from './budget.ts';
import type { Period } from './dataTypes.ts';
import { companyTickersIn } from './companyNames.ts';
import { NOT_TICKERS } from './grounding.ts';
import { AllModelsFailed, type LlmDeps, type LlmMessage, QuotaError, rejectCompletion } from './llm.ts';
import { ROUTER_PROMPT } from './prompts.ts';
import { modelMessages } from './modelPrivacy.ts';
import type { ChatMessage, Lang } from './protocol.ts';
import type { Intent, Route, RouteGroup, ToolCtx } from './types.ts';

// The router model may name the group, tickers and intent; the question's own language and a
// deterministic reading of the question always back it up, so a failed router never stops an answer.

export const ROUTER_TIMEOUT_MS = 6_000;
export const HISTORY_MESSAGES = 4;
const GROUPS: readonly RouteGroup[] = ['portfolio', 'dane', 'trh', 'valuace', 'obecne', 'mimo_temu'];
const ROUTER_SCHEMA = { name: 'route', strict: true as const, schema: {
  type: 'object', properties: { group: { type: 'string', enum: GROUPS }, lang: { type: 'string', enum: ['cs', 'sk', 'en'] },
    tickers: { type: 'array', items: { type: 'string' } }, analysis: { type: 'boolean' }, clarify: { type: 'boolean' } },
  required: ['group', 'lang', 'tickers', 'analysis', 'clarify'], additionalProperties: false,
} };
const TICKER = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,31}$/u;
const PRIVATE_SELECTION = /account|broker|úč(?:et|t\p{L}*)/iu;

/** The last four messages; private selections are omitted, never summarized by a model. */
export function recentHistory(history: readonly ChatMessage[], project: (messages: LlmMessage[]) => LlmMessage[] = messages => messages): LlmMessage[] {
  const messages = [...history].sort((a, b) => a.seq - b.seq).slice(-HISTORY_MESSAGES).map(m => ({ role: m.role,
    // Legacy clarification prose can name accounts since removed from the portfolio.
    content: PRIVATE_SELECTION.test(m.content) ? '[Private selection omitted.]' : m.content }));
  return project(messages).map(m => ({ ...m, content: m.content?.slice(0, 1500) ?? null }));
}

const SK = /[äľĺŕô]|(?<![\p{L}])(sa|som|ako|pri|teraz|kúpiť|predať|koľko|čo|aký|aká|aké|môžem|mám v portfóliu|oplatí|prečo|ešte|ktorý|akcia|dane|portfólio\p{L}*)(?![\p{L}])/giu;
const CS = /[ěřů]|(?<![\p{L}])(teď|koupit|prodat|kolik|co|jaký|jaká|jaké|proč|ještě|který|vyplatí|portfoliu|můžu|mám)(?![\p{L}])/giu;
const EN = /(?<![\p{L}])(the|is|are|what|how|my|worth|should|buy|sell|now|much|do|does|i|it|of|in|why|which)(?![\p{L}])/giu;
/** Language of the question from its own words; null when it does not say. */
export function detectLang(question: string): Lang | null {
  question = question.normalize('NFC');
  const count = (re: RegExp) => (question.match(re) ?? []).length;
  // eslint-disable-next-line no-control-regex -- non-ASCII text cannot be English for this check
  const sk = count(SK), cs = count(CS), en = /[^\x00-\x7f]/.test(question.replace(/[–—’‘“”…]/g, '')) ? 0 : count(EN);
  const best = Math.max(sk, cs, en);
  if (best === 0) return null;
  return sk === best && sk > cs ? 'sk' : cs === best ? 'cs' : en === best ? 'en' : 'sk';
}

/** The text without diacritics: "proc", "neni nic spatne" typed without háčky and čárky read like "proč", "není nic špatně". */
export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
const FOLDED = new WeakMap<RegExp, RegExp>();
/** A keyword pattern matches the question as written or, both without diacritics, its folded form. */
function has(re: RegExp, q: string): boolean {
  if (re.test(q)) return true;
  if (!(re instanceof RegExp)) return false;
  let folded = FOLDED.get(re);
  if (!folded) FOLDED.set(re, folded = new RegExp(fold(re.source), re.flags));
  return folded.test(fold(q));
}
const LAYOUT: Record<string, string> = { 2: 'ě', 3: 'š', 4: 'č', 5: 'ř', 6: 'ž', 7: 'ý', 8: 'á', 9: 'í', 0: 'é' };
/**
 * A question typed with the English layout on a Czech keyboard ("Ykus to ynova t5eba u6 yjist93 co se dnes stalo"): digits
 * inside words are the Czech letters of that key and Y and Z are swapped. Only when two or more words carry such digits.
 */
export function repairLayout(question: string): string {
  // A digit within a word: next to a letter or to another such digit ("yjist93" = "zjistíš").
  const inWord = /(?<=\p{Ll}[02-9]*)[02-9]|[02-9](?=[02-9]*\p{Ll})/gu;
  const words = question.split(/\s+/).filter(w => new RegExp(inWord.source, 'u').test(w));
  if (words.length < 2) return question;
  return question.replace(inWord, d => LAYOUT[d]).replace(/[yzYZ]/g, c => ({ y: 'z', z: 'y', Y: 'Z', Z: 'Y' })[c]!);
}

/** Upper-case symbols written in a text (RKLB, BRK.B); currencies and abbreviations excluded. */
export function tickersIn(text: string): string[] {
  const found = (text.match(/(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{1,5}(?:\.[A-Z])?(?![\p{L}\p{N}])/gu) ?? []).filter(t => !NOT_TICKERS.has(t));
  if (/(?<![\p{L}])bitcoin(?:u|om|em)?(?![\p{L}])/iu.test(text)) found.push('BTC');
  if (/(?<![\p{L}])ethereum(?:u|om|em)?(?![\p{L}])/iu.test(text)) found.push('ETH');
  // Popular company names ("CoreWeave", "Nvidie") are their symbols (Běh 24).
  found.push(...companyTickersIn(text));
  return [...new Set(found)].slice(0, 3);
}

const ANALYSIS = /(koupit|nakoupit|dokoupit|přikoupit|kúpiť|nakúpiť|\bbuy\b|buying|vyplatí|oplatí|worth\s+(?:buying|it)|stojí za|nadhodnocen|podhodnocen|overvalued|undervalued|drahá|levná)/iu;
const GROUP_PATTERNS: [RouteGroup, RegExp][] = [
  ['dane', /(daň|dan[ěíi]|daní|tax|zdan|časov\p{L}* test)/iu],
  ['valuace', /(férov\p{L}*|fair value|ocenění|ocenenie|valuation|P\/E|valuac\p{L}*)/iu],
  ['trh', /(cena|ceny|price|kurz|zpráv\p{L}*|správ\p{L}*|news|analyti\p{L}*|analyst\p{L}*|výsledk\p{L}*|earnings|graf|vývoj)/iu],
  ['portfolio', /(portfoli\p{L}*|portfóli\p{L}*|pozic\p{L}*|držím|holding\p{L}*|dividend\p{L}*|výnos\p{L}*|zisk\p{L}*|ztrát\p{L}*|strat\p{L}*|alokac\p{L}*|vklad\p{L}*|kolik mám|koľko mám|unreali[sz]ed|profits?)/iu],
];
// "What is happening with my stocks / portfolio today": the portfolio's own day, never one named instrument.
const TODAY = /(?<![\p{L}])(?:dnes|dneska|dnešn\p{L}*|dnešk\p{L}*|today'?s?)(?![\p{L}])/iu;
const MOVING = /děj|deje|děl[aá]|robia|ved[eo]|daří|darí|hýb|hyb|pohyb\p{L}*|pohnul\p{L}*|změn\p{L}*|zmen\p{L}*|happen\p{L}*|\bdoing\b|\bgoing\b|\bmov(?:e|es|ed|ing|ers)\b|\bchang\p{L}*|\bperform\p{L}*|\bup or down\b/iu;
const OWN_STOCKS = /akci\p{L}*|portf[oó]li\p{L}*|pozic\p{L}*|pozíci\p{L}*|investic\p{L}*|\bstocks\b|\bshares\b|\bholdings\b|\bpositions\b|\bportfolio\b|\binvestments\b/iu;
const MOVERS = { test: (q: string) => has(TODAY, q) && has(MOVING, q) && has(OWN_STOCKS, q) } as unknown as RegExp;
// Why a named instrument moved over recent days (cs/sk/en): "Co se děje poslední dny s NBIS?", "Proč NBIS spadla?",
// "Prečo SYNN tento týždeň klesá?", "Why is NBIS down?", "What's going on with NBIS this week?".
const WHY = /(?<![\p{L}])(?:proč|prečo|why)(?![\p{L}])/iu;
const MOVE_VERB = /(?<![\p{L}])(?:spadl\p{L}*|pad[aá]\p{L}*|padl\p{L}*|klesl\p{L}*|kles[aá]\p{L}*|rost\p{L}*|roste|vzrostl\p{L}*|vyletěl\p{L}*|vyletel\p{L}*|letí|stoupl\p{L}*|stoup[aá]\p{L}*|stúp\p{L}*|propad\p{L}*|prepad\p{L}*|posíl\p{L}*|oslab\p{L}*|rast\p{L}*|rástl\p{L}*|zlevn\p{L}*|zdraž\p{L}*|down|up|fall\p{L}*|fell|drop\p{L}*|plung\p{L}*|crash\p{L}*|soar\p{L}*|surg\p{L}*|jump\p{L}*|rall\p{L}*|tank\p{L}*|sink\p{L}*|sank|rise|rises|rising|rose|climb\p{L}*|slid\p{L}*|slump\p{L}*|lose|loses|losing|lost)(?![\p{L}])/iu;
const GOING_ON = /co\s+se\s+(?:[\p{L}\p{N}.]+\s+){0,3}?(?:děje|deje|stalo)|co\s+je\s+(?:s|se)\s|čo\s+sa\s+(?:[\p{L}\p{N}.]+\s+){0,3}?(?:deje|stalo)|čo\s+je\s+s\s|what'?s\s+(?:going\s+on|happening|up|wrong)\s+with|what\s+is\s+(?:going\s+on|happening|up|wrong)\s+with|what\s+happened\s+(?:to|with)|jak\s+(?:si\s+)?(?:ved\p{L}*|vede)|jak\s+se\s+(?:\p{L}+\s+)?da[řr]\p{L}*|ako\s+sa\s+dar\p{L}*|how\s+(?:has|did|is)\s+\S+\s+(?:done|doing|perform\p{L}*)/iu;
const PERIOD = /(?<![\p{L}])(?:posledn\p{L}*|minul\p{L}*|uplynul\p{L}*|tento|tenhle|tomto|tomhle|this|last|past|recent|previous|few|couple(?:\s+of)?|za|over\s+the|in\s+the)\s+(?:(?:pár|par|několik|niekoľko|several|few|\d{1,2}|dva|dvě|dve|two|tři|tri|three|čtyři|štyri|four|pět|päť|five|šest|šesť|six)\s+)?(?:dn(?:y|í|ech|ů|i)|dní|dňoch|týd(?:en|ny|nů|nu|ne|nech)|týž?d\p{L}*|měsíc\p{L}*|mesiac\p{L}*|days?|weeks?|months?)(?![\p{L}])/iu;
/** "What is happening with NBIS today?": today's quote, with the last days added briefly. */
export const isTodayMoveQuestion = (q: string) => has(TODAY, q) && !has(PERIOD, q) && !(has(WHY, q) && has(MOVE_VERB, q)) && (has(GOING_ON, q) || has(MOVING, q));
/** A recent-move question about a named instrument (the ticker itself is checked by the caller). */
// "Co se dnes stalo s NU?" asks what happened (the news behind today's move), not only for the quote (owner, 2026-10-26):
// a today question with "what is happening / what happened" is a move question too; "Jak se dnes hýbe NU?" stays a quote.
export const isMoveQuestion = (q: string) => (has(WHY, q) && has(MOVE_VERB, q)) || has(GOING_ON, q) || (has(PERIOD, q) && (has(MOVE_VERB, q) || has(MOVING, q)));
const MOVE = { test: isMoveQuestion } as unknown as RegExp;
/**
 * "Proč je dneska takový propad na NU? … Udělej podrobnou analýzu": why the price moved, asked outright. It is explained
 * from the news of the move even when an analysis or the company is mentioned too — the move is what is asked.
 */
export const isWhyMoveQuestion = (q: string) => (has(WHY, q) && has(MOVE_VERB, q)) || has(HAPPENED, q);
// "Zkus znova zjistit, co se s NU stalo, analyzuj": what happened is asked, whatever else the question adds.
const HAPPENED = /co\s+se\s+(?:[\p{L}\p{N}.]+\s+){0,3}?stalo|čo\s+sa\s+(?:[\p{L}\p{N}.]+\s+){0,3}?stalo|what\s+happened/iu;
/** The question is about today's move ("dnes", "dneska", "today"), with no other period named. */
export const isTodayQuestion = (q: string) => has(TODAY, q) && !has(PERIOD, q);
// How a named company is doing and why it is valued as it is (Běh 26): "Jak hodnotíš, jak se daří SPCX? V čem je jejich
// síla, proč mají tak obrovskou valuaci?", "Co si myslíš o NBIS?", "How is RKLB doing?". Answered from the articles like a move.
// A judgement asked for ("není s ní nic špatně", "je to furt skvělá firma", "jen nejistota") counts too.
const COMPANY = /(?<![\p{L}])(?:nic\s+špatn\p{L}*|skvěl\p{L}*|nejistot\p{L}*|hodnotíš|hodnotis|hodnotíte|vidíš|vidíte|myslíš|myslíte|myslis|říkáš|říkáte|názor\p{L}*|daří|darí|dari|síl[aeuy]|siln\p{L}*|slab\p{L}*\s+strán\p{L}*|valuac\p{L}*|ocenění|ocenenie|tržní\s+hodnot\p{L}*|výhled\p{L}*|vyhliadk\p{L}*|perspektiv\p{L}*|budoucnost\p{L}*|budúcnos\p{L}*|obchodní\s+model\p{L}*|podnikání|opinion|outlook|strengths?|weakness\p{L}*|valuation|valued|prospects?)(?![\p{L}])|think\s+(?:of|about)|business\s+model|how\s+(?:is|are|has)\s+\S+\s+(?:doing|performing)/iu;
// A fair-value or ratio question keeps the valuation tools; a buy question the buy analysis.
const VALUATION_TOOLS = /férov\p{L}*|fair\s+value|vnitřní\s+hodnot\p{L}*|intrinsic|(?<![\p{L}])(?:P\/E|P\/S|EV\/EBITDA|DCF)(?![\p{L}])/iu;
export const isCompanyQuestion = (q: string) => has(COMPANY, q) && !has(VALUATION_TOOLS, q) && !has(ANALYSIS, q);
// Where a company and its price may be in a few years (Běh 27): "Jak vidíš vývoj META do budoucna, kde bude cena za 3 roky?",
// "Kde vidíš cenu akcie za tři roky?", "Where will NVDA be in 5 years?", "price target". Analysts, valuation and scenarios.
const OUTLOOK = /(?<![\p{L}])(?:do\s+budoucna|budoucnost\p{L}*|budúcnos\p{L}*|do\s+budúcna|výhled\p{L}*|vyhliadk\p{L}*|prognóz\p{L}*|predikc\p{L}*|předpově\p{L}*|predpove\p{L}*|cílov\p{L}*\s+cen\p{L}*|cieľov\p{L}*\s+cen\p{L}*|dlouhodob\p{L}*|dlhodob\p{L}*|forecast\p{L}*|outlook|long[\s-]term|price\s+targets?|future)(?![\p{L}])|(?:za|o|in)\s+(?:\d{1,2}|dva|dvě|dve|tři|tri|čtyři|štyri|pět|päť|deset|desať|two|three|four|five|ten|pár|par|několik|niekoľko|a\s+few|several)\s+(?:let|rok\p{L}*|years?)(?![\p{L}])|kde\s+(?:\p{L}+\s+){0,3}(?:vidíš|vidíte|bude|budú|skončí)/iu;
export const isOutlookQuestion = (q: string) => (has(OUTLOOK, q) || has(ANALYSIS_REQUEST, q)) && !has(VALUATION_TOOLS, q) && !has(ANALYSIS, q);
// An analysis of a company is asked for (Běh 30): "udělej mi analýzu HIMS", "silné a slabé stránky", "co si myslí analytici".
const ANALYSIS_REQUEST = /(?<![\p{L}])(?:analýz\p{L}*|analyz\p{L}*|rozbor\p{L}*|silné\s+(?:a\s+slabé\s+)?stránk\p{L}*|slabé\s+stránk\p{L}*|silné\s+stránk\p{L}*|co\s+si\s+myslí\s+analytici|analysis|strengths\s+and\s+weaknesses)(?![\p{L}])/iu;
// Capitalised words that start questions or are common, never a company name.
const NOT_NAMES = new Set(['Co', 'Čo', 'Jak', 'Ako', 'Jaká', 'Jaký', 'Jaké', 'Aká', 'Aký', 'Aké', 'Má', 'Kde', 'Proč', 'Prečo', 'Kdy', 'Kolik', 'Koľko', 'Udělej', 'Urob',
  'Řekni', 'Povedz', 'Vyplatí', 'Oplatí', 'Myslíš', 'Je', 'Jsou', 'Sú', 'A', 'I', 'V', 'Ve', 'Na', 'Za', 'What', 'How', 'Where', 'Why', 'Is', 'Does', 'Do', 'The', 'Tell',
  'Give', 'Dej', 'Daj', 'Ptám', 'Pýtam', 'Chci', 'Chcem', 'Moje', 'Můj', 'Wall', 'Street', 'AI', 'USA', 'EU', 'ČR', 'S&P']);
/** A company written by its name ("Intuitive Machines", "Rheinmetall"): its capitalised words, for the provider's symbol search. */
export function companyNameIn(question: string): string | null {
  for (const m of question.normalize('NFC').matchAll(/(?<![\p{L}\p{N}])(\p{Lu}[\p{L}&.'-]+(?:\s+\p{Lu}[\p{L}&.'-]+){0,2})(?![\p{L}\p{N}])/gu)) {
    const words = m[1].split(/\s+/).filter(w => !NOT_NAMES.has(w));
    const name = words.join(' ');
    if (words.length && name.length >= 4 && !/^[A-Z0-9.]{1,6}$/.test(name)) return name.slice(0, 40);
  }
  return null;
}
const QUOTE_TODAY = { test: isTodayMoveQuestion } as unknown as RegExp;
const FIRST_PERSON = /(?<![\p{L}])(?:jsem|jsi|jsme|som|sme|i|i've|i'm|we)(?![\p{L}'])/iu;
// The keyword router (cs/sk/en): the question's intent when no router model answers. Order matters —
// a buy question naming a price is a buy analysis, a tax question about dividends is a tax question.
// `quote` and `buy` need a ticker in the question itself.
const INTENTS: [Intent, RegExp, boolean][] = [
  ['buy', ANALYSIS, true],
  ['tax', /(?<![\p{L}])(daň\p{L}*|dan[ěií]\p{L}*|dane|daní|zdan\p{L}*|tax\p{L}*)(?![\p{L}])/iu, false],
  ['transactions', /(?<![\p{L}])(transakc\p{L}*|obchod(y|ů|ech)|(na|při|do|pro)?koupil\p{L}*|(na|do|vy)?prodal\p{L}*|(na|do)?kúpil\p{L}*|(od)?predal\p{L}*|bought|sold|trades?|transactions?)(?![\p{L}])|\bbuy\b.*\bsell\b|\bdid i (buy|sell)\b/iu, false],
  ['dividends', /dividend/iu, false],
  ['move_explanation', MOVE, true],
  ['quote', QUOTE_TODAY, true],
  ['allocation', /alok[áa]c\p{L}*|allocation|rozložen\p{L}*|sektor\p{L}*|sector\p{L}*/iu, false],
  ['movers', MOVERS, false],
  ['performance', /výkonnos\p{L}*|výnos\p{L}*|\bperform(?:ance|ed)?\b|\breturns?\b/iu, false],
  ['holdings', /držím|\bholdings\b|\b(?:do i|am i) hold(?:ing)?\b/iu, false],
  ['summary', /(?:kolik|koľko)\s+mám\s+v\s+portf[oó]li\p{L}*|(?:hodnot\p{L}*|value|worth).*portf[oó]li\p{L}*|portf[oó]li\p{L}*.*(?:hodnot\p{L}*|value|worth)/iu, false],
  ['quote', /(?<![\p{L}])(cena|ceny|cenu|ceně|price|prices|quote|kurz|stojí|worth)(?![\p{L}])/iu, true],
];
// A refusal of an action is not a request for that action. Negative factual questions
// ("did I not sell", "not exempt yet") still ask for the same evidence.
const REJECTED_INTENT = /(?:nechci|nechcem|nechceme|nesimuluj|nepočítej|nepočítaj|nekupuj|neukazuj|do not (?:simulate|buy|sell|want|show)|don't (?:simulate|buy|sell|want|show))\b/iu;
export function requestedText(question: string): string {
  // Keep a rejected subordinate question with its parent, but allow a new explicit request.
  return question.split(/[.](?!\d)|[;!?]|\b(?:ale|but)\b|,(?!\d)(?=\s*(?:ukaž|ukáž|chci|chcem|show|tell|what|how|jak|ak))/iu)
    .filter(part => !REJECTED_INTENT.test(part)).join(' ');
}
const SALE = /(?<![\p{L}])(?:proda\p{L}*|prodej\p{L}*|preda\p{L}*|sell|sold|sale)(?![\p{L}])/iu;
/** The intent of a question by keywords alone; undefined when none fits. */
export function keywordIntent(question: string): Intent | undefined {
  question = requestedText(question.normalize('NFC'));
  // A company named by its name outside the built-in map ("Intuitive Machines") counts for company and outlook questions (Běh 30).
  const hasTicker = tickersIn(question).length > 0 || (!!companyNameIn(question) && (isCompanyQuestion(question) || isOutlookQuestion(question)));
  if (has(SALE, question) && /kdyby|keby|\bby(ch|chom)?\b|\b(if|would|simulate|simulation|hypothetical)\b|simul\p{L}*|(?:při|pri)\s+(?:prodeji|predaji)|(?:chci|chcem|want to)\s+(?:prodat|predať|sell)/iu.test(question)) {
    return /úč(?:et|t\p{L}*)|account/iu.test(question) && !/\d+\s*(kus|akci|share)/iu.test(question) ? 'account_clarification' : 'simulation';
  }
  if (/časov\p{L}*\s+test|time[ -]test|holding period|(?<![\p{L}])lot(?:s|y|ů|ov)?(?![\p{L}])|tax.exempt/iu.test(question)) return 'lots';
  if (/(?<![\p{L}])(?:realizov\p{L}*|reali[sz]e(?:d)?)(?![\p{L}])/iu.test(question)) return 'realized';
  // "Why did NBIS lose so much this week?" asks about the instrument; "Kolik jsem prodělal na SYNA?" about own results.
  if (/(?<![\p{L}])(?:(?:ne)?prodělal\p{L}*|(?:ne)?prerobil\p{L}*|lose|lost)(?![\p{L}])/iu.test(question)) {
    return hasTicker && isMoveQuestion(question) && !FIRST_PERSON.test(question) ? 'move_explanation' : 'realized';
  }
  if (/(?<![\p{L}])(?:neprodal\p{L}*|nepredal\p{L}*)(?![\p{L}])|\bdid i not (?:buy|sell)\b/iu.test(question)) return 'transactions';
  let found = INTENTS.find(([, re, needsTicker]) => has(re, question) && (!needsTicker || hasTicker))?.[0];
  // "Výhled pro polovodičový sektor" asks about an industry, not the own allocation (Běh 27): that needs own words.
  if (found === 'allocation' && !PERSONAL.test(question) && !/portf[oó]li|portfolio|alok[áa]c|allocation|rozložen|rozlož/iu.test(question)) found = undefined;
  // "Vyplácí KO dividendu?" asks about the company, not the dividends the user received (Běh 31): a named company, no own words.
  if (found === 'dividends' && tickersIn(question).length && !PERSONAL.test(question) && !/(?<![\p{L}])(?:přišl\p{L}*|prišl\p{L}*|dostal\p{L}*|obdržel\p{L}*|received|got)(?![\p{L}])/iu.test(question)) return 'move_explanation';
  // A company question about a named instrument: the article analysis, unless it asks about own data or another intent.
  if (hasTicker && (!found || found === 'quote' || found === 'move_explanation') && (isCompanyQuestion(question) || isOutlookQuestion(question))
    && !PERSONAL.test(question)) return 'move_explanation';
  // A follow-up outlook about "the company" or "its stock" without a symbol ("kde metu vidíš za 3 roky, kde vidíš cenu
  // akcie?"): the outlook of the instrument the conversation is about (the route inherits it).
  // So is a follow-up judgement of it ("Takže s akcií není nic špatně, jde jen o nejistotu, byznys je furt skvělej?").
  if (!hasTicker && (!found || found === 'quote') && (isOutlookQuestion(question) || isCompanyQuestion(question)) && has(FOLLOW_UP_COMPANY, question)
    && !PERSONAL.test(question)) return 'move_explanation';
  return found;
}
const FOLLOW_UP_COMPANY = /(?<![\p{L}])(?:firm\p{L}*|společnost\p{L}*|spoločnos\p{L}*|akci[ei]|akcií|byzn\p{L}*|biznis\p{L}*|jejich|její|jeho|company|stock|business|its|their)(?![\p{L}])/iu;
const INTENT_GROUP: Record<Intent, RouteGroup> = { move_explanation: 'trh', movers: 'portfolio', transactions: 'portfolio', realized: 'dane', simulation: 'dane', lots: 'dane', account_clarification: 'dane',
  tax: 'dane', dividends: 'portfolio', quote: 'trh', buy: 'valuace', performance: 'portfolio', allocation: 'portfolio', holdings: 'portfolio', summary: 'portfolio' };

// A question about the user's own data (possessives, "I have", cash, "of that"): answered from selected facts only,
// never with free explanatory prose around personal numbers.
// Also typed without diacritics ("muj", "mam"); never folded as a whole ("mé" would become the English "me").
const PERSONAL = /(?<![\p{L}])(?:můj|muj|mam|mych|mym|mymi|moje|mojí|mého|mému|mých|mým|mými|mou|mé|mám|máš|jsem|môj|moja|moju|mojej|môjho|môjmu|mojom|mojich|mojim|mojimi|mojou|som|my|mine|i (?:have|hold|own|bought|sold)|i'm|i've|z toho|of (?:it|that)|hotovos[tť]\p{L}*|cash)(?![\p{L}])/iu;
export const isPersonalQuestion = (question: string) => PERSONAL.test(question);

// Finance vocabulary beyond the keyword intents: concepts, instruments, markets and crypto (cs/sk/en stems).
const FINANCE_WORDS = /(?<![\p{L}])(?:akci\p{L}*|burz\p{L}*|trh(?:u|y|ů|och|ov|em)?|market\p{L}*|invest\p{L}*|etf\p{L}*|fond\p{L}*|funds?|krypt\p{L}*|crypto\p{L}*|bitcoin\p{L}*|ethereum\p{L}*|stak\p{L}*|blockchain\p{L}*|coin\p{L}*|token\p{L}*|dluhopis\p{L}*|obligáci\p{L}*|bonds?|index\p{L}*|nasdaq|dow jones|broker\p{L}*|úrok\p{L}*|interest rates?|inflac\p{L}*|inflation|recese|recesi\p{L}*|recession|spoř\p{L}*|sporen\p{L}*|savings?|finan\p{L}*|stocks?|shares|equit\p{L}*|trading|trader\p{L}*|kapitál\p{L}*|capital|diverzifik\p{L}*|diversif\p{L}*|dollar cost|hodl|wallet\p{L}*|peněžen\p{L}*|forex|gold|komodit\p{L}*|commodit\p{L}*|reit\p{L}*|ipo|opc[ei]\p{L}*|options|futures|hedg\p{L}*|volatil\p{L}*|rizik\p{L}*|risk\p{L}*|výnos\p{L}*|yield\p{L}*|dividend\p{L}*|portf[oó]li\p{L}*)(?![\p{L}])|s&p/iu;
/**
 * True when a question speaks about money, investing, markets or crypto: the keyword router's own lexicon (intents and
 * groups; price/news/buy words only with an instrument named), a known ticker or crypto name, or finance vocabulary.
 * Such a question is never answered with the off-topic text, whatever the router model says.
 */
export function isFinanceQuestion(question: string): boolean {
  if (tickersIn(question).length > 0 || has(FINANCE_WORDS, question) || keywordIntent(question)) return true;
  const text = requestedText(question) || question;
  return GROUP_PATTERNS.some(([group, re]) => group !== 'trh' && re.test(text))
    || INTENTS.some(([intent, re, needsTicker]) => intent !== 'buy' && !needsTicker && has(re, text));
}

function yearPeriod(today: string, question: string): Period {
  const year = Number(today.slice(0, 4));
  const named = /(?<!\d)(19[9]\d|20\d\d)(?!\d)/.exec(question);
  const y = named ? Number(named[1]) : /(loni|vlani|last year|minulý rok|minulého roku)/i.test(question) ? year - 1 : year;
  return { from: `${y}-01-01`, to: y >= year ? today : `${y}-12-31` };
}

/** A route read from the question alone: used when no router model answers in time. */
export function heuristicRoute(question: string, history: readonly ChatMessage[], ctx: ToolCtx, lang: Lang): Route {
  const intent = keywordIntent(question);
  let tickers = tickersIn(requestedText(question));
  // A company named by its name: the name itself goes to the ticker resolution (provider symbol search, Běh 30).
  const named = !tickers.length && (isCompanyQuestion(question) || isOutlookQuestion(question)) ? companyNameIn(question) : null;
  if (named) tickers = [named];
  if (!tickers.length && (!intent || intent === 'move_explanation' || /(?<![\p{L}])(?:ji|ho|jej|jich|nich|it|them|those)(?![\p{L}])/iu.test(question))) tickers = inheritedTickers(history);
  const analysis = intent === 'buy' || (!intent && (ANALYSIS.test(requestedText(question)) || (tickers.length > 0 && /(rizik|riziká|risk)/iu.test(question) && !tickersIn(question).length)));
  // "How much is my portfolio worth?" names no instrument: a buy word without a ticker is not an analysis.
  const group = analysis && tickers.length ? 'valuace' : intent ? INTENT_GROUP[intent] : GROUP_PATTERNS.find(([, re]) => re.test(requestedText(question)))?.[0] ?? (tickers.length ? 'trh' : 'obecne');
  return { group, lang, tickers, period: yearPeriod(ctx.today, question), needsClarification: false, analysis: analysis && tickers.length > 0,
    ...(intent ? { intent } : {}) };
}
/** Tickers of the most recent user turn that named any: "a co rizika?" continues the last analysis. */
function inheritedTickers(history: readonly ChatMessage[]): string[] {
  for (const m of [...history].sort((a, b) => b.seq - a.seq)) if (m.role === 'user' && !PRIVATE_SELECTION.test(m.content)) { const t = tickersIn(m.content); if (t.length) return t; }
  return [];
}

function parseRoute(content: string | null): Partial<{ group: RouteGroup; lang: Lang; tickers: string[]; analysis: boolean; clarify: boolean }> | null {
  if (!content) return null;
  const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      group: GROUPS.includes(raw.group as RouteGroup) ? raw.group as RouteGroup : undefined,
      lang: ['cs', 'sk', 'en'].includes(raw.lang as string) ? raw.lang as Lang : undefined,
      tickers: Array.isArray(raw.tickers) ? raw.tickers.filter((t): t is string => typeof t === 'string' && TICKER.test(t.trim())).map(t => t.trim()).slice(0, 3) : [],
      analysis: raw.analysis === true, clarify: raw.clarify === true,
    };
  } catch { return null; }
}

/**
 * Routes a question with the small router model (≤ 6 s, own token reservation), validated and
 * merged with the deterministic reading. The question's language wins over the model's guess.
 */
export async function routeQuestion(question: string, history: ChatMessage[], ctx: ToolCtx, deps: LlmDeps): Promise<Route> {
  // Decomposed accents (NFD) would hide every keyword intent from the deterministic reading.
  question = question.normalize('NFC');
  const detected = detectLang(question);
  const project = await modelMessages(ctx);
  const safeQuestion = project([{ role: 'user', content: question }])[0].content ?? '';
  const fallback = heuristicRoute(safeQuestion, history, ctx, detected ?? ctx.lang);
  const stage = stageBudget(ctx.budget);
  const now = deps.now ?? Date.now;
  const cap = Math.min(stage.deadline, now() + ROUTER_TIMEOUT_MS);
  const budget = { ...stage, deadline: cap, remainingMs: () => Math.max(0, Math.min(stage.remainingMs(), cap - now())) };
  let parsed: ReturnType<typeof parseRoute> = null;
  try {
    // Four stored messages, the strict schema and the described groups may need a full call; leave 5,000 for tools/writing.
    const completion = await deps.complete(deps.policy.router, {
      messages: project([{ role: 'system', content: ROUTER_PROMPT }, ...recentHistory(history, project), { role: 'user', content: question }]), tools: [], maxOutput: 700,
      keepTokens: 5000, phase: 'router', jsonSchema: ROUTER_SCHEMA,
    }, { budget, tokens: deps.tokens, policy: deps.policy, keys: deps.keys, fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep });
    parsed = completion.finishReason === 'stop' ? parseRoute(completion.message.content) : null;
    if (!parsed?.group) rejectCompletion(deps.tokens, completion,
      [completion.finishReason === 'length' ? 'truncated' : completion.finishReason !== 'stop' ? 'finish_reason' : 'route_schema']);
  } catch (error) {
    if (ctx.budget.signal.aborted) throw ctx.budget.signal.reason ?? error;
    if (!(error instanceof QuotaError || error instanceof AllModelsFailed)) throw error;
  }
  if (!parsed?.group) return fallback;
  // Explicit intents bind both evidence and answer content; a model classification cannot erase them.
  if (fallback.intent || REJECTED_INTENT.test(safeQuestion) || /nerealizov\p{L}*|unreali[sz]ed/iu.test(safeQuestion)) return fallback;
  // Production fix: the off-topic answer is only for clearly non-financial questions. A finance word, a ticker or a crypto
  // name overrides the model's mimo_temu with the keyword router's group (obecne when no keyword decides).
  if (parsed.group === 'mimo_temu' && isFinanceQuestion(safeQuestion)) parsed.group = fallback.group;
  const tickers = parsed.tickers?.length ? parsed.tickers : fallback.tickers;
  const analysis = (parsed.analysis || fallback.analysis) && tickers.length > 0;
  const group = analysis ? 'valuace' : parsed.group;
  // The keyword intent stays only where the router agrees on the group.
  const intent = fallback.intent && INTENT_GROUP[fallback.intent] === group ? fallback.intent : undefined;
  return { group, lang: detected ?? parsed.lang ?? ctx.lang, tickers, period: fallback.period,
    needsClarification: !!parsed.clarify && !tickers.length, analysis, ...(intent ? { intent } : {}) };
}
