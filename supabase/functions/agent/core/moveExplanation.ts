import { articleWeight, nameKeywords } from './articleText.ts';
import { hasUnverifiedTicker, registerFact } from './context.ts';
import type { Period } from './dataTypes.ts';
import { neutralize, safeUrl } from './guards.ts';
import type { AnalystInput } from './newsAnalyst.ts';
import { type Aspect, type AspectRead, keywordAspects } from './aspects.ts';
import type { AnalystView, EarningsInfo, NewsItem, PeerList, ResearchKind } from './marketTypes.ts';
import type { Lang } from './protocol.ts';
import { isCompanyQuestion, isOutlookQuestion } from './router.ts';
import type { Fact, ToolCtx, ToolResult } from './types.ts';

// "Co se děje poslední dny s NBIS?" (Běh 22, articles in Běh 23). The server loads the period move, the S&P 500 and
// peers over the same days, the articles about the instrument and its two closest peers (excerpts of their text, not
// only titles), analyst changes and earnings; it states every figure itself. The news analyst turns the excerpts into
// attributed likely drivers. News stays untrusted data throughout; only verified publishers are read or cited.

export const MOVE_NEWS_MAX = 8, MOVE_PEERS_MAX = 4, MOVE_PEER_NEWS = 2, MOVE_DEFAULT_DAYS = 5, RESEARCH_MAX = 6;
/** "How is SPCX doing?" without a period: the last three months (Běh 26). */
export const COMPANY_DEFAULT_DAYS = 63;
const DAY = 86_400_000;

/* ----------------------------- period ----------------------------- */

const weekend = (ms: number) => [0, 6].includes(new Date(ms).getUTCDay());
/** The date `days` trading days (Mon–Fri; holidays not modelled) before the last trading day at or before `today`. */
export function tradingDaysBack(today: string, days: number): string {
  let t = Date.parse(`${today}T00:00:00Z`);
  while (weekend(t)) t -= DAY;
  for (let n = 0; n < days;) { t -= DAY; if (!weekend(t)) n++; }
  return new Date(t).toISOString().slice(0, 10);
}
const COUNT_WORDS: Record<string, number> = { dva: 2, dvě: 2, dve: 2, two: 2, tři: 3, tri: 3, three: 3, čtyři: 4, štyri: 4, four: 4, pět: 5, päť: 5,
  five: 5, šest: 6, šesť: 6, six: 6 };
/** Trading days a move question covers: days/týden/week → 5, two weeks → 10, month → 21, "7 dní" → 7; else `fallback` (5). */
export function movePeriodDays(question: string, fallback = MOVE_DEFAULT_DAYS): number {
  const q = question.normalize('NFC').toLowerCase();
  const counted = /(?<![\p{L}\d])(\d{1,2}|dva|dvě|dve|two|tři|tri|three|čtyři|štyri|four|pět|päť|five|šest|šesť|six)\s+(dn\p{L}*|dní|dni|days?|týž?d\p{L}*|weeks?|měsíc\p{L}*|mesiac\p{L}*|months?)(?![\p{L}])/u.exec(q);
  const count = counted ? Number(counted[1]) || COUNT_WORDS[counted[1]] : 1;
  const unit = counted?.[2] ?? /(?<![\p{L}])(?:měsíc|mesiac|month)/u.exec(q)?.[0] ?? /(?<![\p{L}])(?:týž?d|week)/u.exec(q)?.[0] ?? '';
  const days = /^(?:měsíc|mesiac|month)/u.test(unit) ? 21 * count : /^(?:týž?d|week)/u.test(unit) ? 5 * count : counted ? count : fallback;
  return Math.min(63, Math.max(1, days));
}

/* ----------------------------- evidence ----------------------------- */

export type MoveCall = { name: string; args: unknown };
/** One article: id for the analyst (`n1`…), its text fact, publisher, date, link, and a clean excerpt of its text. */
/** `kind`: a company research page (Běh 27) — its business, analyst expectations or its industry; news has none. */
export type MoveNews = { key: string; factId: string; ticker: string; title: string; summary: string; excerpt: string; publisher: string; date: string | null; url: string;
  kind?: ResearchKind };
export type MoveScope = 'sector' | 'mixed' | 'stock' | 'market' | 'flat' | 'unknown';
export type MoveEvidence = {
  ticker: string; lang: Lang; period: Period; question?: string; change?: Fact; first?: Fact; last?: Fact; drawdown?: Fact; spx?: Fact; price?: Fact; dayChange?: Fact;
  peers: { ticker: string; change?: Fact }[]; peerBasis: PeerList['basis'] | null; peerMedian: number | null; scope: MoveScope;
  news: MoveNews[]; unverified: number; keywords: string[];
  /** What an outlook question asks for (Běh 29). */
  asks?: OutlookAsks;
  /**
   * `company`: how the company is doing and why it is valued so (Běh 26); `outlook`: where it may be in a few years —
   * analysts, valuation and three-year scenarios on top (Běh 27); `move`: why the price moved.
   */
  focus: 'move' | 'company' | 'outlook';
  outlook?: OutlookEvidence;
  analystChanges: AnalystView['changes']; earningsInPeriod: string[]; nextEarnings?: Fact; warnings: string[];
};

const factOf = (result: ToolResult<unknown> | undefined, key: string): Fact | undefined =>
  result?.ok ? result.facts.find(f => (f.metric ?? f.id) === key && f.value !== null) : undefined;
const itemsOf = (result: ToolResult<unknown> | undefined): NewsItem[] => result?.ok ? (result.data as { items?: NewsItem[] }).items ?? [] : [];
const nameOf = (result: ToolResult<unknown> | undefined): string | null => result?.ok ? (result.data as { name?: string | null }).name ?? null : null;
const valueOf = (f: Fact | undefined) => typeof f?.value === 'number' && Number.isFinite(f.value) ? f.value : null;

/**
 * Articles of several news results as analyst evidence: the first queue (the instrument's own news, newest first), then
 * the others in turn; one item per link and per title; only verified publishers (their links can be shown). Each one is
 * a text fact „publisher | date | title — excerpt“, so a quoted extract can be checked against it.
 */
export function collectArticles(ctx: ToolCtx, queues: readonly (readonly [string, ToolResult<unknown> | undefined])[], max: number,
  start = 0): { news: MoveNews[]; unverified: number } {
  const lists = queues.map(([t, r]) => itemsOf(r).map(item => ({ t, item, r })));
  const ordered = [...(lists[0] ?? [])];
  for (let i = 0; lists.slice(1).some(q => q.length > i); i++) for (const q of lists.slice(1)) if (q[i]) ordered.push(q[i]);
  const news: MoveNews[] = [], urls = new Set<string>(), titles = new Set<string>();
  let unverified = 0;
  for (const { t, item, r } of ordered) {
    if (news.length >= max) break;
    const title = neutralize(item.title, 200), summary = neutralize(item.summary, 300), publisher = neutralize(item.publisher, 60);
    if (!title || urls.has(item.url) || titles.has(title.toLowerCase())) continue;
    urls.add(item.url); titles.add(title.toLowerCase());
    if (!safeUrl(item.url)) { unverified++; continue; }
    const excerpt = item.excerpt === undefined ? summary : neutralize(item.excerpt, 1300);
    const k = `n${start + news.length + 1}`, date = item.published && /^\d{4}-\d{2}-\d{2}/.test(item.published) ? item.published.slice(0, 10) : null;
    const count = r?.ok ? r.facts.find(f => /^news:/.test(f.metric ?? f.id)) : undefined;
    const fact = registerFact(ctx, { id: `news:${t}:${k}`, value: `${publisher} | ${date ?? 'undated'} | ${title}${excerpt ? ` — ${excerpt}` : ''}`, unit: 'text',
      ticker: t, source: count?.source ?? 'stock_news', as_of: item.published ?? count?.as_of ?? ctx.today, metric: `news:${t}:${k}`, scope: 'all',
      quality: { state: 'complete', freshness: count?.quality?.freshness ?? 'fresh' } });
    news.push({ key: k, factId: fact.id, ticker: t, title, summary, excerpt, publisher, date, url: item.url, ...(item.kind ? { kind: item.kind } : {}) });
  }
  return { news, unverified };
}

/** Stock-specific or sector-wide, from the period change against the peers' median and the S&P 500 (percentage points). */
export function moveScope(stock: number | null, market: number | null, peers: readonly number[]): { scope: MoveScope; median: number | null } {
  const sorted = [...peers].sort((a, b) => a - b), n = sorted.length;
  const median = n ? n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null;
  if (stock === null) return { scope: 'unknown', median };
  if (Math.abs(stock) < 2) return { scope: 'flat', median };
  if (median !== null && n >= 2) {
    if (Math.sign(median) === Math.sign(stock) && Math.abs(median) >= 2) {
      return { scope: Math.abs(stock) - Math.abs(median) >= Math.max(4, Math.abs(stock) * 0.4) ? 'mixed' : 'sector', median };
    }
    return { scope: market !== null && Math.abs(stock - market) < 4 ? 'market' : 'stock', median };
  }
  return { scope: market === null ? 'unknown' : Math.abs(stock - market) >= 4 ? 'stock' : 'market', median };
}

/**
 * Every mandatory piece of a move answer, loaded before the analyst: price history of the period with the S&P 500,
 * peers, quote, analysts and earnings; then the peers' period changes and the articles (with text) about the instrument
 * and its top two peers — asked after the peers are known, so excerpts keep the paragraphs that mention them.
 */
export async function collectMoveEvidence(ticker: string, question: string, ctx: ToolCtx, lang: Lang,
  run: (calls: MoveCall[]) => Promise<ToolResult<unknown>[]>,
  // Běh 30: a company question gets the full outlook pipeline too (research, analysts, valuation); its asks pick the sections.
  focus: MoveEvidence['focus'] = isOutlookQuestion(question) || isCompanyQuestion(question) ? 'outlook' : 'move', given?: OutlookAsks):
  Promise<{ evidence: MoveEvidence; calls: MoveCall[] }> {
  // What the question asks (the caller's model classification, else keywords) picks the research topics and the horizon.
  const asks = focus === 'outlook' ? given ?? outlookAsks(question) : undefined;
  const period: Period = { from: tradingDaysBack(ctx.today, movePeriodDays(question, focus === 'move' ? MOVE_DEFAULT_DAYS : COMPANY_DEFAULT_DAYS)), to: ctx.today };
  const first: MoveCall[] = [
    { name: 'get_price_history', args: { ticker, period, benchmark: 'SPX' } }, { name: 'get_peers', args: { ticker } },
    { name: 'get_quote', args: { ticker } }, { name: 'get_analyst_view', args: { ticker } }, { name: 'get_earnings_calendar', args: { ticker } },
    // The outlook also needs the statements, the valuation history and the fair value model (indices 5–7).
    // Běh 27: and, for any company in the world, web research (business, analysts, industry) and provider key metrics (8–9).
    ...(focus === 'outlook' ? [{ name: 'get_fundamentals', args: { ticker } }, { name: 'get_valuation_history', args: { ticker } },
      { name: 'get_fair_value', args: { ticker, years: asks!.years } }, { name: 'get_company_research', args: { ticker, topics: researchTopics(asks!) } }, { name: 'get_key_metrics', args: { ticker } }] : []),
  ];
  const r1 = await run(first);
  const peerResult = r1[1];
  const peerList = peerResult?.ok ? ((peerResult.data as { peers?: string[] }).peers ?? []).slice(0, MOVE_PEERS_MAX) : [];
  // An outlook reads the company's own research and news; peers' news would crowd it out (Běh 28: Atlassian for IREN).
  const newsPeers = focus === 'outlook' ? [] : peerList.slice(0, MOVE_PEER_NEWS);
  const second: MoveCall[] = [...peerList.map(p => ({ name: 'get_price_history', args: { ticker: p, period } })),
    { name: 'get_stock_news', args: { ticker, period, articles: true, ...(peerList.length ? { related: peerList } : {}) } },
    ...newsPeers.map(p => ({ name: 'get_stock_news', args: { ticker: p, period, articles: true, related: [ticker] } }))];
  const r2 = await run(second);

  const history = r1[0], key = (k: string) => factOf(history, `history:${ticker}:${k}`);
  const peers = peerList.map((p, i) => ({ ticker: p, change: factOf(r2[i], `history:${p}:change_pct`) }));
  const change = key('change_pct'), spx = factOf(history, 'history:SPX:change_pct');
  const { scope, median } = moveScope(valueOf(change), valueOf(spx), peers.map(p => valueOf(p.change)).filter((v): v is number => v !== null));
  const own = r2[peerList.length];
  // An outlook reads the research pages first, then the news (its own, then the peers').
  const research = focus === 'outlook' ? [[ticker, r1[8]] as const] : [];
  const { news, unverified } = collectArticles(ctx, [...research, [ticker, own], ...newsPeers.map((p, i) => [p, r2[peerList.length + 1 + i]] as const)],
    MOVE_NEWS_MAX + (research.length ? RESEARCH_MAX : 0));

  const analysts = r1[3]?.ok ? (r1[3].data as AnalystView).changes ?? [] : [];
  const earnings = r1[4]?.ok ? (r1[4].data as { items?: EarningsInfo[] }).items ?? [] : [];
  const evidence: MoveEvidence = {
    ticker, lang, period, focus, question, change, first: key('first_close'), last: key('last_close'), drawdown: key('max_drawdown_pct'), spx,
    price: factOf(r1[2], `quote:${ticker}:price`), dayChange: factOf(r1[2], `quote:${ticker}:change_pct`),
    peers, peerBasis: peerResult?.ok ? (peerResult.data as PeerList).basis : null, peerMedian: median, scope, news, unverified,
    keywords: nameKeywords(ticker, nameOf(own), peerList),
    analystChanges: analysts.filter(c => c.date >= period.from && c.date <= ctx.today).slice(0, 3),
    earningsInPeriod: earnings.map(e => e.date).filter(d => d >= period.from && d <= ctx.today),
    nextEarnings: factOf(r1[4], `earnings:${ticker}:next_date`),
    warnings: [...[history, r1[2]].flatMap(r => r?.ok ? r.meta.warnings : []), ...(hasUnverifiedTicker(ctx) ? ['ticker_unverified'] : [])],
    ...(asks ? { asks, outlook: outlookEvidence(ctx, ticker, { analysts: r1[3], fundamentals: r1[5], valuation: r1[6],
      fairValue: r1[7], metrics: r1[9] }, factOf(r1[2], `quote:${ticker}:price`), asks.years) } : {}),
  };
  return { evidence, calls: [...first, ...second] };
}

/* ----------------------------- outlook (Běh 27) ----------------------------- */

export type ScenarioKind = 'bear' | 'base' | 'bull';
/** One scenario: its assumptions (growth a year, the P/E or P/S then, the net margin of the model), the price they give and its yearly return. */
export type Scenario = { kind: ScenarioKind; growth: Fact; pe: Fact; price: Fact; annual?: Fact; margin?: Fact };
/**
 * What an outlook question asks for (Běh 29), so the answer leads with it and leaves out what nobody asked: price
 * scenarios, what the company does, analysts, risks, or a full analysis; `years`: the horizon asked ("za 5 let"), else 3.
 */
export type OutlookAsks = { scenarios: boolean; business: boolean; analysts: boolean; risks: boolean; full: boolean; years: number;
  /** Every asked aspect (Běh 31: model classification merged with keywords), in canonical order. */
  aspects: Aspect[] };
/** The asks of a classified question. */
export function asksFrom(read: AspectRead): OutlookAsks {
  const has = (a: Aspect) => read.aspects.includes(a);
  return { scenarios: has('scenarios') || has('valuation'), business: has('business'), analysts: has('analysts'), risks: has('risks') || has('moat'),
    full: read.full, years: read.years, aspects: read.aspects };
}
/** The keyword reading of a question's asks (no model). */
export const outlookAsks = (question: string): OutlookAsks => asksFrom(keywordAspects(question));
// Research topics by asked aspect; at most four searches, the asked ones first, the defaults after.
const RESEARCH_OF: Partial<Record<Aspect, ResearchKind>> = { business: 'business', analysts: 'analysts', industry: 'industry', financials: 'financials',
  moat: 'moat', management: 'management', dividends: 'dividends', catalysts: 'catalysts', scenarios: 'analysts', valuation: 'analysts', risks: 'industry' };
export function researchTopics(asks: OutlookAsks): ResearchKind[] {
  // A topic asked by name (management, dividends…) before one only implied (risks → industry, scenarios → analysts).
  const direct = asks.aspects.filter(a => RESEARCH_OF[a] === a).map(a => RESEARCH_OF[a]!);
  const implied = asks.aspects.filter(a => RESEARCH_OF[a] && RESEARCH_OF[a] !== a).map(a => RESEARCH_OF[a]!);
  return [...new Set([...direct, ...implied, 'analysts', 'business', 'industry'] as ResearchKind[])].slice(0, 4);
}
/**
 * What an outlook answer stands on, every figure a fact: analysts (counts, targets and the mean target against today's
 * price), the valuation (P/E now, its five-year median and percentile, the Trackora fair value, the growth today's price
 * implies) and three scenarios. `missing`: why there are no scenarios (no statements, a loss, another currency).
 */
export type OutlookEvidence = {
  counts: Fact[]; consensus?: Fact; targetMean?: Fact; targetLow?: Fact; targetHigh?: Fact; targetPotential?: Fact;
  eps?: Fact; peNow?: Fact; peMedian?: Fact; pePercentile?: Fact; fair?: Fact; fairPotential?: Fact; implied?: Fact;
  /** Provider key metrics (any listed company): P/S, market capitalisation, revenue growth, 52-week range. */
  psNow?: Fact; marketCap?: Fact; revenueGrowth?: Fact; high52w?: Fact; low52w?: Fact;
  /** `history`: exit P/E from the company's own five years (stored statements); `today`: today's provider P/E. */
  peBasis?: 'history' | 'today';
  /** `eps`: earnings × P/E; `sales` (a company without profit, Běh 29): today's price moved by revenue growth and the P/S;
   * `model` (Ocenění v2): the Trackora valuation's scenarios — revenue along the consensus path × net margin × the P/E of the
   * growth still ahead (`modelBasis` earnings), or × today's P/S shrinking as growth slows (`modelBasis` sales). */
  basis?: 'eps' | 'sales' | 'model';
  modelBasis?: 'earnings' | 'sales';
  /** The fair value model used (`revenue`: the growth model) and the fair value against the analysts' targets. */
  fairModel?: Fact; analystCheck?: Fact; forwardEps?: Fact; companyType?: Fact;
  years: number;
  scenarios: Scenario[]; missing?: 'statements' | 'loss' | 'currency' | 'assumptions';
};

export const SCENARIO_YEARS = 3;
// The base case is the Trackora fair value model's own default (its EPS growth and exit P/E from the company's history);
// the bear and bull cases move both assumptions by fixed, stated steps.
const SCENARIOS: readonly { kind: ScenarioKind; growth: (g: number) => number; pe: number }[] = [
  { kind: 'bear', growth: g => Math.max(-0.15, g - 0.08), pe: 0.75 },
  { kind: 'base', growth: g => g, pe: 1 },
  { kind: 'bull', growth: g => Math.min(0.5, g + 0.06), pe: 1.25 },
];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The outlook's facts from the analyst, statement, valuation and fair value results; the scenarios registered as model facts. */
export function outlookEvidence(ctx: ToolCtx, ticker: string, r: { analysts?: ToolResult<unknown>; fundamentals?: ToolResult<unknown>;
  valuation?: ToolResult<unknown>; fairValue?: ToolResult<unknown>; metrics?: ToolResult<unknown> }, price: Fact | undefined, years = SCENARIO_YEARS): OutlookEvidence {
  const a = (k: string) => factOf(r.analysts, `analysts:${ticker}:${k}`), v = (k: string) => factOf(r.valuation, `valuation:${ticker}:${k}`);
  const fv = (k: string) => factOf(r.fairValue, `fair_value:${ticker}:${k}`), m = (k: string) => factOf(r.metrics, `metrics:${ticker}:${k}`);
  const stored = factOf(r.fundamentals, `fundamentals:${ticker}:annual:dilutedEps`);
  const out: OutlookEvidence = {
    counts: ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'].map(a).filter((f): f is Fact => !!f), consensus: a('consensus'),
    targetMean: a('target_mean'), targetLow: a('target_low'), targetHigh: a('target_high'),
    // Stored statements first (Trackora's own valuation); any other listed company: the provider's trailing figures.
    eps: stored ?? m('eps_ttm'), peNow: v('current:pe') ?? m('pe_ttm'), peMedian: v('median_5y:pe'), pePercentile: v('percentile:pe'),
    fair: fv('value'), fairPotential: fv('potential'), implied: fv('implied_growth'),
    psNow: v('current:ps') ?? m('ps_ttm'), marketCap: m('market_cap'), revenueGrowth: m('revenue_growth_ttm'), high52w: m('high_52w'), low52w: m('low_52w'),
    years, scenarios: [],
  };
  const now = valueOf(price);
  const derived = (id: string, value: number, unit: Fact['unit'], source: string, from: Fact, currency?: string | null) => registerFact(ctx, {
    id, value, unit, source, as_of: ctx.today, ticker, metric: id, scope: 'all', ...(currency ? { currency } : {}),
    quality: { state: 'complete', freshness: from.quality?.freshness ?? 'fresh' } });
  const mean = valueOf(out.targetMean);
  if (out.targetMean && mean !== null && now !== null && now > 0 && out.targetMean.currency === price?.currency) {
    out.targetPotential = derived(`analysts:${ticker}:target:potential`, mean / now - 1, 'ratio', 'calculation:analyst_target', out.targetMean);
  }
  out.fairModel = fv('model'); out.analystCheck = fv('analyst_check'); out.forwardEps = fv('forward_eps'); out.companyType = fv('company_type');

  // Ocenění v2: the valuation tool's own scenarios (stored statements + consensus) come first.
  const sc = (kind: ScenarioKind, k: string) => factOf(r.fairValue, `scenario:${ticker}:${kind}:${k}`);
  const modelBasis = factOf(r.fairValue, `scenario:${ticker}:basis`)?.value;
  if (modelBasis === 'earnings' || modelBasis === 'sales') {
    for (const kind of ['bear', 'base', 'bull'] as const) {
      const priceFact = sc(kind, 'price'), growthFact = sc(kind, 'assumption:growth'), multipleFact = sc(kind, modelBasis === 'sales' ? 'assumption:ps' : 'assumption:pe');
      if (!priceFact || !growthFact || !multipleFact) continue;
      out.scenarios.push({ kind, price: priceFact, growth: growthFact, pe: multipleFact, annual: sc(kind, 'annual_return'), margin: sc(kind, 'assumption:margin') });
    }
    if (out.scenarios.length === 3) {
      out.basis = 'model'; out.modelBasis = modelBasis;
      // P/S today for the sales wording, when the provider gives it.
      return out;
    }
    out.scenarios = [];
  }

  // Growth and exit P/E: the fair value model's (from the company's history); else the provider's five-year EPS growth and today's P/E.
  const providerGrowth = valueOf(m('eps_growth_5y')), modelExit = valueOf(fv('assumption:pe')) ?? valueOf(out.peMedian);
  const eps = valueOf(out.eps), growth = valueOf(fv('assumption:epsGrowth')) ?? (providerGrowth === null ? null : providerGrowth / 100);
  const exit = modelExit ?? valueOf(m('pe_ttm'));
  out.peBasis = modelExit !== null ? 'history' : 'today';
  // No profit (or no statements): scenarios from sales when the provider gives P/S and revenue growth (Běh 29).
  if (!out.eps || eps === null || eps <= 0) {
    if (salesScenarios(out, ticker, price, derived)) return out;
    out.missing = !out.eps || eps === null ? 'statements' : 'loss';
    return out;
  }
  if (growth === null || exit === null || exit <= 0) { out.missing = 'assumptions'; return out; }
  out.basis = 'eps';
  const currency = out.eps.currency ?? null;
  for (const s of SCENARIOS) {
    const g = clamp(s.growth(clamp(growth, -0.1, 0.35)), -0.15, 0.5), pe = clamp(exit * s.pe, 4, 80);
    const value = eps * (1 + g) ** years * pe;
    const base = `scenario:${ticker}:${s.kind}`;
    const scenario: Scenario = {
      kind: s.kind,
      growth: derived(`${base}:assumption:epsGrowth`, g, 'ratio', 'assumption', out.eps),
      pe: derived(`${base}:assumption:pe`, pe, 'ratio', 'assumption', out.eps),
      price: derived(`${base}:price`, value, 'money', 'scenario_model', out.eps, currency),
    };
    if (now !== null && now > 0 && price?.currency === currency) {
      scenario.annual = derived(`${base}:annual_return`, (value / now) ** (1 / years) - 1, 'ratio', 'scenario_model', out.eps);
    }
    out.scenarios.push(scenario);
  }
  if (now !== null && price?.currency !== currency) out.missing = 'currency';
  return out;
}

// Sales scenarios (Běh 29): revenue grows at the stated rate and the market pays a lower, equal or higher P/S than today —
// fast growers' multiples usually shrink as they mature, so the base case assumes some compression.
const SALES_SCENARIOS: readonly { kind: ScenarioKind; growth: (g: number) => number; ps: number }[] = [
  { kind: 'bear', growth: g => Math.max(-0.15, g * 0.4 - 0.05), ps: 0.5 },
  { kind: 'base', growth: g => g, ps: 0.8 },
  { kind: 'bull', growth: g => Math.min(0.7, g * 1.3 + 0.05), ps: 1.1 },
];
type Derive = (id: string, value: number, unit: Fact['unit'], source: string, from: Fact, currency?: string | null) => Fact;
function salesScenarios(out: OutlookEvidence, ticker: string, price: Fact | undefined, derived: Derive): boolean {
  const now = valueOf(price), ps = valueOf(out.psNow), rg = valueOf(out.revenueGrowth);
  if (!price || !out.psNow || !out.revenueGrowth || now === null || now <= 0 || ps === null || ps <= 0 || rg === null) return false;
  const growth = clamp(rg / 100, -0.1, 0.5), years = out.years;
  for (const s of SALES_SCENARIOS) {
    const g = clamp(s.growth(growth), -0.15, 0.7), multiple = Math.max(0.3, ps * s.ps);
    const value = now * (1 + g) ** years * (multiple / ps);
    const base = `scenario:${ticker}:${s.kind}`;
    out.scenarios.push({ kind: s.kind,
      growth: derived(`${base}:assumption:growth`, g, 'ratio', 'assumption', out.revenueGrowth),
      pe: derived(`${base}:assumption:ps`, multiple, 'ratio', 'assumption', out.psNow),
      price: derived(`${base}:price`, value, 'money', 'scenario_model', price, price.currency ?? null),
      annual: derived(`${base}:annual_return`, (value / now) ** (1 / years) - 1, 'ratio', 'scenario_model', price) });
  }
  out.basis = 'sales';
  return true;
}

/** The outlook's facts in words for the analyst (no figures to copy): valuation, analysts, the model and the scenarios. */
export function outlookFactsInWords(o: OutlookEvidence, ticker: string): string[] {
  const words: string[] = [];
  const pe = valueOf(o.peNow), median = valueOf(o.peMedian);
  if (pe !== null && median !== null) words.push(`${ticker} P/E is ${pe > median * 1.1 ? 'above' : pe < median * 0.9 ? 'below' : 'near'} its 5-year median.`);
  const n = (k: string) => o.counts.filter(f => f.metric?.endsWith(`:${k}`)).reduce((s, f) => s + (valueOf(f) ?? 0), 0);
  const buys = n('strong_buy') + n('buy'), total = buys + n('hold') + n('sell') + n('strong_sell');
  if (total) words.push(`Analysts: ${buys / total >= 0.6 ? 'most rate it buy' : buys / total >= 0.4 ? 'split between buy and hold' : 'mostly hold or sell'}.`);
  const target = valueOf(o.targetPotential);
  if (target !== null) words.push(`The mean analyst price target is ${target > 0.03 ? 'above' : target < -0.03 ? 'below' : 'near'} today's price.`);
  const fair = valueOf(o.fairPotential);
  if (fair !== null) words.push(`Today's price is ${fair > 0.1 ? 'below' : fair < -0.1 ? 'above' : 'near'} the Trackora fair value model.`);
  if (o.fairModel?.value === 'revenue') words.push(`The Trackora fair value uses its growth model: analyst consensus revenue and margins, a P/E for the growth still ahead.`);
  const check = o.analystCheck?.value;
  if (check === 'inline') words.push('The Trackora fair value is close to the mean analyst target.');
  if (check === 'below') words.push('The Trackora fair value is below the mean analyst target: the model is more cautious than analysts.');
  if (check === 'above') words.push('The Trackora fair value is above the mean analyst target: the model is more optimistic than analysts.');
  if (check === 'outside') words.push('The Trackora fair value lies outside the whole analyst target range: say the model may miss what the market prices in or fears.');
  const base = o.scenarios.find(s => s.kind === 'base'), annual = valueOf(base?.annual);
  if (annual !== null) words.push(`The base ${o.years}-year scenario (model, not a forecast) ${annual > 0.02 ? 'is above' : annual < -0.02 ? 'is below' : 'is near'} today's price.`);
  if (o.missing === 'loss') words.push(`${ticker} has no profit per share: no earnings-based scenarios.`);
  // Said outright, so the view does not lean on numbers that are not there.
  if (!o.scenarios.length) words.push('There are no model scenarios: do not mention them.');
  if (!o.targetMean && !o.counts.length) words.push('Data providers give no analyst ratings or targets: take analyst views from the pages only.');
  if (!o.peNow && !o.fair && !o.psNow) words.push('Data providers give no valuation figures: take valuation views from the pages only.');
  return words;
}

/* ----------------------------- the analyst's input ----------------------------- */

export const direction = (v: number | null) => v === null ? 'unknown' : v <= -10 ? 'fell sharply' : v <= -3 ? 'fell' : v <= -0.5 ? 'fell slightly'
  : v >= 10 ? 'rose sharply' : v >= 3 ? 'rose' : v >= 0.5 ? 'rose slightly' : 'was flat';
function reading(ev: MoveEvidence): string {
  const down = (valueOf(ev.change) ?? 0) < 0, verb = down ? 'fell' : 'rose';
  return { sector: 'likely sector-wide', mixed: `${ev.ticker} ${verb} more than peers: sector and company news`,
    stock: 'likely company-specific', market: 'moved with the market', flat: 'a small move', unknown: 'no comparison' }[ev.scope];
}
// How the analyst reads an asked aspect, and the theme kind it writes for it.
const ASPECT_WORDS: Record<Aspect, string> = { business: 'what the company does', financials: 'financial health', valuation: 'valuation', scenarios: 'price scenarios',
  analysts: 'analysts', risks: 'risks and the future', moat: 'competitive advantage', management: 'management and owners', dividends: 'dividends and buybacks',
  catalysts: 'upcoming catalysts', price_trend: 'the recent price move', industry: 'the industry' };
const THEME_KIND: Partial<Record<Aspect, string>> = { business: 'business', financials: 'financials', valuation: 'valuation', analysts: 'analysts', risks: 'risk',
  moat: 'moat', management: 'management', dividends: 'dividends', catalysts: 'catalysts', industry: 'industry', price_trend: 'price_trend' };
/** The server's facts in words (no figures to copy) and the verified articles: what the analyst may work from. */
export function moveAnalystInput(ev: MoveEvidence): AnalystInput {
  const from = (ev.change?.period?.from ?? ev.period.from).slice(5), to = (ev.change?.period?.to ?? ev.period.to).slice(5);
  // Without stored or provider closes the move is not known: the analyst still explains what the articles report.
  const facts = valueOf(ev.change) === null ? [`${ev.ticker} ${from}..${to}: price move not available; explain what the articles report about ${ev.ticker}.`]
    : [`${ev.ticker} ${from}..${to} ${direction(valueOf(ev.change))}; S&P 500 ${direction(valueOf(ev.spx))}`
    + `${ev.peers.length ? `; peers ${ev.peers.map(p => p.ticker).join(', ')} ${direction(ev.peerMedian)}` : ''}: ${reading(ev)}.`];
  if (ev.analystChanges.length) facts.push(`Rating changes: ${ev.analystChanges.map(c => `${neutralize(c.firm, 40)} ${neutralize(c.from, 20) || '-'}->${neutralize(c.to, 20) || '-'}`).join('; ')}.`);
  if (ev.earningsInPeriod.length) facts.push('Earnings were reported in the period.');
  if (ev.outlook) facts.push(...outlookFactsInWords(ev.outlook, ev.ticker));
  // The most informative articles first (own news before peers' on a tie): the call may not hold all of them.
  const weight = (n: MoveNews) => articleWeight(`${n.title} ${n.excerpt || n.summary}`, ev.keywords) + (n.ticker === ev.ticker ? 2 : 0);
  // An outlook reads one page of each research kind first (business, analysts, industry), then the rest by weight.
  const order: Record<string, number> = { business: 0, analysts: 1, industry: 2 };
  const firsts = ev.focus === 'outlook' ? ['business', 'analysts', 'industry'].map(k => ev.news.find(n => n.kind === k)).filter((n): n is MoveNews => !!n) : [];
  const rest = ev.news.filter(n => !firsts.includes(n)).map((n, i) => ({ n, i, w: weight(n) + (n.kind ? 1 : 0) }))
    .sort((a, b) => b.w - a.w || a.i - b.i).map(x => x.n);
  const articles = [...firsts.sort((a, b) => order[a.kind!] - order[b.kind!]), ...rest];
  if (ev.focus === 'outlook' && ev.asks) {
    const a = ev.asks, want = a.aspects.map(x => ASPECT_WORDS[x]);
    if (ev.question) facts.push(`Question: ${ev.question}`);
    facts.push(`The user asks (answer exactly this, lead with it): ${want.length ? want.join(', ') : 'an overall view'}; horizon ${a.years} years.`);
    if (!a.business) facts.push('Do not describe what the company does unless it explains a point (no business theme).');
    facts.push(`Write themes for these aspects first (kind = aspect): ${a.aspects.filter(x => THEME_KIND[x]).map(x => THEME_KIND[x]).join(', ') || 'strength, risk'}.`);
    const sales = ev.outlook?.basis === 'sales' || ev.outlook?.modelBasis === 'sales';
    if (ev.outlook?.scenarios.length) facts.push(`Model ${a.years}-year scenarios exist (${sales ? 'from sales growth and P/S' : 'from revenue, margin and P/E'}): refer to them in words.`);
  }
  return { mode: 'move', focus: ev.focus, ...(ev.focus === 'outlook' ? { question: ev.question } : {}), lang: ev.lang, subject: ev.ticker, facts, articles, tickers: [ev.ticker, ...ev.peers.map(p => p.ticker)], keywords: ev.keywords };
}
