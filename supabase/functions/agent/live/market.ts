import type { CompanyFundamentals } from '../_lib/trackora-lib.js';
import { cryptoBase, CRYPTO_TO_GECKO } from '../../_shared/crypto.js';
import { parseBinance, parseCoinGecko, parseFinnhubQuote, parseTwelveData } from '../../_shared/price-parsers.ts';
import { articleExcerpt, articleRelevance, cleanArticleText, isQuotePage, nameKeywords, newsSearchQuery, publisherFromHost, RESEARCH_TOPIC,
  RESEARCH_WORDS } from '../core/articleText.ts';
import { companyName } from '../core/companyNames.ts';
import { PUBLISHER_HOSTS, RESEARCH_HOSTS } from '../core/guards.ts';
import type { Lang } from '../core/protocol.ts';
import type { Period, ReadContext } from '../core/dataTypes.ts';
import { type AnalystView, cachedQuoteTime, type EarningsInfo, type HistoryPoint, type KeyMetrics, type MarketValue, type NewsItem, type NewsOptions, type PeerList, type Quote, quoteFreshness,
  type ResearchKind,
  usdQuoteCurrency } from '../core/marketTypes.ts';
import { resolveMarketTicker, validTicker } from '../core/marketIdentity.ts';
import type { CallerDbClient, LiveFetch, LiveOutcome, MarketSource, MarketTable, PortfolioTable } from '../core/ports.ts';
import { marketFetch, marketOperation, marketPostJson } from './marketFetch.ts';
import { readAllPages, readWithinDeadline } from './paging.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NEWS_TTL = HOUR, ANALYST_TTL = DAY;
// Finnhub recommendation counts are monthly (period = first day of the month): the current or the
// previous month is current consensus, anything older is stale.
const ANALYST_PERIOD_MAX_AGE = 45 * DAY;
// Statements change quarterly: stale only past the workers' 30-day safety net or a missed reported quarter.
const FUNDAMENTALS_MAX_AGE = 30 * DAY, REPORTED_QUARTER_MAX = 80 * DAY;
// Providers stop this long before the 8 s tool deadline, so the stored fallback can still be read.
const DB_RESERVE_MS = 1500;
const COLLISIONS = new Set(['LTC', 'TRX', 'ATOM', 'APT', 'NEAR', 'LINK']);
// CZK rates are written to price_cache by the price job; no quote provider here serves them.
const CZK_PAIR = /^(USD|EUR|GBP|PLN)CZK$/;
const TEXT_MAX = 500, NEWS_MAX = 5;

// Peers and recent closes are public reference data: cached per isolate (never per user data), bounded in size.
const PEERS_TTL = DAY, SERIES_TTL = 30 * MINUTE, CACHE_MAX = 500, MAX_PEERS = 4;
const CRYPTO_PEERS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA'];
type Cached<T> = { at: number; value: MarketValue<T> };
const peerCache = new Map<string, Cached<PeerList>>(), seriesCache = new Map<string, Cached<HistoryPoint[]>>();
// Article search results (Tavily) per ticker and period for an hour: public news, never user data; text bounded per article.
type ArticleRow = { title: string; url: string; published: string | null; content: string | null; text: string };
// Tavily is asked for 8 candidates; the 5 most relevant (news about the company, recent) are kept (Běh 24).
const ARTICLES_TTL = HOUR, ARTICLE_RESULTS = 8, ARTICLE_TEXT_MAX = 20_000, ARTICLE_CACHE_MAX = 100;
const articleCache = new Map<string, Cached<ArticleRow[]>>();
// Company research (Běh 27): three web searches built from ticker and company name only, on verified publishers; per
// kind at most two pages with text. Key metrics from the provider. Both cached for six hours.
const RESEARCH_TTL = 6 * HOUR, RESEARCH_PER_KIND = 2;
const RESEARCH: readonly { kind: ResearchKind; query: (ticker: string, name: string) => string; topic: 'general' | 'news'; days?: number; max: number;
  domains?: readonly string[] }[] = [
  // What the company does: reference and profile pages (a profile path is what this search wants).
  { kind: 'business', query: (t, n) => `What does ${n} (${t}) do? Company overview, products, customers and business model`, topic: 'general', max: 6,
    domains: RESEARCH_HOSTS.business },
  // Analyst expectations: sites that report rating changes and targets (press-release wires are left out).
  { kind: 'analysts', query: (t, n) => `${n} (${t}) analysts price target consensus rating`, topic: 'news', days: 120, max: 6, domains: RESEARCH_HOSTS.analysts },
  { kind: 'industry', query: (t, n) => `${n} ${t} industry outlook market growth competition`, topic: 'news', days: 180, max: 6, domains: RESEARCH_HOSTS.industry },
  // Běh 31: searched only when a question asks for them.
  { kind: 'financials', query: (t, n) => `${n} (${t}) quarterly results revenue margins cash flow debt guidance`, topic: 'news', days: 150, max: 5, domains: RESEARCH_HOSTS.financials },
  { kind: 'moat', query: (t, n) => `${n} ${t} competitive advantage moat market share versus competitors`, topic: 'general', max: 5, domains: RESEARCH_HOSTS.moat },
  { kind: 'management', query: (t, n) => `${n} (${t}) CEO management insider buying selling major shareholders`, topic: 'news', days: 365, max: 5, domains: RESEARCH_HOSTS.management },
  { kind: 'dividends', query: (t, n) => `${n} (${t}) dividend yield payout ratio share buyback`, topic: 'general', max: 5, domains: RESEARCH_HOSTS.dividends },
  { kind: 'catalysts', query: (t, n) => `${n} (${t}) upcoming catalysts earnings date contracts launches approvals`, topic: 'news', days: 60, max: 5, domains: RESEARCH_HOSTS.catalysts },
];
/** The searches a question gets by default; at most four topics a question (four requests). */
const RESEARCH_DEFAULT: readonly ResearchKind[] = ['business', 'analysts', 'industry'], RESEARCH_MAX_KINDS = 4;
const researchCache = new Map<string, Cached<NewsItem[]>>(), metricsCache = new Map<string, Cached<KeyMetrics>>();
function remember<T>(cache: Map<string, Cached<T>>, key: string, value: MarketValue<T>, at: number): MarketValue<T> {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at, value });
  return value;
}
function recall<T>(cache: Map<string, Cached<T>>, key: string, now: number, ttl: number): MarketValue<T> | null {
  const hit = cache.get(key);
  return hit && now - hit.at >= 0 && now - hit.at < ttl ? hit.value : null;
}
/** Tests only: forget cached peers and closes. */
export function resetMarketCaches(): void { peerCache.clear(); seriesCache.clear(); articleCache.clear(); }

type Row = Record<string, unknown>;
/** `requestData`: the company-data edge function called as the signed-in user (its own quota and checks). */
type Deps = { fetchImpl: typeof fetch; now: () => number; keys: Readonly<Record<string, string>>;
  requestData?: (ticker: string, signal: AbortSignal) => Promise<Partial<LiveFetch> | null>;
  /** Takes one search of the running question's shared Tavily budget; absent in local runners (no shared budget). */
  reserveSearch?: (ctx: ReadContext) => Promise<boolean> };
/** SEC + Nasdaq take ~1–4 s; never longer than this, and always inside the tool deadline. */
const REQUEST_TIMEOUT_MS = 6_000;

// Explicit null for absent values: Number(null) would silently become a zero.
const num = (v: unknown): number | null => typeof v === 'number' ? (Number.isFinite(v) ? v : null)
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const positive = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const count = (v: unknown) => { const n = num(v); return n !== null && Number.isInteger(n) && n >= 0 ? n : null; };
const str = (v: unknown, max = 200) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const currencyOf = (v: unknown) => typeof v === 'string' && /^[A-Z]{3,4}$/.test(v) ? v : null;
const iso = (ms: number) => new Date(ms).toISOString();
const epochIso = (seconds: unknown) => { const n = positive(seconds); return n === null ? null : iso(n * 1000); };
const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null;
const time = (v: unknown) => typeof v === 'string' ? Date.parse(v) : NaN;
const inPeriod = (date: string, period: Period) => date.slice(0, 10) >= period.from && date.slice(0, 10) <= period.to;
const missing = <T>(source: string, warnings: string[]): MarketValue<T> => ({ data: null, source, asOf: null, fetchedAt: null, freshness: 'missing', warnings });
const pct = (price: number, prev: number | null) => prev ? (price - prev) / prev * 100 : null;

function sanitizeAnalysts(raw: unknown, ticker: string): AnalystView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Row, c = (r.counts && typeof r.counts === 'object' ? r.counts : {}) as Row;
  const changes = Array.isArray(r.changes) ? r.changes : [];
  const view: AnalystView = {
    ticker, consensus: str(r.consensus, 40),
    counts: { strongBuy: count(c.strongBuy), buy: count(c.buy), hold: count(c.hold), sell: count(c.sell), strongSell: count(c.strongSell) },
    targetMean: positive(r.targetMean), targetLow: positive(r.targetLow), targetHigh: positive(r.targetHigh),
    // Only a currency the worker took from the trading currency (`currencyBasis: 'trading'`) is the
    // currency of the targets; older rows carried financialCurrency (statements), which differs for ADRs.
    currency: r.currencyBasis === 'trading' ? currencyOf(r.currency) : null,
    changes: changes.flatMap(x => {
      const row = (x && typeof x === 'object' ? x : {}) as Row, date = day(row.date), firm = str(row.firm);
      return date && firm ? [{ date, firm, from: str(row.from, 40), to: str(row.to, 40) }] : [];
    }).slice(0, 20),
  };
  // Consensus estimates (Ocenění v2/v3): the current and next fiscal year plus up to two later years of EPS, every figure finite.
  const estimates = (Array.isArray(r.estimates) ? r.estimates : []).flatMap(x => {
    const e = (x && typeof x === 'object' ? x : {}) as Row;
    if (e.period !== 'current' && e.period !== 'next' && e.period !== 'later') return [];
    const item = { period: e.period as 'current' | 'next' | 'later', endDate: day(e.endDate), eps: num(e.eps), revenue: positive(e.revenue),
      epsGrowth: num(e.epsGrowth), revenueGrowth: num(e.revenueGrowth), analysts: count(e.analysts) };
    return item.eps === null && item.revenue === null ? [] : [item];
  }).slice(0, 4);
  if (estimates.length) { view.estimates = estimates; view.estimatesCurrency = currencyOf(r.estimatesCurrency); }
  const empty = view.targetMean === null && view.targetLow === null && view.targetHigh === null && Object.values(view.counts).every(n => n === null);
  return empty ? null : view;
}

// Only public https pages; no IP literals, local names, credentials or tracking parameters.
export function canonicalNewsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.')
    || /^[\d.]+$/.test(host) || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|guccounter|guce_)/i.test(key)) url.searchParams.delete(key);
  url.search = url.searchParams.toString() ? `?${url.searchParams}` : '';
  return url.toString();
}
const clip = (v: unknown) => typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : null;
const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Calendar days a news search must cover: from the period start to its end, inclusive (1–90). */
const searchDays = (period: Period) => Math.min(90, Math.max(1, Math.round((Date.parse(period.to) - Date.parse(period.from)) / DAY) + 1));

// A plain symbol as written by the user: 1–5 capital letters (an optional class suffix such as BRK.B).
const SYMBOL = /^[A-Z]{1,5}(?:\.[A-Z])?$/;
const NOT_SYMBOLS = new Set(['I', 'A', 'AI', 'CEO', 'ETF', 'USD', 'EUR', 'CZK', 'IPO', 'EPS', 'OK']);

export function createMarketSource(client: CallerDbClient, deps: Deps): MarketSource {
  const key = (name: string) => typeof deps.keys[name] === 'string' && deps.keys[name] ? deps.keys[name] : null;
  async function one(table: PortfolioTable | MarketTable, columns: string, column: string, value: string, ctx: ReadContext): Promise<Row | null> {
    const result = await readWithinDeadline(signal => client.from(table).select(columns).eq(column, value).abortSignal(signal), ctx);
    if (result.error || !Array.isArray(result.data) || result.data.length > 1) throw new Error('Database read failed');
    return (result.data[0] as Row | undefined) ?? null;
  }
  // Tavily's free credits are shared by every account: in production each search first takes a unit of the running
  // question's budget (deps.reserveSearch → reserve_agent_resource). Anything but an explicit grant — spent, refused,
  // an error, a missing function — means no search; the answer falls back to the headlines.
  async function tavilySearch(body: Record<string, unknown>, bearer: string, ctx: ReadContext): Promise<unknown> {
    if (deps.reserveSearch && await deps.reserveSearch(ctx).catch(() => false) !== true) throw new Error('Search budget unavailable');
    return marketPostJson('https://api.tavily.com/search', body, bearer, deps, ctx);
  }
  function all(table: PortfolioTable | MarketTable, columns: string, column: string, value: string, order: string, ctx: ReadContext): Promise<Row[]> {
    return readAllPages<Row>(async (from, to, signal) => {
      const result = await client.from(table).select(columns).eq(column, value).order(order, { ascending: true }).range(from, to).abortSignal(signal);
      return { data: result.data as Row[] | null, error: result.error };
    }, ctx);
  }
  // Each provider is tried in order within the shared provider budget; any failure moves on.
  async function firstOf<T>(ctx: ReadContext, attempts: ((ctx: ReadContext) => Promise<T | null>)[]): Promise<T | null> {
    const providerCtx = { signal: ctx.signal, deadline: ctx.deadline - DB_RESERVE_MS };
    for (const attempt of attempts) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException('Cancelled', 'AbortError');
      if (providerCtx.deadline - deps.now() <= 0) return null;
      try {
        const value = await attempt(providerCtx);
        if (value !== null) return value;
      } catch {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException('Cancelled', 'AbortError');
      }
    }
    return null;
  }
  // A provider answer: retrieved now (fetchedAt), valid at its own market time (asOf), fresh only by that time,
  // and only in USD (or USDT at par), as the UI stores prices; anything else is not used (null).
  const providerQuote = (kind: 'stock' | 'crypto', quote: Quote, currency: string | null, source: string, asOf: string | null,
    rejected: string[]): MarketValue<Quote> | null => {
    const usd = usdQuoteCurrency(currency);
    if ('warning' in usd) { rejected.push(usd.warning); return null; }
    const freshness = quoteFreshness(kind, asOf, deps.now());
    const warnings = [...(usd.ok ? usd.warnings : []), ...(asOf ? [] : ['market_time_unknown']), ...(asOf && freshness === 'stale' ? ['quote_outdated'] : [])];
    return { data: { ...quote, currency: 'USD' }, source, asOf, fetchedAt: iso(deps.now()), freshness, warnings };
  };

  async function stockProviders(ticker: string, ctx: ReadContext, rejected: string[]) {
    const finnhub = key('FINNHUB_API_KEY'), twelve = key('TWELVE_DATA_KEY');
    return firstOf<MarketValue<Quote>>(ctx, [
      async inner => {
        if (!finnhub) return null;
        const raw = await marketFetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${encodeURIComponent(finnhub)}`, deps, inner) as Row;
        const q = parseFinnhubQuote(ticker, raw);
        if (!q) return null;
        return providerQuote('stock', { ticker, price: q.price, currency: 'USD', previousClose: q.prev, changePct: num(raw.dp) ?? pct(q.price, q.prev), kind: 'quote' },
          'USD', 'Finnhub', epochIso(raw.t), rejected);
      },
      async inner => {
        if (!twelve) return null;
        const raw = await marketFetch(`https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${encodeURIComponent(twelve)}`, deps, inner) as Row;
        const q = parseTwelveData([ticker], raw).get(ticker);
        if (!q) return null;
        // A non-USD listing (EUR, GBP, GBp pence, …) is not used: it is not what the UI stores as USD.
        const currency = typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim() : null;
        return providerQuote('stock', { ticker, price: q.price, currency: 'USD', previousClose: q.prev, changePct: pct(q.price, q.prev), kind: 'quote' },
          currency, 'Twelve Data', epochIso(raw.timestamp), rejected);
      },
    ]);
  }
  async function cryptoProviders(ticker: string, base: string, ctx: ReadContext, rejected: string[]) {
    const id = CRYPTO_TO_GECKO[base];
    return firstOf<MarketValue<Quote>>(ctx, [
      async inner => {
        const raw = await marketFetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`, deps, inner) as Row;
        const q = parseCoinGecko({ [base]: id }, raw as Parameters<typeof parseCoinGecko>[1]).get(base);
        if (!q) return null;
        // The parser turns a missing 24h change into 0; only an explicit change is reported.
        const change = num((raw[id] as Row).usd_24h_change);
        return providerQuote('crypto', { ticker, price: q.price, currency: 'USD', previousClose: change === null ? null : q.prev, changePct: change, kind: 'quote' },
          'USD', 'CoinGecko', epochIso((raw[id] as Row).last_updated_at), rejected);
      },
      async inner => {
        const raw = await marketFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${base}USDT`, deps, inner) as Row;
        const q = parseBinance(base, raw);
        if (!q) return null;
        const close = positive(raw.closeTime);
        return providerQuote('crypto', { ticker, price: q.price, currency: 'USD', previousClose: positive(raw.prevClosePrice), changePct: num(raw.priceChangePercent), kind: 'quote' },
          'USDT', 'Binance', close === null ? null : iso(close), rejected);
      },
    ]);
  }
  async function storedClose(ticker: string, ctx: ReadContext, warnings: string[]): Promise<MarketValue<Quote>> {
    const rows = await all('price_history', 'symbol,date,close', 'symbol', ticker, 'date', ctx);
    const last = rows.map(r => ({ date: day(r.date), close: positive(r.close) })).filter(r => r.date && r.close !== null).pop();
    if (!last) return missing('none', [...warnings, 'quote_missing']);
    return { data: { ticker, price: last.close!, currency: 'USD', previousClose: null, changePct: null, kind: 'close' },
      source: 'price_history', asOf: last.date, fetchedAt: null, freshness: 'stale', warnings: [...warnings, 'last_stored_close'] };
  }
  async function fundamentalsRow(ticker: string, ctx: ReadContext) {
    return one('company_fundamentals', 'symbol,data,fetched_at,status', 'symbol', ticker, ctx);
  }
  /**
   * Article text for a news analysis: the company name from the shared profiles (or the coin's name), then a Tavily news
   * search built from ticker, name and period words only (never a question or portfolio data), cached for an hour.
   * The response is validated: https links of public hosts, titles, dates inside the period, text bounded per article.
   */
  /** The company (or coin) name: the shared profile, else the coin's or a popular company's built-in name. */
  async function nameOf(ticker: string, ctx: ReadContext): Promise<string | null> {
    let name: string | null = null;
    try { name = str((await one('ticker_profiles', 'ticker,name', 'ticker', ticker, ctx))?.name, 120); } catch { name = null; }
    const base = cryptoBase(ticker);
    if (!name && base && CRYPTO_TO_GECKO[base]) name = CRYPTO_TO_GECKO[base];
    // No stored profile (an instrument nobody holds): the built-in name of a popular company.
    return name ?? companyName(ticker);
  }
  async function searchArticles(ticker: string, period: Period, related: readonly string[], ctx: ReadContext) {
    const name = await nameOf(ticker, ctx);
    const keywords = nameKeywords(ticker, name, related.filter(t => validTicker(t)).slice(0, MAX_PEERS));
    const tavily = key('TAVILY_API_KEY');
    if (!tavily || COLLISIONS.has(ticker)) return { name, keywords, rows: [] as ArticleRow[] };
    const cacheKey = `${ticker}|${period.from}|${period.to}`;
    const cached = recall(articleCache, cacheKey, deps.now(), ARTICLES_TTL);
    if (cached?.data) return { name, keywords, rows: cached.data };
    const days = searchDays(period);
    const rows = await firstOf<ArticleRow[]>(ctx, [async provider => {
      const raw = await tavilySearch({ query: newsSearchQuery(ticker, name, days), topic: 'news', days,
        max_results: ARTICLE_RESULTS, include_raw_content: true, search_depth: 'basic' }, tavily, provider) as Row;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) return null;
      return (raw.results as unknown[]).slice(0, ARTICLE_RESULTS * 2).flatMap(x => {
        const r = (x && typeof x === 'object' ? x : {}) as Row;
        const url = canonicalNewsUrl(r.url), title = clip(r.title);
        const at = typeof r.published_date === 'string' ? Date.parse(r.published_date) : NaN;
        const published = Number.isFinite(at) ? iso(at) : null;
        if (!url || !title || (published && !inPeriod(published, period))) return [];
        const text = typeof r.raw_content === 'string' && r.raw_content.trim() ? r.raw_content.slice(0, ARTICLE_TEXT_MAX)
          : typeof r.content === 'string' ? r.content.slice(0, TEXT_MAX * 4) : '';
        return [{ title, url, published, content: clip(r.content), text }];
      }).slice(0, ARTICLE_RESULTS);
    }]);
    if (!rows) return { name, keywords, rows: [] as ArticleRow[] };
    if (articleCache.size >= ARTICLE_CACHE_MAX) articleCache.delete(articleCache.keys().next().value!);
    remember(articleCache, cacheKey, { data: rows, source: 'Tavily', asOf: null, fetchedAt: iso(deps.now()), freshness: 'fresh', warnings: [] }, deps.now());
    return { name, keywords, rows };
  }
  /** Per provider with a key: 'found' (it quotes the symbol), 'absent' (it answers that it has none) or 'failed'. */
  async function verifySymbol(ticker: string, finnhub: string | null, twelve: string | null, ctx: ReadContext): Promise<('found' | 'absent' | 'failed')[]> {
    const out: ('found' | 'absent' | 'failed')[] = [];
    const providerCtx = { signal: ctx.signal, deadline: ctx.deadline - DB_RESERVE_MS };
    const ask = async (url: string, judge: (raw: Row) => 'found' | 'absent') => {
      try { out.push(judge(await marketFetch(url, deps, providerCtx) as Row)); } catch {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException('Cancelled', 'AbortError');
        out.push('failed');
      }
    };
    if (finnhub) await ask(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(finnhub)}`,
      raw => positive(raw?.c) !== null ? 'found' : 'absent');
    if (!out.includes('found') && twelve) await ask(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(twelve)}`,
      raw => positive(raw?.close) !== null && typeof raw?.symbol === 'string' ? 'found' : 'absent');
    return out;
  }
  // Stored reads; the MarketSource methods below add the live fetch when nothing usable is stored.
  function readFundamentals(input: string, ctx: ReadContext): Promise<MarketValue<CompanyFundamentals>> {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const [row, earnings] = await Promise.all([fundamentalsRow(ticker, inner), earningsRows(ticker, inner)]);
        const data = row?.data as CompanyFundamentals | undefined;
        if (!row || !data || typeof data !== 'object' || data.status !== 'ok') return missing('company_fundamentals', ['fundamentals_missing']);
        const periods = [...(data.quarterly?.periods ?? []), ...(data.annual?.periods ?? [])].filter(p => day(p)).sort();
        const asOf = periods.length ? periods[periods.length - 1] : null;
        const fetched = time(row.fetched_at), now = deps.now();
        const today = iso(now).slice(0, 10);
        const reported = earnings.map(e => day(e.earnings_date)).filter((d): d is string => !!d && d <= today).pop();
        const newestQuarter = [...(data.quarterly?.periods ?? [])].sort().pop();
        const missedQuarter = !!reported && now - Date.parse(reported) > DAY && Number.isFinite(fetched) && fetched <= Date.parse(reported) + DAY
          && (!newestQuarter || Date.parse(newestQuarter) < Date.parse(reported) - REPORTED_QUARTER_MAX);
        const stale = row.status !== 'ok' || !Number.isFinite(fetched) || now - fetched >= FUNDAMENTALS_MAX_AGE || missedQuarter;
        return { data, source: 'company_fundamentals', asOf, fetchedAt: Number.isFinite(fetched) ? iso(fetched) : null,
          freshness: stale ? 'stale' : 'fresh', warnings: missedQuarter ? ['reported_quarter_missing'] : [] };
      });
    }
  function readAnalysts(input: string, ctx: ReadContext): Promise<MarketValue<AnalystView>> {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const row = await one('analyst_snapshots', 'symbol,data,fetched_at,last_attempt_at,status', 'symbol', ticker, inner);
        const view = sanitizeAnalysts(row?.data, ticker), fetched = time(row?.fetched_at);
        if (view && Number.isFinite(fetched)) {
          const stale = deps.now() - fetched >= ANALYST_TTL || deps.now() < fetched;
          // A stale snapshot keeps its targets; the count-only fallback is for symbols without one.
          return { data: view, source: 'analyst_snapshots', asOf: iso(fetched), fetchedAt: iso(fetched),
            freshness: stale ? 'stale' : 'fresh', warnings: stale ? ['analysts_stale'] : [] };
        }
        const finnhub = key('FINNHUB_API_KEY');
        const fallback = !finnhub || COLLISIONS.has(ticker) || cryptoBase(ticker) ? null : await firstOf<MarketValue<AnalystView>>(inner, [async provider => {
          const raw = await marketFetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${encodeURIComponent(finnhub)}`, deps, provider);
          const latest = (Array.isArray(raw) ? raw as Row[] : []).filter(r => day(r.period)).sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
          if (!latest) return null;
          const view = sanitizeAnalysts({ counts: latest }, ticker);
          // Finnhub has no free price targets: they stay null rather than being estimated. The counts are
          // valid for their month (asOf), not for the moment they were downloaded (fetchedAt).
          const asOf = day(latest.period)!, age = deps.now() - Date.parse(asOf);
          const stale = !(age >= 0 && age <= ANALYST_PERIOD_MAX_AGE);
          return view && { data: view, source: 'Finnhub', asOf, fetchedAt: iso(deps.now()), freshness: stale ? 'stale' : 'fresh',
            warnings: stale ? ['targets_unavailable', 'analysts_stale'] : ['targets_unavailable'] };
        }]);
        return fallback ?? missing('analyst_snapshots', ['analysts_missing']);
      });
    }

  // Ocenění v3: a company without usable stored data is fetched right away, once per request (statements + analyst consensus).
  const requests = new Map<string, Promise<LiveFetch>>();
  const none: LiveFetch = { fundamentals: 'unavailable', analysts: 'unavailable' };
  function requestCompanyData(input: string, ctx: ReadContext): Promise<LiveFetch> {
    const ticker = input.trim().toUpperCase();
    if (!deps.requestData || !validTicker(ticker) || COLLISIONS.has(ticker) || cryptoBase(ticker)) return Promise.resolve(none);
    let pending = requests.get(ticker);
    if (!pending) {
      pending = (async () => {
        try {
          // The request's own signal plus a short timeout: queueing never holds the answer up.
          const controller = new AbortController();
          const stop = () => controller.abort();
          ctx.signal.addEventListener('abort', stop, { once: true });
          const timer = setTimeout(stop, Math.max(0, Math.min(REQUEST_TIMEOUT_MS, ctx.deadline - deps.now() - DB_RESERVE_MS)));
          const out = await deps.requestData!(ticker, controller.signal)
            .finally(() => { clearTimeout(timer); ctx.signal.removeEventListener('abort', stop); });
          const outcome = (v: unknown): LiveOutcome => v === 'stored' || v === 'loaded' ? v : 'unavailable';
          return { fundamentals: outcome(out?.fundamentals), analysts: outcome(out?.analysts) };
        } catch {
          return none;
        }
      })();
      requests.set(ticker, pending);
    }
    return pending;
  }

  async function earningsRows(ticker: string, ctx: ReadContext) {
    return all('earnings_calendar', 'ticker,earnings_date,eps_estimate,eps_actual,revenue_estimate,revenue_actual,created_at', 'ticker', ticker, 'earnings_date', ctx);
  }

  return {
    requestCompanyData,
    quote(input, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const cached = await one('price_cache', 'symbol,price,prev_close,change_pct,fetched_at', 'symbol', ticker, inner);
        const price = positive(cached?.price), fetchedAt = time(cached?.fetched_at);
        const cache: MarketValue<Quote> | null = price === null || !Number.isFinite(fetchedAt) ? null : {
          data: { ticker, price, currency: CZK_PAIR.test(ticker) ? 'CZK' : 'USD', previousClose: positive(cached!.prev_close), changePct: num(cached!.change_pct), kind: 'quote' },
          // Dated by the provider fetch time (fresh up to 15 minutes), never by the time of this read.
          source: 'price_cache', fetchedAt: iso(fetchedAt), ...cachedQuoteTime(iso(fetchedAt), deps.now()),
        };
        if (cache?.freshness === 'fresh') return cache;
        if (CZK_PAIR.test(ticker)) return cache ? { ...cache, warnings: [...cache.warnings, 'fx_cache_only'] } : missing('price_cache', ['fx_missing']);
        const base = cryptoBase(ticker), rejected: string[] = [];
        // A coin-named ticker may be a security: without a resolved identity only stored data is used.
        const live = COLLISIONS.has(base ?? ticker) ? null
          : base && CRYPTO_TO_GECKO[base] ? await cryptoProviders(ticker, base, inner, rejected) : await stockProviders(ticker, inner, rejected);
        if (live?.freshness === 'fresh') return live;
        // Last good data wins: a stale provider answer only replaces an older (or no) cached price.
        if (live && !(cache && Date.parse(cache.asOf!) > Date.parse(live.asOf ?? ''))) return live;
        if (cache) return { ...cache, warnings: [...cache.warnings, ...rejected, 'refresh_failed'] };
        return storedClose(ticker, inner, [...rejected, 'refresh_failed']);
      });
    },
    history(input, period, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const points: HistoryPoint[] = (await all('price_history', 'symbol,date,close', 'symbol', ticker, 'date', inner)).flatMap(r => {
          const date = day(r.date), close = positive(r.close);
          return date && close !== null && inPeriod(date, period) ? [{ date, close, currency: 'USD' }] : [];
        });
        // Missing history is reported, never backfilled from Yahoo on the Edge.
        if (!points.length) return missing('price_history', ['history_missing']);
        const asOf = points[points.length - 1].date;
        const end = Math.min(Date.parse(period.to), deps.now());
        return { data: points, source: 'price_history', asOf, fetchedAt: null,
          freshness: end - Date.parse(asOf) <= 5 * DAY ? 'fresh' : 'stale', warnings: [] };
      });
    },
    recentHistory(input, period, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const points: HistoryPoint[] = (await all('price_history', 'symbol,date,close', 'symbol', ticker, 'date', inner)).flatMap(r => {
          const date = day(r.date), close = positive(r.close);
          return date && close !== null && inPeriod(date, period) ? [{ date, close, currency: 'USD' }] : [];
        });
        const end = Math.min(Date.parse(period.to), deps.now());
        const dated = (data: HistoryPoint[], source: string, fetchedAt: string | null): MarketValue<HistoryPoint[]> => {
          const asOf = data[data.length - 1].date;
          return { data, source, asOf, fetchedAt, freshness: end - Date.parse(asOf) <= 5 * DAY ? 'fresh' : 'stale', warnings: [] };
        };
        const stored = points.length ? dated(points, 'price_history', null) : null;
        const twelve = key('TWELVE_DATA_KEY');
        if (stored?.freshness === 'fresh' || !twelve || COLLISIONS.has(ticker) || cryptoBase(ticker)) return stored ?? missing('price_history', ['history_missing']);
        const cacheKey = `${ticker}|${period.from}|${period.to}`;
        const cached = recall(seriesCache, cacheKey, deps.now(), SERIES_TTL);
        if (cached) return cached;
        // The provider's end date is exclusive: ask one day past the period, keep only dates inside it.
        const endDate = iso(Date.parse(period.to) + DAY).slice(0, 10);
        const live = await firstOf<HistoryPoint[]>(inner, [async provider => {
          const raw = await marketFetch(`https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&start_date=${period.from}&end_date=${endDate}&outputsize=120&apikey=${encodeURIComponent(twelve)}`, deps, provider) as Row;
          const meta = (raw.meta && typeof raw.meta === 'object' ? raw.meta : {}) as Row;
          // Only USD closes, as the UI stores prices; a listing in another currency is not used.
          if ('warning' in usdQuoteCurrency(typeof meta.currency === 'string' && meta.currency.trim() ? meta.currency.trim() : null)) return null;
          const byDate = new Map<string, HistoryPoint>();
          for (const v of Array.isArray(raw.values) ? raw.values as Row[] : []) {
            const date = day(v.datetime), close = positive(v.close);
            if (date && close !== null && inPeriod(date, period)) byDate.set(date, { date, close, currency: 'USD' });
          }
          const data = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
          return data.length ? data : null;
        }]);
        if (!live) return stored ?? missing('price_history', ['history_missing']);
        return remember(seriesCache, cacheKey, dated(live, 'Twelve Data', iso(deps.now())), deps.now());
      });
    },
    peers(input, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const base = cryptoBase(ticker);
        if (base && CRYPTO_TO_GECKO[base] && !COLLISIONS.has(ticker)) {
          return { data: { peers: CRYPTO_PEERS.filter(t => t !== base).slice(0, MAX_PEERS), basis: 'crypto' }, source: 'Trackora', asOf: iso(deps.now()),
            fetchedAt: iso(deps.now()), freshness: 'fresh', warnings: [] };
        }
        const cached = recall(peerCache, ticker, deps.now(), PEERS_TTL);
        if (cached) return cached;
        const clean = (list: unknown[]) => [...new Set(list.filter((t): t is string => typeof t === 'string' && validTicker(t) && t !== ticker))].slice(0, MAX_PEERS);
        const finnhub = key('FINNHUB_API_KEY');
        const provider = !finnhub || COLLISIONS.has(ticker) ? null : await firstOf<string[]>(inner, [async attempt => {
          const raw = await marketFetch(`https://finnhub.io/api/v1/stock/peers?symbol=${ticker}&token=${encodeURIComponent(finnhub)}`, deps, attempt);
          const list = Array.isArray(raw) ? clean(raw) : [];
          return list.length ? list : null;
        }]);
        if (provider) {
          return remember(peerCache, ticker, { data: { peers: provider, basis: 'provider' }, source: 'Finnhub', asOf: iso(deps.now()), fetchedAt: iso(deps.now()),
            freshness: 'fresh', warnings: [] }, deps.now());
        }
        // Without the provider: instruments with the same stored industry (shared reference data any signed-in user may read).
        const industry = str((await one('ticker_profiles', 'ticker,industry_raw', 'ticker', ticker, inner))?.industry_raw, 200);
        const same = industry ? clean((await all('ticker_profiles', 'ticker,industry_raw', 'industry_raw', industry, 'ticker', inner)).map(r => r.ticker)) : [];
        return same.length ? { data: { peers: same, basis: 'industry' }, source: 'ticker_profiles', asOf: iso(deps.now()), fetchedAt: iso(deps.now()),
          freshness: 'fresh', warnings: [] } : missing('ticker_profiles', ['peers_missing']);
      });
    },
    async fundamentals(input, ctx) {
      const stored = await readFundamentals(input, ctx);
      if (stored.data || !deps.requestData) return stored;
      return (await requestCompanyData(input, ctx)).fundamentals === 'loaded' ? readFundamentals(input, ctx) : stored;
    },
    async analysts(input, ctx) {
      const stored = await readAnalysts(input, ctx);
      // The provider's count-only fallback or a stale snapshot: try the live consensus first.
      if ((stored.source === 'analyst_snapshots' && stored.freshness === 'fresh') || !deps.requestData) return stored;
      return (await requestCompanyData(input, ctx)).analysts === 'loaded' ? readAnalysts(input, ctx) : stored;
    },
    news(input, period, lang, ctx, options?: NewsOptions) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input === null ? null : input.trim().toUpperCase();
        if (ticker !== null && !validTicker(ticker)) return missing('none', ['invalid_ticker']);
        // Article text is asked for in parallel with the headlines: Tavily search (key in a header) for this ticker only.
        const articles = options?.articles && ticker ? searchArticles(ticker, period, options.articles.related ?? [], inner) : null;
        const row = ticker ? await one('stock_news', 'symbol,items,fetched_at', 'symbol', ticker, inner) : null;
        const stored = (Array.isArray(row?.items) ? row!.items as Row[] : []).map(item => {
          const translated = lang === 'cs' && clip(item.cs) && clip(item.cs) !== clip(item.en);
          return { title: clip(translated ? item.cs : item.en), summary: clip(translated ? item.sumCs : item.sumEn), publisher: str(item.publisher, 100),
            url: item.url, published: epochIso(item.ts), lang: (translated ? 'cs' : 'en') as NewsItem['lang'] };
        });
        const fetched = time(row?.fetched_at);
        let items = stored, source = 'stock_news', fetchedAt = Number.isFinite(fetched) ? iso(fetched) : null;
        let freshness: MarketValue<NewsItem[]>['freshness'] = Number.isFinite(fetched) && deps.now() - fetched < NEWS_TTL ? 'fresh' : 'stale';
        const finnhub = key('FINNHUB_API_KEY');
        if ((freshness === 'stale' || !stored.length) && finnhub && !(ticker && (COLLISIONS.has(ticker) || cryptoBase(ticker)))) {
          const url = ticker
            ? `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${period.from}&to=${period.to}&token=${encodeURIComponent(finnhub)}`
            : `https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(finnhub)}`;
          const live = await firstOf<Row[]>(inner, [async provider => {
            const raw = await marketFetch(url, deps, provider);
            return Array.isArray(raw) ? raw as Row[] : null;
          }]);
          if (live) {
            items = live.map(x => ({ title: clip(x.headline), summary: clip(x.summary), publisher: str(x.source, 100), url: x.url,
              published: epochIso(x.datetime), lang: 'original' as const }));
            source = 'Finnhub'; fetchedAt = iso(deps.now()); freshness = 'fresh';
          }
        }
        const found = articles ? await articles : null;
        type Candidate = { title: string | null; summary: string | null; publisher: string | null; url: unknown; published: string | null; lang: NewsItem['lang']; excerpt?: string };
        let candidates: Candidate[] = items;
        if (found) {
          // Articles with text first (Tavily), then the headlines with their summaries as text (Finnhub or stored).
          // The search snippet is page text too: cleaned like the article (furniture, profiles, links).
          candidates = [...found.rows.map(r => {
            const summary = clip(cleanArticleText(r.content).join(' '));
            return { title: r.title, summary, publisher: publisherFromHost(new URL(r.url).hostname), url: r.url, published: r.published, lang: 'original' as const,
              excerpt: articleExcerpt(r.text, found.keywords) || articleExcerpt(summary, found.keywords) };
          }),
          ...items.map(item => ({ ...item, excerpt: articleExcerpt(item.summary, found.keywords) }))];
          if (found.rows.length) { fetchedAt = iso(deps.now()); freshness = 'fresh'; if (!items.length) source = 'Tavily'; }
        }
        const seen = new Set<string>(), seenTitles = new Set<string>();
        const ranked = candidates.flatMap(item => {
          const url = canonicalNewsUrl(item.url);
          // Quote and profile pages carry prices and boilerplate, not reporting.
          if (url && isQuotePage(url)) return [];
          // Two sources (articles and headlines) report the same story under different links: then the title decides too.
          if (!url || !item.title || seen.has(url) || (found && seenTitles.has(normTitle(item.title))) || (item.published && !inPeriod(item.published, period))) return [];
          seen.add(url); seenTitles.add(normTitle(item.title));
          return [{ title: item.title, summary: item.summary, publisher: item.publisher ?? new URL(url).hostname, url, published: item.published, lang: item.lang,
            ...(item.excerpt !== undefined ? { excerpt: item.excerpt } : {}) }];
        });
        const byDate = (a: NewsItem, b: NewsItem) => (b.published ?? '').localeCompare(a.published ?? '');
        // Articles mode: only news about the instrument, its company or peers, the most relevant and recent first.
        const data = found
          ? ranked.map(item => ({ item, score: articleRelevance(item.title, item.excerpt || item.summary || '', found.keywords, item.published, period.to) }))
            .filter(x => x.score >= 0).sort((a, b) => b.score - a.score || byDate(a.item, b.item)).map(x => x.item).slice(0, NEWS_MAX)
          : ranked.sort(byDate).slice(0, NEWS_MAX);
        const name = found ? { name: found.name } : {};
        if (!data.length) return { ...missing<NewsItem[]>(source, ['news_missing']), ...name };
        // Headlines and article text are third-party text: callers must keep them out of instructions.
        return { data, source, asOf: data.find(x => x.published)?.published ?? null, fetchedAt, freshness, warnings: ['untrusted_external_text'], ...name };
      });
    },
    research(input, ctx, kinds = RESEARCH_DEFAULT) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        const wanted = RESEARCH.filter(r => kinds.includes(r.kind)).slice(0, RESEARCH_MAX_KINDS);
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const name = await nameOf(ticker, inner);
        const tavily = key('TAVILY_API_KEY');
        if (!tavily || COLLISIONS.has(ticker) || cryptoBase(ticker)) return { ...missing<NewsItem[]>('Tavily', ['research_missing']), name };
        const cacheKey = `${ticker}|${wanted.map(r => r.kind).join(',')}`;
        const cached = recall(researchCache, cacheKey, deps.now(), RESEARCH_TTL);
        if (cached?.data) return { ...cached, name };
        const keywords = nameKeywords(ticker, name, []);
        const lists = await Promise.all(wanted.map(r => firstOf<NewsItem[]>(inner, [async provider => {
          const raw = await tavilySearch({ query: r.query(ticker, name ?? ticker), topic: r.topic, ...(r.days ? { days: r.days } : {}),
            max_results: r.max, include_raw_content: true, search_depth: 'basic', include_domains: r.domains ?? PUBLISHER_HOSTS }, tavily, provider) as Row;
          if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) return null;
          return (raw.results as unknown[]).slice(0, r.max * 2).flatMap(x => {
            const row = (x && typeof x === 'object' ? x : {}) as Row;
            const url = canonicalNewsUrl(row.url), title = clip(row.title);
            // A profile page is what the business search wants; a quote or chart page never.
            if (!url || !title || (isQuotePage(url) && !(r.kind === 'business' && /\/(?:profile|company)(?:\/|$)/i.test(new URL(url).pathname)))) return [];
            const at = typeof row.published_date === 'string' ? Date.parse(row.published_date) : NaN;
            const text = typeof row.raw_content === 'string' && row.raw_content.trim() ? row.raw_content.slice(0, ARTICLE_TEXT_MAX) : '';
            const keep = r.kind === 'business', words = [...keywords, ...RESEARCH_WORDS[r.kind]];
            const summary = clip(cleanArticleText(typeof row.content === 'string' ? row.content : '', keep).join(' '));
            const excerpt = articleExcerpt(text, words, undefined, keep) || articleExcerpt(summary, words, undefined, keep);
            // A page found for a topic must be about it and about the company (a lawsuit notice is not analyst expectations;
            // a forecast page listing other stocks is not about this one).
            if (!excerpt || !RESEARCH_TOPIC[r.kind].test(`${title} ${excerpt}`) || !nameKeywords(ticker, name, []).some(k => excerpt.toLowerCase().includes(k.toLowerCase()))) return [];
            return [{ title, summary, publisher: publisherFromHost(new URL(url).hostname), url, published: Number.isFinite(at) ? iso(at) : null,
              lang: 'original' as const, excerpt, kind: r.kind }];
          }).slice(0, RESEARCH_PER_KIND);
        }])));
        const seen = new Set<string>();
        const data = lists.flatMap(list => list ?? []).filter(item => !seen.has(item.url) && seen.add(item.url));
        if (!data.length) return { ...missing<NewsItem[]>('Tavily', ['research_missing']), name };
        if (researchCache.size >= CACHE_MAX) researchCache.delete(researchCache.keys().next().value!);
        const value: MarketValue<NewsItem[]> = { data, source: 'Tavily', asOf: null, fetchedAt: iso(deps.now()), freshness: 'fresh', warnings: ['untrusted_external_text'] };
        remember(researchCache, cacheKey, value, deps.now());
        return { ...value, name };
      });
    },
    search(query, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const tavily = key('TAVILY_API_KEY'), text = query.trim().slice(0, 120);
        if (!tavily || !text) return missing('Tavily', ['search_missing']);
        const cached = recall(researchCache, `q:${text.toLowerCase()}`, deps.now(), HOUR);
        if (cached?.data) return cached;
        const words = text.split(/\s+/).filter(w => w.length >= 3);
        // Recent reporting and reference pages, both on verified publishers only.
        const lists = await Promise.all(([['news', 45], ['general', 0]] as const).map(([topic, days]) => firstOf<NewsItem[]>(inner, [async provider => {
          const raw = await tavilySearch({ query: text, topic, ...(days ? { days } : {}), max_results: 5,
            include_raw_content: true, search_depth: 'basic', include_domains: PUBLISHER_HOSTS }, tavily, provider) as Row;
          if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) return null;
          return (raw.results as unknown[]).slice(0, 10).flatMap(x => {
            const row = (x && typeof x === 'object' ? x : {}) as Row;
            const url = canonicalNewsUrl(row.url), title = clip(row.title);
            if (!url || !title || isQuotePage(url)) return [];
            const at = typeof row.published_date === 'string' ? Date.parse(row.published_date) : NaN;
            const body = typeof row.raw_content === 'string' && row.raw_content.trim() ? row.raw_content.slice(0, ARTICLE_TEXT_MAX) : '';
            const summary = clip(cleanArticleText(typeof row.content === 'string' ? row.content : '', true).join(' '));
            const excerpt = articleExcerpt(body, words, undefined, true) || articleExcerpt(summary, words, undefined, true);
            return excerpt ? [{ title, summary, publisher: publisherFromHost(new URL(url).hostname), url, published: Number.isFinite(at) ? iso(at) : null,
              lang: 'original' as const, excerpt }] : [];
          }).slice(0, 4);
        }])));
        const seen = new Set<string>();
        const data = lists.flatMap(list => list ?? []).filter(item => !seen.has(item.url) && seen.add(item.url));
        if (!data.length) return missing('Tavily', ['search_missing']);
        if (researchCache.size >= CACHE_MAX) researchCache.delete(researchCache.keys().next().value!);
        return remember(researchCache, `q:${text.toLowerCase()}`, { data, source: 'Tavily', asOf: null, fetchedAt: iso(deps.now()), freshness: 'fresh',
          warnings: ['untrusted_external_text'] }, deps.now());
      });
    },
    keyMetrics(input, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const finnhub = key('FINNHUB_API_KEY');
        if (!finnhub || COLLISIONS.has(ticker) || cryptoBase(ticker)) return missing('Finnhub', ['metrics_missing']);
        const cached = recall(metricsCache, ticker, deps.now(), RESEARCH_TTL);
        if (cached?.data) return cached;
        const raw = await firstOf<Row>(inner, [async provider => {
          const body = await marketFetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(finnhub)}`, deps, provider) as Row;
          return body && typeof body === 'object' && body.metric && typeof body.metric === 'object' ? body.metric as Row : null;
        }]);
        if (!raw) return missing('Finnhub', ['metrics_missing']);
        // Finnhub reports US listings in USD; other listings keep an unknown currency (no money figures are compared).
        const data: KeyMetrics = { ticker, currency: ticker.includes('.') ? null : 'USD', peTtm: positive(raw.peTTM ?? raw.peBasicExclExtraTTM),
          psTtm: positive(raw.psTTM), epsTtm: num(raw.epsTTM ?? raw.epsBasicExclExtraItemsTTM), marketCapMillions: positive(raw.marketCapitalization),
          revenueGrowthTtm: num(raw.revenueGrowthTTMYoy), epsGrowth5y: num(raw.epsGrowth5Y), high52w: positive(raw['52WeekHigh']), low52w: positive(raw['52WeekLow']) };
        if (Object.entries(data).every(([k, v]) => k === 'ticker' || k === 'currency' || v === null)) return missing('Finnhub', ['metrics_missing']);
        if (metricsCache.size >= CACHE_MAX) metricsCache.delete(metricsCache.keys().next().value!);
        return remember(metricsCache, ticker, { data, source: 'Finnhub', asOf: iso(deps.now()), fetchedAt: iso(deps.now()), freshness: 'fresh', warnings: [] }, deps.now());
      });
    },
    earnings(input, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const ticker = input.trim().toUpperCase();
        if (!validTicker(ticker)) return missing('none', ['invalid_ticker']);
        const rows = await earningsRows(ticker, inner);
        const data: EarningsInfo[] = rows.flatMap(r => {
          const date = day(r.earnings_date);
          return date ? [{ ticker, date, epsEstimate: num(r.eps_estimate), epsActual: num(r.eps_actual),
            revenueEstimate: num(r.revenue_estimate), revenueActual: num(r.revenue_actual), currency: null }] : [];
        });
        if (!data.length) return missing('earnings_calendar', ['earnings_missing']);
        const created = rows.map(r => time(r.created_at)).filter(Number.isFinite);
        return { data, source: 'earnings_calendar', asOf: null, fetchedAt: created.length ? iso(Math.max(...created)) : null,
          freshness: 'fresh', warnings: ['currency_unknown'] };
      });
    },
    benchmark(symbol, period, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const data = (await all('benchmark_history', 'symbol,date,close_value', 'symbol', symbol, 'date', inner)).flatMap(r => {
          const date = day(r.date), close_value = positive(r.close_value);
          return date && close_value !== null && inPeriod(date, period) ? [{ date, close_value }] : [];
        });
        if (!data.length) return missing('benchmark_history', ['history_missing']);
        const asOf = data[data.length - 1].date;
        return { data, source: 'benchmark_history', asOf, fetchedAt: null,
          freshness: Math.min(Date.parse(period.to), deps.now()) - Date.parse(asOf) <= 5 * DAY ? 'fresh' : 'stale', warnings: [] };
      });
    },
    resolveTicker(input, registry, ctx) {
      return marketOperation(ctx, deps.now, async inner => {
        const local = resolveMarketTicker(input, registry);
        if (local.status !== 'unknown') return local;
        const written = input.trim(), ticker = written.toUpperCase();
        // Outside the registry, stored statements prove an equity.
        if (validTicker(ticker) && (await fundamentalsRow(ticker, inner))?.status === 'ok') return { status: 'resolved', ticker, assetType: 'stock' };
        const finnhub = key('FINNHUB_API_KEY'), twelve = key('TWELVE_DATA_KEY');
        // Any symbol written as one (Běh 24): a provider quote proves it; "not found" from every provider refuses it;
        // with no provider able to check (no keys, failures) it is used with a warning instead of a question back.
        if (SYMBOL.test(written) && !NOT_SYMBOLS.has(written)) {
          const verdicts = await verifySymbol(ticker, finnhub, twelve, inner);
          if (verdicts.includes('found')) return { status: 'resolved', ticker, assetType: 'stock' };
          if (verdicts.length && verdicts.every(v => v === 'absent')) return local;
          return { status: 'resolved', ticker, assetType: 'stock', unverified: true };
        }
        // A company name (written capitalised) outside the built-in map: Finnhub symbol search (US listings, common stock or ETF).
        if (finnhub && /^\p{Lu}[\p{L}\p{N} .&'-]{2,39}$/u.test(written)) {
          const found = await firstOf<string>(inner, [async provider => {
            const raw = await marketFetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(written)}&token=${encodeURIComponent(finnhub)}`, deps, provider) as Row;
            const rows = Array.isArray(raw?.result) ? raw.result as Row[] : [];
            const words = written.toUpperCase().split(/\s+/).filter(w => w.length >= 3);
            const hit = rows.find(r => typeof r.symbol === 'string' && /^[A-Z]{1,5}$/.test(r.symbol) && /common stock|etp|etf/i.test(String(r.type ?? ''))
              && words.every(w => String(r.description ?? '').toUpperCase().includes(w)));
            return hit ? hit.symbol as string : null;
          }]);
          if (found) return { status: 'resolved', ticker: found, assetType: 'stock' };
        }
        return local;
      });
    },
  };
}
