import type { ResearchKind } from './marketTypes.ts';
// Article text for news analysis (Běh 23): third-party pages become short, clean, relevant excerpts. Nothing here
// trusts the text: markup, links, images, boilerplate and instruction-like sentences are removed, double quotes become
// single ones (so a quoted extract can never close the answer's own quotation), and only paragraphs about the
// instrument, its company or its peers are kept. Pure functions: the live source, the fixture and the renderer share them.

// Excerpt kept per article; quoted fallback extract; the analyst's passages per article (Běh 23b).
export const EXCERPT_MAX = 1200, EXTRACT_MAX = 320, ANALYST_PASSAGE_MAX = 700;

const ENTITIES: Record<string, string> = { amp: '&', quot: '\'', apos: '\'', nbsp: ' ', lt: ' ', gt: ' ', rsquo: '\'', lsquo: '\'', ldquo: '\'',
  rdquo: '\'', mdash: '—', ndash: '–', hellip: '…' };
// Lines that are page furniture, not reporting.
const BOILERPLATE = /^(?:advertisement|scroll to continue|sign up|subscribe|read more|related(?: articles| coverage)?|share this|follow us|click here|watch(?: the full| now)|all rights reserved|©|copyright|cookies?|image|photo|getty images|reporting by|editing by|writing by|about (?:the )?[A-Z]|for more information|disclaimer|this article|recommended|trending|most read|newsletter|i wrote this article|i am not receiving|i have no (?:stock|business)|(?:the )?analyst'?s? disclosure|seeking alpha'?s disclosure|such investors are advised|past performance is no guarantee|you are being directed|find winning stocks|join \d[\d,.]* million investors|intraday chart)/i;
const INSTRUCTION = /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|messages?|rules)|system\s*prompt|hidden\s+prompt|developer\s+(?:message|mode)|reveal\s+(?:your|the)\s+(?:prompt|instructions)|tell\s+(?:every|all|the)\s+(?:users?|readers?)\b|you\s+are\s+now\b|as\s+an\s+ai\b|jailbreak|\bSYSTEM:|ignoruj\p{L}*\s+(?:předchozí|predchádzajúce|všechny|všetky)/iu;
const TECHNICAL = /\b[a-z][A-Za-z_]*:[A-Za-z0-9_.#-]+|\b[A-Za-z]+_[A-Za-z0-9_]+\b|\b[a-z0-9-]+\.(?:com|cz|sk|org|net|io|example|co|ai)\b/;
const ABBREVIATION = /(?:\b(?:[A-Z]\.){1,3}|\b(?:Inc|Corp|Co|Ltd|Mr|Mrs|Ms|Dr|St|vs|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|approx|est)\.)$/;
const DRIVER = /(capex|spending|hyperscaler|data[- ]?cent(?:er|re)s?|demand|short[- ]?sell\p{L}*|short report|convertible|notes|debt|borrow\p{L}*|dilut\p{L}*|downgrad\p{L}*|upgrad\p{L}*|price target|guidance|forecast|outlook|revenue|earnings|customers?|contracts?|valuations?|sell-?off|slid\p{L}*|slide|fell|drop\p{L}*|plung\p{L}*|tumbl\p{L}*|rose|rall\p{L}*|jump\p{L}*|surg\p{L}*|warn\p{L}*|lawsuit|probe|investigation)/giu;
// Wire datelines in front of the first sentence ("Oct 21 (Reuters) - ", "AMSTERDAM--(BUSINESS WIRE)--").
const DATELINE = /^(?:(?:[A-Z][A-Za-z.]*\s){0,3}\d{1,2}\s)?\((?:Reuters|AP|AFP|Bloomberg|Dow Jones)\)\s*[-–—]+\s*|^[A-Z][A-Za-z0-9 .,'-]{1,60}--\((?:BUSINESS WIRE|GLOBE NEWSWIRE|PR ?NEWSWIRE|ACCESSWIRE)\)--\s*/;
// Page furniture that sticks to a paragraph: comment counters, image captions, "in this article" ticker strips.
const FURNITURE = /view all comments|\bimage \d+:|\bin this article:|\(\d+\)\d+\b|[A-Z]{2,5}[+-]\d+(?:\.\d+)?%/i;
const NAME_SUFFIX = /\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|n\.?\s?v|s\.?\s?a|a\.?\s?g|se|ag|group|holdings?|technologies|class [a-c])\.?$/i;

// Company-profile boilerplate ("X, a technology company, engages in …", "headquartered in", "founded in"): what a
// company is, not what happened (Běh 24). Dropped unless the sentence also reports news.
const PROFILE = /(?:\bis\s+an?\s+|,\s*an?\s+)(?:[\p{L}-]+\s+){0,4}(?:company|corporation|provider|firm|developer|operator|manufacturer|maker|business)\b|\bengages?\s+in\b|\bheadquartered\s+in\b|\b(?:was\s+)?(?:founded|incorporated|established)\s+in\b|\boperates\s+as\b|\bthe\s+company\s+(?:offers|provides|operates)\b|\b(?:provides|offers)\s+(?:[\p{L}-]+,?\s+){0,6}(?:services|solutions|products|platforms?|infrastructure|tools)\b/iu;
// What news reports: a move, a statement, an event or a time reference.
const NEWS_VERB = /\b(?:fell|falls?|falling|rose|rises?|rising|jump\p{L}*|surg\p{L}*|soar\p{L}*|slid\p{L}*|slides?|slump\p{L}*|plung\p{L}*|tumbl\p{L}*|sank|sinks?|rall\p{L}*|drop\p{L}*|gain\p{L}*|los(?:e|es|ing|t)|climb\p{L}*|said|says|told|announc\p{L}*|report\p{L}*|reveal\p{L}*|warn\p{L}*|sign\p{L}*|launch\p{L}*|agree\p{L}*|rais\p{L}*|cut|cuts|downgrad\p{L}*|upgrad\p{L}*|beat|miss\p{L}*|price target|short sell\p{L}*|today|yesterday|this week|last week|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/iu;
/** True for a sentence that only says what a company is (profile boilerplate), not what happened. */
export const isProfileSentence = (sentence: string): boolean => PROFILE.test(sentence) && !NEWS_VERB.test(sentence);
/** Quote, chart and profile pages (prices and boilerplate, no reporting): never read as articles. */
export function isQuotePage(url: string): boolean {
  let path: string;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return false; }
  return /\/(?:quotes?|symbol|chart|charts|profile|key-statistics|financials|holders|stock-price|market-data)(?:\/|$)/.test(path)
    || /^\/investing\/stock\/[a-z.]{1,6}\/?$/.test(path) || /^\/stocks?\/[a-z.]{1,6}\/?$/.test(path);
}

/** True when a text tries to give instructions (prompt injection) instead of reporting. */
export const looksLikeInstruction = (text: string): boolean => INSTRUCTION.test(text);

/** Words that identify the company of a ticker: the ticker, the full name and its core ("Nebius Group N.V." → "Nebius Group", "Nebius"). */
export function nameKeywords(ticker: string, name: string | null | undefined, related: readonly string[] = []): string[] {
  const words = [ticker];
  let core = (name ?? '').replace(/[^\p{L}\p{N} .&'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (core) words.push(core);
  for (let i = 0; i < 3 && NAME_SUFFIX.test(core); i++) core = core.replace(NAME_SUFFIX, '').replace(/[\s,.]+$/, '').trim();
  if (core && core.length >= 3) words.push(core);
  const first = core.split(' ')[0];
  if (first && first.length >= 4 && first !== core) words.push(first);
  return [...new Set([...words, ...related].filter(w => w && w.length >= 2))];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One compiled pattern per keyword list (tickers match case-sensitively, names in any case); bounded cache.
const patterns = new Map<string, RegExp[]>();
function keywordPatterns(keywords: readonly string[]): RegExp[] {
  const key = keywords.join('\u0001');
  let found = patterns.get(key);
  if (!found) {
    if (patterns.size >= 200) patterns.clear();
    found = keywords.map(k => new RegExp(`(?<![\\p{L}\\p{N}])${escape(k)}(?![\\p{L}\\p{N}])`, /^[A-Z0-9.]+$/.test(k) ? 'gu' : 'giu'));
    patterns.set(key, found);
  }
  return found;
}
function mentions(text: string, keywords: readonly string[]): number {
  let n = 0;
  for (const re of keywordPatterns(keywords)) { re.lastIndex = 0; n += (text.match(re) ?? []).length; }
  return n;
}

/** Sentences of a cleaned text; common abbreviations ("N.V.", "Inc.", "Oct.") do not end a sentence. */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?…]+['’)]?\s+(?=[\p{Lu}\p{N}'(])/gu)) {
    const end = m.index! + m[0].trimEnd().length;
    if (ABBREVIATION.test(text.slice(start, end))) continue;
    out.push(text.slice(start, end).trim());
    start = m.index! + m[0].length;
  }
  if (start < text.length && text.slice(start).trim()) out.push(text.slice(start).trim());
  return out;
}

/**
 * Paragraphs of an article as plain text: no HTML, markdown, images, links, URLs or page furniture; double quotes made
 * single; sentences that try to instruct or carry technical text dropped. The raw page is never kept.
 */
/** `keepProfile`: a company research page on the business keeps the sentences that say what the company is (Běh 27). */
export function cleanArticleText(raw: string | null | undefined, keepProfile = false): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const text = raw.slice(0, 400_000)
    .replace(/<(script|style|noscript|iframe|svg|nav|footer|header|aside|form)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d{1,5}|[a-z]{2,8});/gi, (_m, e: string) => e.startsWith('#') ? (Number(e.slice(1)) === 39 ? '\'' : ' ') : ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    .replace(/^\s*\[[^\]\n]*\]:\s*\S+.*$/gm, ' ')
    .replace(/\b(?:https?|ftp|javascript|data):\S*/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/(\*{1,3}|_{2,3})([^*_\n]+?)\1/g, '$2')
    // eslint-disable-next-line no-control-regex -- control and invisible formatting characters are what this removes
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2066}-\u{2069}]/gu, ' ')
    .replace(/["„“”«»`]/g, '\'');
  const paragraphs: string[] = [];
  for (const line of text.split(/\n+/)) {
    const plain = line.replace(/^\s*(?:#{1,6}|>+|[-*+•]|\d+[.)])\s+/, '').replace(/\|/g, ' ').replace(/[{}[\]<>*#]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(DATELINE, '');
    // Headings, captions and bylines carry no sentence punctuation; reporting does.
    if (plain.length < 40 || plain.split(' ').length < 7 || BOILERPLATE.test(plain) || !/[.!?…]['’)]?$|[.!?…]['’)]?\s/.test(plain)) continue;
    const kept = sentencesOf(plain).filter(s => !looksLikeInstruction(s) && !TECHNICAL.test(s) && !BOILERPLATE.test(s) && !FURNITURE.test(s) && (keepProfile || !isProfileSentence(s)));
    const paragraph = kept.join(' ').trim();
    if (paragraph.length >= 40) paragraphs.push(paragraph);
  }
  return paragraphs;
}

/** Cut at a sentence end within `max`, else at a word boundary with an ellipsis (the kept part stays verbatim). */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const s of sentencesOf(text)) {
    if ((out ? `${out} ${s}` : s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out) return out;
  const cut = text.slice(0, max - 1).replace(/\s+\S*$/, '');
  return `${cut || text.slice(0, max - 1)}…`;
}

/**
 * The most relevant part of an article (≤ 1,200 characters): its paragraphs that mention the ticker, the company or a
 * peer, in their original order; the lead paragraphs when none does. One line of plain text.
 */
export function articleExcerpt(raw: string | null | undefined, keywords: readonly string[], max = EXCERPT_MAX, keepProfile = false): string {
  const paragraphs = cleanArticleText(raw, keepProfile);
  if (!paragraphs.length) return '';
  const relevant = paragraphs.filter(p => mentions(p, keywords) > 0);
  const chosen = relevant.length ? relevant : paragraphs;
  let out = '';
  for (const p of chosen) {
    const next = out ? `${out} ${p}` : p;
    if (next.length > max) { if (!out) out = clipText(p, max); break; }
    out = next;
  }
  return out;
}

const score = (s: string, keywords: readonly string[]) => mentions(s, keywords) * 3 + Math.min(3, (s.match(DRIVER) ?? []).length);
/** How much an article can tell the analyst: text at all, likely-driver words, mentions of the company. */
export const articleWeight = (text: string, keywords: readonly string[]) =>
  (text.length >= 80 ? 3 : text ? 1 : 0) + Math.min(4, (text.match(DRIVER) ?? []).length) + Math.min(2, mentions(text, keywords));
/**
 * How useful an article is for "what is going on with X" (Běh 24): it must mention the ticker, company or a peer, and
 * its title or a sentence about them must report news (a move, a statement, an event, a likely driver); otherwise -1.
 * Then: news sentences about the company, mentions in the title, driver words, and recency — a dated article of the
 * last days first, an undated one last.
 */
export function articleRelevance(title: string, text: string, keywords: readonly string[], published: string | null, to: string): number {
  const inTitle = mentions(title, keywords), inText = mentions(text, keywords);
  if (!inTitle && !inText) return -1;
  const reports = (s: string) => { DRIVER.lastIndex = 0; return NEWS_VERB.test(s) || DRIVER.test(s); };
  const newsy = sentencesOf(text).filter(s => mentions(s, keywords) > 0 && !isProfileSentence(s) && reports(s)).length;
  const titleNews = inTitle > 0 && reports(title);
  if (!newsy && !titleNews) return -1;
  const at = published ? Date.parse(published) : NaN, end = Date.parse(`${to}T23:59:59Z`);
  const age = Number.isFinite(at) ? Math.max(0, (end - at) / 86_400_000) : null;
  const recency = age === null ? -2 : Math.max(0, 4 - age * 0.5);
  return 2 * Math.min(3, newsy) + (titleNews ? 3 : 0) + Math.min(2, inTitle) + Math.min(3, inText) + Math.min(3, (text.match(DRIVER) ?? []).length) + recency;
}

/** The most informative run of words of a long sentence within `max` characters, with an ellipsis where it was cut. */
function focusClip(sentence: string, keywords: readonly string[], max: number): string {
  const words = sentence.split(' ');
  // Each word scored once (a word of a company keyword 3, a likely-driver word 1); windows add them up.
  const keyWords = new Set(keywords.flatMap(k => k.toLowerCase().split(' ')).filter(w => w.length >= 3));
  const sums = [0];
  for (const w of words) {
    const bare = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    DRIVER.lastIndex = 0;
    sums.push(sums[sums.length - 1] + (keyWords.has(bare) ? 3 : 0) + (DRIVER.test(w) ? 1 : 0));
  }
  let best = { from: 0, to: 0, value: -1 };
  for (let i = 0; i < words.length; i++) {
    let length = -1;
    for (let j = i; j < words.length && length + 1 + words[j].length <= max - 2; j++) {
      length += 1 + words[j].length;
      const value = sums[j + 1] - sums[i];
      if (value > best.value || (value === best.value && j - i > best.to - best.from)) best = { from: i, to: j, value };
    }
  }
  const window = words.slice(best.from, best.to + 1).join(' ');
  return `${best.from > 0 ? '…' : ''}${window}${best.to < words.length - 1 ? '…' : ''}`;
}

/**
 * The best verbatim passage of an excerpt within `max` characters: one or two adjacent sentences with the most mentions
 * of the company and of likely drivers. A single long sentence is cut at a word boundary and ends with an ellipsis.
 * With `focus` (the analyst's input, never a quoted extract), the best sentence wins even when it must be cut, and the
 * cut keeps its most informative words.
 */
export function bestPassage(text: string | null | undefined, keywords: readonly string[], max = EXTRACT_MAX, focus = false): string {
  const sentences = sentencesOf((text ?? '').trim()).filter(s => !looksLikeInstruction(s));
  if (!sentences.length) return '';
  let best = '', bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    for (const span of [1, 2]) {
      if (i + span > sentences.length) continue;
      const window = sentences.slice(i, i + span).join(' ');
      if (window.length > max) continue;
      // The lead sentence summarises a report: it gets a small bonus.
      const value = sentences.slice(i, i + span).reduce((n, s) => n + score(s, keywords), 0) + (i === 0 ? 2 : 0);
      if (value > bestScore) { best = window; bestScore = value; }
    }
  }
  const top = sentences.reduce((a, b) => score(b, keywords) > score(a, keywords) ? b : a);
  if (best && !(focus && score(top, keywords) > bestScore)) return best;
  return focus && top.length > max ? focusClip(top, keywords, max) : clipText(top, max);
}

/**
 * The analyst's reading of an article (≤ `max` characters): its most relevant sentences — company mentions and likely
 * drivers first, the lead sentence slightly preferred — kept verbatim and in their original order; a gap between
 * non-adjacent sentences is marked " … ". When even the best sentence is longer than `max`, its most informative words.
 */
export function relevantPassages(text: string | null | undefined, keywords: readonly string[], max = ANALYST_PASSAGE_MAX): string {
  const sentences = sentencesOf((text ?? '').trim()).filter(s => !looksLikeInstruction(s));
  if (!sentences.length) return '';
  const ranked = sentences.map((s, i) => ({ i, v: score(s, keywords) + (i === 0 ? 2 : 0) })).sort((a, b) => b.v - a.v || a.i - b.i);
  const render = (chosen: number[]) => chosen.map((i, k) => (k === 0 ? '' : chosen[k - 1] === i - 1 ? ' ' : ' … ') + sentences[i]).join('');
  let chosen: number[] = [];
  for (const { i } of ranked) {
    const next = [...chosen, i].sort((a, b) => a - b);
    if (render(next).length <= max) chosen = next;
  }
  return chosen.length ? render(chosen) : bestPassage(text, keywords, max, true);
}

/**
 * Words that mark a research page's topic (Běh 27): they pick its passages and decide whether a page found for that topic
 * is about it at all (`RESEARCH_TOPIC`), so a lawsuit notice is not read as analyst expectations.
 */
export const RESEARCH_WORDS: Record<ResearchKind, string[]> = {
  business: ['provides', 'develops', 'designs', 'operates', 'offers', 'builds', 'customers', 'products', 'services', 'platform', 'network', 'revenue', 'business model', 'headquartered', 'founded'],
  analysts: ['price target', 'analyst', 'analysts', 'rating', 'upgrade', 'downgrade', 'consensus', 'outperform', 'overweight', 'underweight', 'buy rating', 'sell rating', 'hold rating'],
  industry: ['industry', 'market', 'sector', 'competition', 'competitors', 'demand', 'growth', 'outlook', 'adoption', 'regulation'],
  // Běh 31: the other research topics.
  financials: ['revenue', 'margin', 'profit', 'net income', 'loss', 'cash flow', 'debt', 'cash', 'guidance', 'quarter', 'dilution'],
  moat: ['competitive advantage', 'moat', 'market share', 'competitors', 'technology', 'patents', 'switching costs', 'scale', 'leader'],
  management: ['CEO', 'founder', 'management', 'insider', 'bought', 'sold', 'shares', 'stake', 'shareholder', 'board', 'executive'],
  dividends: ['dividend', 'yield', 'payout', 'buyback', 'repurchase', 'distribution'],
  catalysts: ['catalyst', 'upcoming', 'launch', 'contract', 'approval', 'earnings date', 'expected', 'milestone', 'deadline'],
};
export const RESEARCH_TOPIC: Record<ResearchKind, RegExp> = {
  business: /\b(?:provides?|develops?|developing|designs?|operates?|offers?|builds?|building|is (?:a|an|the) [\w\s-]{0,60}(?:company|provider|maker|developer|operator|manufacturer|designer|firm|bank|platform|network))\b/i,
  analysts: /\b(?:price targets?|analysts?|ratings?|upgrades?|upgraded|downgrades?|downgraded|consensus|outperform|overweight|underweight)\b/i,
  industry: /\b(?:industry|market|sector|competition|competitors?|demand|outlook)\b/i,
  financials: /\b(?:revenue|margins?|profit|net income|loss|cash flow|debt|guidance|quarter)\b/i,
  moat: /\b(?:competitive advantage|moat|market share|competitors?|leader|patents?|edge)\b/i,
  management: /\b(?:CEO|founder|management|insiders?|stake|shareholders?|executives?|board)\b/i,
  dividends: /\b(?:dividends?|yield|payout|buybacks?|repurchases?)\b/i,
  catalysts: /\b(?:catalysts?|upcoming|launch|contracts?|approval|milestones?|expected to)\b/i,
};

// Question words that carry no topic (cs/sk/en): left out of a web search built from a question (Běh 27).
const STOPWORDS = new Set(('a i o u v ve z ze s se na do od po pro při pri za je jsou byl byla bylo být jak jaký jaká jaké jakej proč prečo co čo kdo kde kdy '
  + 'který která které ktorý ktorá ktoré mi mě mne ti tě tebe si sa to ten ta tu tom tohle toto tak taky také aby že ale nebo či jestli ak keď '
  + 'myslíš myslis vidíš vidis řekni rekni povedz prosím prosim mohl mohla můžeš mozes bys by nějak nějaký nejaký vůbec vlastně teda '
  + 'the an of to in on for and or is are was were be what why how who which when where do does did you your me my it its this that '
  + 'please tell think about can could would should will').split(' '));
/**
 * Search words of a question that is about no one's own data (the caller checks): topic words only, no stopwords, no
 * long digit runs (never an account or phone number), at most twelve words and 120 characters.
 */
export function webSearchQuery(question: string): string {
  const words = question.normalize('NFC').replace(/[^\p{L}\p{N}&.%$€\s-]/gu, ' ').split(/\s+/)
    .map(w => w.replace(/^[.-]+|[.-]+$/g, '')).filter(w => w && !STOPWORDS.has(w.toLowerCase()) && !/\d{5,}/.test(w));
  return words.slice(0, 12).join(' ').slice(0, 120).trim();
}

/** Tavily query: ticker, company name and period words only — never the question or any portfolio data. */
export function newsSearchQuery(ticker: string, name: string | null | undefined, days: number): string {
  const clean = (name ?? '').replace(/[^\p{L}\p{N} .&'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  // Calendar days: five trading days span up to nine of them.
  const when = days <= 9 ? 'this week' : days <= 18 ? 'past two weeks' : days <= 40 ? 'past month' : 'past months';
  return [ticker.replace(/[^A-Z0-9.-]/g, ''), clean, 'stock news', when].filter(Boolean).join(' ');
}

const PUBLISHERS: Record<string, string> = { 'reuters.com': 'Reuters', 'bloomberg.com': 'Bloomberg', 'cnbc.com': 'CNBC', 'marketwatch.com': 'MarketWatch',
  'wsj.com': 'The Wall Street Journal', 'ft.com': 'Financial Times', 'seekingalpha.com': 'Seeking Alpha', 'benzinga.com': 'Benzinga',
  'fool.com': 'The Motley Fool', 'investors.com': 'Investor\'s Business Daily', 'barrons.com': 'Barron\'s', 'forbes.com': 'Forbes',
  'businessinsider.com': 'Business Insider', 'apnews.com': 'AP', 'nasdaq.com': 'Nasdaq', 'zacks.com': 'Zacks', 'investing.com': 'Investing',
  'morningstar.com': 'Morningstar', 'thestreet.com': 'TheStreet', 'globenewswire.com': 'GlobeNewswire', 'prnewswire.com': 'PR Newswire',
  'businesswire.com': 'Business Wire', 'techcrunch.com': 'TechCrunch', 'theverge.com': 'The Verge', 'fortune.com': 'Fortune', 'axios.com': 'Axios',
  'cnn.com': 'CNN', 'bbc.com': 'BBC', 'bbc.co.uk': 'BBC', 'nytimes.com': 'The New York Times', 'economist.com': 'The Economist',
  'theinformation.com': 'The Information', 'datacenterdynamics.com': 'DatacenterDynamics', 'tipranks.com': 'TipRanks', 'investorplace.com': 'InvestorPlace',
  'patria.cz': 'Patria', 'e15.cz': 'E15', 'hn.cz': 'Hospodářské noviny', 'ihned.cz': 'Hospodářské noviny', 'seznamzpravy.cz': 'Seznam Zprávy',
  'idnes.cz': 'iDNES', 'novinky.cz': 'Novinky', 'aktualne.cz': 'Aktuálně', 'penize.cz': 'Peníze', 'kurzy.cz': 'Kurzy', 'finance.cz': 'Finance',
  'finance.yahoo.com': 'Yahoo Finance', 'trend.sk': 'Trend', 'sme.sk': 'SME', 'dennikn.sk': 'Denník N',
  // Běh 23b: finance, crypto and tech hosts Tavily returns (verified in guards.ts PUBLISHER_HOSTS). Yahoo stays out:
  // no Yahoo host may appear in the Edge graph (Běh 8 check).
  'marketbeat.com': 'MarketBeat', 'investopedia.com': 'Investopedia', 'theglobeandmail.com': 'The Globe and Mail', 'fxstreet.com': 'FXStreet',
  'coindesk.com': 'CoinDesk', 'cointelegraph.com': 'Cointelegraph', 'theblock.co': 'The Block', 'decrypt.co': 'Decrypt',
  'siliconangle.com': 'SiliconANGLE', 'theregister.com': 'The Register', 'tomshardware.com': 'Tom\'s Hardware',
  'datacenterknowledge.com': 'Data Center Knowledge', 'semianalysis.com': 'SemiAnalysis', 'finviz.com': 'Finviz', 'gurufocus.com': 'GuruFocus',
  'ainvest.com': 'AInvest', 'stocktitan.net': 'Stock Titan',
  // Běh 27: company research.
  'wikipedia.org': 'Wikipedia', 'stockanalysis.com': 'Stock Analysis', 'marketscreener.com': 'MarketScreener' };
/** A readable publisher name for an article host (never the host itself, which reads like a link). */
export function publisherFromHost(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  for (const [domain, name] of Object.entries(PUBLISHERS)) if (h === domain || h.endsWith(`.${domain}`)) return name;
  const labels = h.split('.').filter(Boolean);
  const label = labels.length >= 2 ? labels[labels.length - 2] : labels[0] ?? '';
  return label ? label[0].toUpperCase() + label.slice(1) : 'Unknown';
}

/** Numbers written in a text, normalised for comparison ("1,5" = "1.5", "2,000" = "2000"). */
export function numberTokens(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map(t => {
    const plain = /^\d{1,3}(?:,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.');
    const n = Number(plain);
    return Number.isFinite(n) ? String(n) : plain;
  });
}
