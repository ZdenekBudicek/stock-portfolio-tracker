import { addKnownTickers, toolRead } from '../context.ts';
import type { Period } from '../dataTypes.ts';
import { type AnalystView, type EarningsInfo, type HistoryPoint, type KeyMetrics, type MarketValue, type NewsItem, type PeerList, type Quote, RESEARCH_KINDS,
  type ResearchKind } from '../marketTypes.ts';
import type { ToolCtx } from '../types.ts';
import { arrayOf, checkPeriod, defineTool, factSink, marketSnapshotId, meta, num, numOrNull, object, open, parseWith, periodSchema,
  quoteSchema, resolveTicker, strOrNull, success, tickerSchema, unavailable, worst } from './common.ts';

const VOLATILITY_RETURNS = 60;

function quoteFacts(ctx: ToolCtx, value: MarketValue<Quote>, warnings: string[]) {
  const sink = factSink(ctx, warnings), q = value.data!;
  const base = { source: value.source, as_of: value.asOf, ticker: q.ticker };
  sink.add(`quote:${q.ticker}:price`, q.price, 'money', { ...base, currency: q.currency });
  sink.add(`quote:${q.ticker}:previous_close`, q.previousClose ?? undefined, 'money', { ...base, currency: q.currency });
  sink.add(`quote:${q.ticker}:change_pct`, q.changePct ?? undefined, 'percent', base);
  return sink.facts;
}

/* ----------------------------- get_quote ----------------------------- */

const quoteInput = object({ ticker: tickerSchema }, ['ticker']);
const quote = defineTool<{ ticker: string }, Quote>({
  name: 'get_quote', group: 'trh',
  description: 'Latest price of a stock, ETF or crypto with previous close and daily change (percent), its source and market time. Falls back to the last stored close when providers fail.',
  inputSchema: quoteInput, parse: parseWith(quoteInput), outputSchema: quoteSchema,
  async run(args, ctx) {
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const value = await ctx.market.quote(ticker, toolRead(ctx));
    if (!value.data) return unavailable(`No price is available for ${ticker}.`);
    const warnings = [...value.warnings];
    const facts = quoteFacts(ctx, value, warnings);
    return success(ctx, value.data, facts, meta({ snapshotId: marketSnapshotId(value), complete: value.freshness === 'fresh', warnings,
      freshness: value.freshness, ...(value.data.kind === 'close' ? { valuationFallback: 'close' as const } : {}) }));
  },
});

/* ----------------------------- get_price_history ----------------------------- */

/** Sample standard deviation of the last 60 daily close-to-close returns; null below two returns. */
export function volatility(points: readonly { close: number }[]): { value: number | null; returns: number } {
  const returns = points.slice(1).map((p, i) => p.close / points[i].close - 1).slice(-VOLATILITY_RETURNS);
  if (returns.length < 2) return { value: null, returns: returns.length };
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  return { value: Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)), returns: returns.length };
}
const change = (first: number, last: number) => (last / first - 1) * 100;
/** The largest fall from a running high within the points, in percent (0 when the closes never fell below a high). */
export function maxDrawdownPct(points: readonly { close: number }[]): number {
  let peak = -Infinity, worst = 0;
  for (const p of points) { peak = Math.max(peak, p.close); worst = Math.min(worst, change(peak, p.close)); }
  return worst;
}
// A short period (a move question) may use the provider's daily closes when no current stored closes exist.
const RECENT_PERIOD_DAYS = 120;
const periodDays = (period: Period) => (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000;

type HistoryData = { points: HistoryPoint[]; volatility60d: number | null; benchmarkChangePct: number | null };
const historyInput = object({ ticker: tickerSchema, period: periodSchema, benchmark: { type: 'string', enum: ['SPX'] } }, ['ticker', 'period']);
const priceHistory = defineTool<{ ticker: string; period: Period; benchmark?: 'SPX' }, HistoryData>({
  name: 'get_price_history', group: 'trh',
  description: 'Daily closes in a period with the change, the first close and the largest fall from a high (percent), daily volatility (sample SD of the last 60 close-to-close returns, a ratio) and optional S&P 500 change (percent) over the same period. Missing history is reported, not filled.',
  inputSchema: historyInput, parse: parseWith(historyInput, a => checkPeriod(a.period)),
  outputSchema: open({ points: arrayOf(open({ date: { type: 'string' }, close: num, currency: { type: 'string' } }, ['date', 'close', 'currency'])),
    volatility60d: numOrNull, benchmarkChangePct: numOrNull }, ['points', 'volatility60d', 'benchmarkChangePct']),
  async run(args, ctx) {
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const read = toolRead(ctx);
    const closes = async () => {
      const stored = await ctx.market.history(ticker, args.period, read);
      if (stored.freshness === 'fresh' || periodDays(args.period) > RECENT_PERIOD_DAYS) return stored;
      const recent = await ctx.market.recentHistory(ticker, args.period, read);
      return recent.data && (!stored.data || recent.freshness === 'fresh') ? recent : stored;
    };
    const [history, bench] = await Promise.all([closes(), args.benchmark ? ctx.market.benchmark('SPX', args.period, read) : Promise.resolve(null)]);
    const points = history.data ?? [], benchmark = bench?.data ?? [];
    const vol = volatility(points);
    const data: HistoryData = { points, volatility60d: vol.value,
      benchmarkChangePct: benchmark.length > 1 ? change(benchmark[0].close_value, benchmark[benchmark.length - 1].close_value) : null };
    const warnings = [...history.warnings, ...(bench?.warnings ?? []).map(w => `benchmark:${w}`), `volatility_returns:${vol.returns}`];
    const sink = factSink(ctx, warnings);
    if (points.length) {
      const first = points[0], last = points[points.length - 1];
      const base = { source: history.source, as_of: last.date, ticker, period: { from: first.date, to: last.date } };
      sink.add(`history:${ticker}:last_close`, last.close, 'money', { ...base, currency: last.currency });
      if (points.length > 1) {
        sink.add(`history:${ticker}:change_pct`, change(first.close, last.close), 'percent', base);
        sink.add(`history:${ticker}:first_close`, first.close, 'money', { ...base, currency: first.currency });
        sink.add(`history:${ticker}:max_drawdown_pct`, maxDrawdownPct(points), 'percent', base);
      }
      sink.add(`history:${ticker}:volatility_60d`, data.volatility60d, 'ratio', base);
    }
    if (data.benchmarkChangePct !== null) {
      sink.add('history:SPX:change_pct', data.benchmarkChangePct, 'percent', { source: bench!.source, as_of: benchmark[benchmark.length - 1].date,
        ticker: 'SPX', period: { from: benchmark[0].date, to: benchmark[benchmark.length - 1].date } });
    }
    return success(ctx, data, sink.facts, meta({ snapshotId: marketSnapshotId(history), period: args.period, warnings,
      complete: points.length > 0 && (!args.benchmark || benchmark.length > 0),
      freshness: worst(history.freshness, bench?.freshness ?? 'fresh') }));
  },
});

/* ----------------------------- get_peers ----------------------------- */

export const MAX_PEERS = 4;
const peersInput = object({ ticker: tickerSchema }, ['ticker']);
const peers = defineTool<{ ticker: string }, PeerList & { ticker: string }>({
  name: 'get_peers', group: 'trh',
  description: 'Up to four comparable companies (peers) of a stock from the market data provider, else instruments of the same stored industry; other major coins for a coin.',
  inputSchema: peersInput, parse: parseWith(peersInput),
  outputSchema: open({ ticker: { type: 'string' }, peers: arrayOf({ type: 'string' }, 8), basis: { enum: ['provider', 'industry', 'crypto'] } }, ['ticker', 'peers', 'basis']),
  async run(args, ctx) {
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const value = await ctx.market.peers(ticker, toolRead(ctx));
    const list = [...new Set(value.data?.peers ?? [])].filter(p => p !== ticker && /^[A-Z][A-Z0-9.-]{0,19}$/.test(p)).slice(0, MAX_PEERS);
    if (!value.data || !list.length) return unavailable(`No peers are known for ${ticker}.`);
    // The provider named them: within this request they resolve like stored instruments (their closes can be read).
    addKnownTickers(ctx, list);
    const warnings = [...value.warnings], sink = factSink(ctx, warnings);
    sink.add(`peers:${ticker}:count`, list.length, 'count', { source: value.source, as_of: value.fetchedAt ?? value.asOf, ticker });
    return success(ctx, { ticker, peers: list, basis: value.data.basis }, sink.facts, meta({ snapshotId: marketSnapshotId(value), warnings,
      complete: true, freshness: value.freshness }));
  },
});

/* ----------------------------- get_analyst_view ----------------------------- */

const tickerInput = object({ ticker: tickerSchema }, ['ticker']);
const countsSchema = open({ strongBuy: numOrNull, buy: numOrNull, hold: numOrNull, sell: numOrNull, strongSell: numOrNull });
const analystView = defineTool<{ ticker: string }, AnalystView>({
  name: 'get_analyst_view', group: 'trh',
  description: 'Analyst OPINION for a stock: consensus, recommendation counts, price targets (mean/low/high; missing ones stay null) and recent rating changes. Present it as analysts\' opinion, not fact about the future.',
  inputSchema: tickerInput, parse: parseWith(tickerInput),
  outputSchema: open({ ticker: { type: 'string' }, consensus: strOrNull, counts: countsSchema, targetMean: numOrNull, targetLow: numOrNull,
    targetHigh: numOrNull, currency: strOrNull, changes: arrayOf(open({ date: { type: 'string' }, firm: { type: 'string' } }, ['date', 'firm'])) },
  ['ticker', 'consensus', 'counts', 'targetMean', 'targetLow', 'targetHigh', 'currency', 'changes']),
  async run(args, ctx) {
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const value = await ctx.market.analysts(ticker, toolRead(ctx));
    if (!value.data) return unavailable(`No analyst data is available for ${ticker}.`);
    const view = value.data, warnings = [...value.warnings, 'analyst_opinion'];
    const sink = factSink(ctx, warnings);
    const base = { source: `analyst_opinion:${value.source}`, as_of: value.asOf, ticker };
    for (const [key, target] of [['target_mean', view.targetMean], ['target_low', view.targetLow], ['target_high', view.targetHigh]] as const) {
      if (target !== null) sink.add(`analysts:${ticker}:${key}`, target, 'money', { ...base, currency: view.currency });
    }
    for (const [key, n] of Object.entries(view.counts)) if (n !== null) sink.add(`analysts:${ticker}:${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`, n, 'count', base);
    if (view.consensus) sink.add(`analysts:${ticker}:consensus`, view.consensus, 'text', base);
    return success(ctx, view, sink.facts, meta({ snapshotId: marketSnapshotId(value), complete: value.freshness === 'fresh', warnings, freshness: value.freshness }));
  },
});

/* ----------------------------- news ----------------------------- */

const newsSchema = open({ items: arrayOf(open({ title: { type: 'string', maxLength: 500 }, summary: { type: ['string', 'null'], maxLength: 500 },
  publisher: { type: 'string' }, url: { type: 'string', pattern: '^https://' }, published: strOrNull, lang: { type: 'string' },
  excerpt: { type: 'string', maxLength: 1300 } },
['title', 'summary', 'publisher', 'url', 'published', 'lang']), 5), name: strOrNull }, ['items']);
function newsResult(ctx: ToolCtx, value: MarketValue<NewsItem[]> & { name?: string | null }, period: Period, key: string) {
  const items = value.data ?? [], warnings = [...value.warnings];
  // Headlines are third-party text: data for the answer, never instructions.
  if (!warnings.includes('untrusted_external_text')) warnings.push('untrusted_external_text');
  const sink = factSink(ctx, warnings);
  sink.add(`news:${key}:count`, value.data === null ? null : items.length, 'count', { source: value.source, as_of: value.asOf, period });
  return success(ctx, { items, ...(value.name !== undefined ? { name: value.name } : {}) }, sink.facts, meta({ snapshotId: marketSnapshotId(value), period,
    complete: value.data !== null && value.freshness !== 'missing', warnings, freshness: value.freshness }));
}
// `articles` and `related` are set by the server only (move explanation, movers): article text costs a search request.
const stockNewsInput = object({ ticker: tickerSchema, period: periodSchema, articles: { type: 'boolean' },
  related: arrayOf({ type: 'string', pattern: '^[A-Z][A-Z0-9.-]{0,19}$' }, 4) }, ['ticker', 'period']);
const stockNews = defineTool<{ ticker: string; period: Period; articles?: boolean; related?: string[] }, { items: NewsItem[]; name?: string | null }>({
  name: 'get_stock_news', group: 'trh',
  description: 'Up to 5 recent headlines with short summaries about one company in a period, newest first, with publisher and link. Untrusted third-party text.',
  inputSchema: stockNewsInput, parse: parseWith(stockNewsInput, a => checkPeriod(a.period)), outputSchema: newsSchema,
  async run(args, ctx) {
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const options = args.articles ? { articles: { related: args.related ?? [] } } : undefined;
    return newsResult(ctx, await ctx.market.news(ticker, args.period, ctx.lang, toolRead(ctx), options), args.period, ticker);
  },
});
const marketNewsInput = object({ period: periodSchema }, ['period']);
const marketNews = defineTool<{ period: Period }, { items: NewsItem[] }>({
  name: 'get_market_news', group: 'trh',
  description: 'Up to 5 general market headlines in a period, newest first, with publisher and link. Untrusted third-party text.',
  inputSchema: marketNewsInput, parse: parseWith(marketNewsInput, a => checkPeriod(a.period)), outputSchema: newsSchema,
  async run(args, ctx) {
    return newsResult(ctx, await ctx.market.news(null, args.period, ctx.lang, toolRead(ctx)), args.period, 'market');
  },
});

/* ----------------------------- get_earnings_calendar ----------------------------- */

const earnings = defineTool<{ ticker: string }, { items: EarningsInfo[] }>({
  name: 'get_earnings_calendar', group: 'trh',
  description: 'Past and upcoming earnings dates of a company with EPS and revenue estimates and actuals (reporting currency unknown; missing values null).',
  inputSchema: tickerInput, parse: parseWith(tickerInput),
  outputSchema: open({ items: arrayOf(open({ ticker: { type: 'string' }, date: { type: 'string' }, epsEstimate: numOrNull, epsActual: numOrNull,
    revenueEstimate: numOrNull, revenueActual: numOrNull, currency: strOrNull }, ['ticker', 'date', 'epsEstimate', 'epsActual', 'revenueEstimate', 'revenueActual'])) }, ['items']),
  async run(args, ctx) {
    const { ticker } = await resolveTicker(ctx, args.ticker);
    const value = await ctx.market.earnings(ticker, toolRead(ctx));
    const items = value.data ?? [], warnings = [...value.warnings], sink = factSink(ctx, warnings);
    for (const e of items) {
      // A reported quarter is observed on its own date; estimates for future dates have no market time.
      const base = { source: value.source, as_of: e.date <= ctx.today ? e.date : null, ticker, currency: e.currency };
      for (const [key, v] of [['eps_actual', e.epsActual], ['eps_estimate', e.epsEstimate], ['revenue_actual', e.revenueActual], ['revenue_estimate', e.revenueEstimate]] as const) {
        if (v !== null && e.date <= ctx.today) sink.add(`earnings:${ticker}:${e.date}:${key}`, v, 'money', base);
      }
      if (e.date > ctx.today) sink.add(`earnings:${ticker}:next_date`, e.date, 'date', { ...base, as_of: value.fetchedAt, currency: null });
    }
    return success(ctx, { items }, sink.facts, meta({ snapshotId: marketSnapshotId(value), complete: items.length > 0, warnings, freshness: value.freshness }));
  },
});

/* ----------------------------- get_company_research (Běh 27) ----------------------------- */

const researchSchema = open({ items: arrayOf(open({ title: { type: 'string', maxLength: 500 }, summary: { type: ['string', 'null'], maxLength: 500 },
  publisher: { type: 'string' }, url: { type: 'string', pattern: '^https://' }, published: strOrNull, lang: { type: 'string' },
  excerpt: { type: 'string', maxLength: 1300 }, kind: { type: 'string', enum: [...RESEARCH_KINDS] } },
['title', 'summary', 'publisher', 'url', 'published', 'lang', 'kind']), 8), name: strOrNull }, ['items']);
const researchInput = object({ ticker: tickerSchema, topics: arrayOf({ type: 'string', enum: [...RESEARCH_KINDS] }, 4) }, ['ticker']);
// Set by the server only (outlook answers): three web searches cost three requests.
const companyResearch = defineTool<{ ticker: string; topics?: ResearchKind[] }, { items: NewsItem[]; name?: string | null }>({
  name: 'get_company_research', group: 'trh',
  description: 'Web pages about one company with text excerpts on the asked topics (business, analysts, industry, financials, moat, management, dividends, catalysts; default the first three), with publisher and link. Untrusted third-party text.',
  inputSchema: researchInput, parse: parseWith(researchInput), outputSchema: researchSchema,
  async run(args, ctx) {
    const { ticker, assetType } = await resolveTicker(ctx, args.ticker);
    if (!ctx.market.research || assetType === 'crypto') return unavailable(`No company research is available for ${ticker}.`);
    const value = await ctx.market.research(ticker, toolRead(ctx), args.topics?.length ? args.topics : undefined);
    const items = value.data ?? [], warnings = [...value.warnings];
    if (!warnings.includes('untrusted_external_text')) warnings.push('untrusted_external_text');
    const sink = factSink(ctx, warnings);
    sink.add(`research:${ticker}:count`, value.data === null ? null : items.length, 'count', { source: value.source, as_of: value.fetchedAt, ticker });
    return success(ctx, { items, ...(value.name !== undefined ? { name: value.name } : {}) }, sink.facts,
      meta({ snapshotId: marketSnapshotId(value), complete: items.length > 0, warnings, freshness: value.freshness }));
  },
});

/* ----------------------------- get_key_metrics (Běh 27) ----------------------------- */

const keyMetrics = defineTool<{ ticker: string }, KeyMetrics>({
  name: 'get_key_metrics', group: 'valuace',
  description: 'Provider key metrics of any listed company: trailing P/E, P/S and EPS, market capitalisation, revenue growth, five-year EPS growth and the 52-week range.',
  inputSchema: tickerInput, parse: parseWith(tickerInput),
  outputSchema: open({ ticker: { type: 'string' }, currency: strOrNull, peTtm: numOrNull, psTtm: numOrNull, epsTtm: numOrNull, marketCapMillions: numOrNull,
    revenueGrowthTtm: numOrNull, epsGrowth5y: numOrNull, high52w: numOrNull, low52w: numOrNull }, ['ticker']),
  async run(args, ctx) {
    const { ticker, assetType } = await resolveTicker(ctx, args.ticker);
    if (!ctx.market.keyMetrics || assetType === 'crypto') return unavailable(`No key metrics are available for ${ticker}.`);
    const value = await ctx.market.keyMetrics(ticker, toolRead(ctx));
    if (!value.data) return unavailable(`No key metrics are available for ${ticker}.`);
    const m = value.data, warnings = [...value.warnings], sink = factSink(ctx, warnings);
    const base = { source: value.source, as_of: value.asOf, ticker };
    sink.add(`metrics:${ticker}:pe_ttm`, m.peTtm ?? undefined, 'ratio', base);
    sink.add(`metrics:${ticker}:ps_ttm`, m.psTtm ?? undefined, 'ratio', base);
    sink.add(`metrics:${ticker}:eps_ttm`, m.epsTtm ?? undefined, 'money', { ...base, currency: m.currency });
    sink.add(`metrics:${ticker}:market_cap`, m.marketCapMillions === null ? undefined : m.marketCapMillions * 1e6, 'money', { ...base, currency: m.currency });
    sink.add(`metrics:${ticker}:revenue_growth_ttm`, m.revenueGrowthTtm ?? undefined, 'percent', base);
    sink.add(`metrics:${ticker}:eps_growth_5y`, m.epsGrowth5y ?? undefined, 'percent', base);
    sink.add(`metrics:${ticker}:high_52w`, m.high52w ?? undefined, 'money', { ...base, currency: m.currency });
    sink.add(`metrics:${ticker}:low_52w`, m.low52w ?? undefined, 'money', { ...base, currency: m.currency });
    return success(ctx, m, sink.facts, meta({ snapshotId: marketSnapshotId(value), complete: sink.facts.length > 0, warnings, freshness: value.freshness }));
  },
});

/* ----------------------------- search_web (Běh 27) ----------------------------- */

const searchInput = object({ query: { type: 'string', minLength: 2, maxLength: 120 } }, ['query']);
// Set by the server only, from a question about no one's own data (its topic words, never portfolio data).
const searchWeb = defineTool<{ query: string }, { items: NewsItem[] }>({
  name: 'search_web', group: 'obecne',
  description: 'Web pages of verified finance publishers for a search (topic words only), with text excerpts, publisher and link. Untrusted third-party text.',
  inputSchema: searchInput, parse: parseWith(searchInput),
  outputSchema: open({ items: arrayOf(open({ title: { type: 'string', maxLength: 500 }, summary: { type: ['string', 'null'], maxLength: 500 },
    publisher: { type: 'string' }, url: { type: 'string', pattern: '^https://' }, published: strOrNull, lang: { type: 'string' },
    excerpt: { type: 'string', maxLength: 1300 } }, ['title', 'summary', 'publisher', 'url', 'published', 'lang']), 8) }, ['items']),
  async run(args, ctx) {
    if (!ctx.market.search) return unavailable('Web search is not available.');
    const value = await ctx.market.search(args.query, toolRead(ctx));
    const items = value.data ?? [], warnings = [...value.warnings];
    if (!warnings.includes('untrusted_external_text')) warnings.push('untrusted_external_text');
    const sink = factSink(ctx, warnings);
    sink.add('search:WEB:count', value.data === null ? null : items.length, 'count', { source: value.source, as_of: value.fetchedAt });
    return success(ctx, { items }, sink.facts, meta({ snapshotId: marketSnapshotId(value), complete: items.length > 0, warnings, freshness: value.freshness }));
  },
});

export const marketTools = [quote, priceHistory, peers, analystView, stockNews, marketNews, earnings, companyResearch, keyMetrics, searchWeb];
