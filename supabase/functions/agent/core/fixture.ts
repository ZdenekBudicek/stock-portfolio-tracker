import demo from '../fixtures/demo.json' with { type: 'json' };
import type { CompanyFundamentals } from '../_lib/trackora-lib.js';
import type { Loaded, MarketHistory, Period, PortfolioSnapshot, ReadContext } from './dataTypes.ts';
import { articleExcerpt, nameKeywords } from './articleText.ts';
import { resolveMarketTicker } from './marketIdentity.ts';
import { type AnalystView, cachedQuoteTime, type EarningsInfo, type KeyMetrics, type MarketValue, type NewsItem, type Quote } from './marketTypes.ts';
import type { MarketSource, PortfolioRepo } from './ports.ts';

// Synthetic, deterministic data for tests, evals and the local runner: users A (CZ) and B (SK) with
// different portfolios, C (residence outside every tax model), D (CZ, purchase before the bundled ČNB
// rates, so its purchase FX stays missing) and E (an empty account); fixed time and seed. Nothing here
// comes from family exports.
export const FIXTURE_NOW: string = demo.now;
export const FIXTURE_TODAY: string = demo.today;
export type FixtureUser = 'A' | 'B' | 'C' | 'D' | 'E';
type User = FixtureUser;
type Json = Record<string, unknown>;
const market = demo.market as unknown as {
  quotes: Record<string, MarketValue<Quote>>; history: Record<string, { date: string; close: number }[]>;
  benchmark: Record<string, { date: string; close_value: number }[]>; fundamentals: Record<string, MarketValue<CompanyFundamentals>>;
  analysts: Record<string, MarketValue<AnalystView>>; news: Record<string, (NewsItem & { raw?: string })[]>; earnings: Record<string, EarningsInfo[]>;
  peers: Record<string, string[]>; names: Record<string, string>;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Json)) freeze(child);
  }
  return value;
}
function live(ctx: ReadContext): void {
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
const missing = <T>(source: string, warning: string): MarketValue<T> =>
  ({ data: null, source, asOf: null, fetchedAt: null, freshness: 'missing', warnings: [warning] });
const inPeriod = (date: string, period: Period) => date.slice(0, 10) >= period.from && date.slice(0, 10) <= period.to;

/** A fresh, mutable copy of a user's synthetic snapshot (tests may extend it). */
export function fixtureSnapshot(user: User): PortfolioSnapshot {
  return clone(demo.users[user]) as unknown as PortfolioSnapshot;
}

/** A repository over a fixed snapshot: deep-frozen, fixed `asOf`, explicit snapshot ID. */
export function snapshotRepo(snapshot: PortfolioSnapshot, snapshotId: string): PortfolioRepo {
  const loaded: Loaded<PortfolioSnapshot> = freeze({ data: clone(snapshot), meta: { asOf: FIXTURE_NOW, complete: true, warnings: [], snapshotId } });
  const history: Loaded<MarketHistory> = freeze({ data: {
    prices: Object.entries(market.history).flatMap(([symbol, points]) => points.map(p => ({ symbol, ...p }))),
    benchmarks: Object.entries(market.benchmark).flatMap(([symbol, points]) => points.map(p => ({ symbol, ...p }))),
  }, meta: { asOf: FIXTURE_NOW, complete: true, warnings: [], snapshotId: `${snapshotId}:history` } });
  return {
    load: async ctx => { live(ctx); return loaded; },
    loadHistory: async ctx => { live(ctx); return history; },
  };
}

export const fixtureRepo = (user: User): PortfolioRepo => snapshotRepo(fixtureSnapshot(user), `fixture-${user}`);

/** Market data as the live source would return it, including cache quotes dated by fetch time and gaps. */
export function fixtureMarket(): MarketSource {
  const up = (ticker: string) => ticker.trim().toUpperCase();
  const source: MarketSource = {
    async quote(ticker, ctx) {
      live(ctx);
      const value = market.quotes[up(ticker)];
      if (!value) return missing('none', 'quote_missing');
      // Cache rows are dated exactly as the live source dates them: by their provider fetch time.
      return value.source === 'price_cache' && value.fetchedAt
        ? { ...clone(value), ...cachedQuoteTime(value.fetchedAt, Date.parse(FIXTURE_NOW)) } : clone(value);
    },
    async history(ticker, period, ctx) {
      live(ctx);
      const points = (market.history[up(ticker)] ?? []).filter(p => inPeriod(p.date, period)).map(p => ({ ...p, currency: 'USD' }));
      if (!points.length) return missing('price_history', 'history_missing');
      return { data: points, source: 'price_history', asOf: points[points.length - 1].date, fetchedAt: null, freshness: 'fresh', warnings: [] };
    },
    async recentHistory(ticker, period, ctx) {
      // No provider in the fixture: the stored closes are the recent closes.
      return source.history(ticker, period, ctx);
    },
    async peers(ticker, ctx) {
      live(ctx);
      const peers = market.peers[up(ticker)];
      return peers?.length ? { data: { peers: [...peers], basis: 'provider' }, source: 'Finnhub', asOf: FIXTURE_NOW, fetchedAt: FIXTURE_NOW, freshness: 'fresh', warnings: [] }
        : missing('ticker_profiles', 'peers_missing');
    },
    async fundamentals(ticker, ctx) {
      live(ctx);
      const value = market.fundamentals[up(ticker)];
      return value ? clone(value) : missing('company_fundamentals', 'fundamentals_missing');
    },
    async analysts(ticker, ctx) {
      live(ctx);
      const value = market.analysts[up(ticker)];
      return value ? clone(value) : missing('analyst_snapshots', 'analysts_missing');
    },
    async news(ticker, period, _lang, ctx, options) {
      live(ctx);
      const symbol = ticker === null ? null : up(ticker);
      // With `articles`, each item carries an excerpt of its synthetic article text, cleaned like the live source's.
      const keywords = options?.articles && symbol ? nameKeywords(symbol, market.names[symbol] ?? null, options.articles.related ?? []) : null;
      const items = (market.news[symbol ?? '_market'] ?? [])
        .filter(item => !item.published || inPeriod(item.published, period))
        .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? '')).slice(0, 5)
        .map(({ raw, ...item }) => keywords ? { ...clone(item), excerpt: articleExcerpt(raw ?? item.summary, keywords) } : clone(item));
      const name = keywords && symbol ? { name: market.names[symbol] ?? null } : {};
      if (!items.length) return { ...missing<NewsItem[]>('stock_news', 'news_missing'), ...name };
      return { data: items, source: 'stock_news', asOf: items.find(i => i.published)?.published ?? null, fetchedAt: FIXTURE_NOW,
        freshness: 'fresh', warnings: ['untrusted_external_text'], ...name };
    },
    // Company research and key metrics (Běh 27): a synthetic overview page of every named company and metrics of every
    // quoted stock, derived from the fixture itself so no new data is invented per test.
    async research(ticker, ctx) {
      live(ctx);
      const symbol = up(ticker), name = market.names[symbol];
      if (!name) return { ...missing<NewsItem[]>('Tavily', 'research_missing'), name: null };
      const excerpt = `${name} develops synthetic products for testing and sells them to fixture customers worldwide. Its business model is recurring software revenue.`;
      return { data: [{ title: `What does ${name} do?`, summary: excerpt, publisher: 'Reuters', url: `https://www.reuters.com/companies/${symbol.toLowerCase()}-overview`,
        published: null, lang: 'original', excerpt, kind: 'business' }], source: 'Tavily', asOf: null, fetchedAt: FIXTURE_NOW, freshness: 'fresh',
        warnings: ['untrusted_external_text'], name };
    },
    // Web search (Běh 27): two synthetic pages for any query, so the answer path runs without a network.
    async search(query, ctx) {
      live(ctx);
      if (!query.trim()) return missing('Tavily', 'search_missing');
      const page = (n: number, publisher: string, host: string, text: string): NewsItem => ({ title: `Synthetic market explainer ${n}`, summary: text,
        publisher, url: `https://www.${host}/markets/synthetic-explainer-${n}`, published: '2026-10-20', lang: 'original', excerpt: text });
      return { data: [page(1, 'Reuters', 'reuters.com', 'Lower policy rates usually support stock valuations because future profits are discounted less. Analysts said markets had priced in a cut of 25 basis points.'),
        page(2, 'CNBC', 'cnbc.com', 'Cheaper borrowing helps companies with high debt, but a cut made because the economy is weakening can hurt profits. Investors watch inflation data closely.')],
        source: 'Tavily', asOf: null, fetchedAt: FIXTURE_NOW, freshness: 'fresh', warnings: ['untrusted_external_text'] };
    },
    async keyMetrics(ticker, ctx) {
      live(ctx);
      const symbol = up(ticker), quote = market.quotes[symbol]?.data;
      if (!quote || quote.currency !== 'USD') return missing('Finnhub', 'metrics_missing');
      const data: KeyMetrics = { ticker: symbol, currency: 'USD', peTtm: 20, psTtm: 5, epsTtm: Math.round(quote.price / 20 * 100) / 100,
        marketCapMillions: 10_000, revenueGrowthTtm: 12, epsGrowth5y: 10, high52w: quote.price * 1.2, low52w: quote.price * 0.8 };
      return { data, source: 'Finnhub', asOf: FIXTURE_NOW, fetchedAt: FIXTURE_NOW, freshness: 'fresh', warnings: [] };
    },
    async earnings(ticker, ctx) {
      live(ctx);
      const items = market.earnings[up(ticker)];
      if (!items?.length) return missing('earnings_calendar', 'earnings_missing');
      return { data: clone(items), source: 'earnings_calendar', asOf: null, fetchedAt: FIXTURE_NOW, freshness: 'fresh', warnings: ['currency_unknown'] };
    },
    async benchmark(symbol, period, ctx) {
      live(ctx);
      const data = (market.benchmark[symbol] ?? []).filter(p => inPeriod(p.date, period));
      if (!data.length) return missing('benchmark_history', 'history_missing');
      return { data: clone(data), source: 'benchmark_history', asOf: data[data.length - 1].date, fetchedAt: null, freshness: 'fresh', warnings: [] };
    },
    async resolveTicker(input, registry, ctx) {
      live(ctx);
      const local = resolveMarketTicker(input, registry);
      const ticker = up(input);
      // Mirrors the live source: stored statements prove an equity outside the registry.
      return local.status === 'unknown' && market.fundamentals[ticker] ? { status: 'resolved', ticker, assetType: 'stock' } : local;
    },
  };
  return source;
}
