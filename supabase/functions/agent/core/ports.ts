import type { Lang } from './protocol.ts';
import type { CompanyFundamentals, InstrumentRegistry } from '../_lib/trackora-lib.js';
import type { Period } from './dataTypes.ts';
import type { AnalystView, EarningsInfo, HistoryPoint, KeyMetrics, MarketValue, NewsItem, NewsOptions, PeerList, Quote, ResearchKind, TickerResolution } from './marketTypes.ts';
import type { Loaded, MarketHistory, PortfolioSnapshot, ReadContext, Reservation, RunMetrics, StoredAnswer, Thread, ThreadHistory } from './dataTypes.ts';

export type DbResult = { data: unknown; error: unknown; count?: number | null };
export type PortfolioTable = 'positions' | 'transactions' | 'dividends' | 'deposits' | 'daily_snapshots'
  | 'splits' | 'watchlist' | 'ticker_alias' | 'ticker_profiles' | 'user_settings' | 'price_history' | 'benchmark_history';
export type AgentRpc = 'get_broker_connection_status' | 'begin_agent_request' | 'complete_agent_request' | 'reserve_agent_resource' | 'delete_agent_thread';
export type MarketTable = 'price_cache' | 'company_fundamentals' | 'analyst_snapshots' | 'stock_news' | 'earnings_calendar';
export interface CallerQuery extends PromiseLike<DbResult> {
  select(columns: string, options?: { count?: 'exact'; head?: boolean }): CallerQuery;
  order(column: string, options?: { ascending: boolean }): CallerQuery;
  range(from: number, to: number): CallerQuery;
  eq(column: string, value: string): CallerQuery;
  abortSignal(signal: AbortSignal): CallerQuery;
}
export interface CallerDbClient {
  from(table: PortfolioTable | MarketTable | 'chat_messages' | 'agent_runs'): { select(columns: string, options?: { count?: 'exact'; head?: boolean }): CallerQuery };
  from(table: 'chat_threads'): { select(columns: string, options?: { count?: 'exact'; head?: boolean }): CallerQuery;
    delete(): CallerQuery };
  rpc(name: AgentRpc, args?: Record<string, unknown>): { abortSignal(signal: AbortSignal): PromiseLike<DbResult> };
}
export interface PortfolioRepo {
  load(ctx: ReadContext): Promise<Loaded<PortfolioSnapshot>>;
  loadHistory(ctx: ReadContext): Promise<Loaded<MarketHistory>>;
}
export type LiveOutcome = 'stored' | 'loaded' | 'unavailable';
export type LiveFetch = { fundamentals: LiveOutcome; analysts: LiveOutcome };
export interface MarketSource {
  quote(ticker: string, ctx: ReadContext): Promise<MarketValue<Quote>>;
  history(ticker: string, period: Period, ctx: ReadContext): Promise<MarketValue<HistoryPoint[]>>;
  /** Stored closes first; for a short period without current stored closes, the provider's daily closes (USD only). */
  recentHistory(ticker: string, period: Period, ctx: ReadContext): Promise<MarketValue<HistoryPoint[]>>;
  /** Comparable instruments (provider peers, else the same stored industry; other major coins for a coin). */
  peers(ticker: string, ctx: ReadContext): Promise<MarketValue<PeerList>>;
  fundamentals(ticker: string, ctx: ReadContext): Promise<MarketValue<CompanyFundamentals>>;
  analysts(ticker: string, ctx: ReadContext): Promise<MarketValue<AnalystView>>;
  /** Headlines with summaries; with `articles`, also article text (Tavily, Finnhub summaries as fallback) and the company name. */
  news(ticker: string | null, period: Period, lang: Lang, ctx: ReadContext, options?: NewsOptions): Promise<MarketValue<NewsItem[]> & { name?: string | null }>;
  earnings(ticker: string, ctx: ReadContext): Promise<MarketValue<EarningsInfo[]>>;
  /** Web research on a company (Běh 27): pages on its business, analyst expectations and its industry, with text. */
  research?(ticker: string, ctx: ReadContext, kinds?: readonly ResearchKind[]): Promise<MarketValue<NewsItem[]> & { name?: string | null }>;
  /** Web pages with text for a search built from a non-personal question's keywords (Běh 27). */
  search?(query: string, ctx: ReadContext): Promise<MarketValue<NewsItem[]>>;
  /** Provider key metrics of any listed company (Běh 27). */
  keyMetrics?(ticker: string, ctx: ReadContext): Promise<MarketValue<KeyMetrics>>;
  benchmark(symbol: 'SPX', period: Period, ctx: ReadContext): Promise<MarketValue<{ date: string; close_value: number }[]>>;
  /** Fetch a company's missing statements / analyst consensus right away (company-data edge function), once per
   * request; `fundamentals()` and `analysts()` call it themselves when nothing usable is stored. Never throws. */
  requestCompanyData?(ticker: string, ctx: ReadContext): Promise<LiveFetch>;
  resolveTicker(input: string, registry: InstrumentRegistry, ctx: ReadContext): Promise<TickerResolution>;
}
export interface AgentDb {
  begin(input: { requestId: string; threadId?: string; question: string; lang: Lang; fingerprint: string; executionToken: string }, ctx: ReadContext): Promise<Reservation>;
  complete(input: { requestId: string; executionToken: string; answer: StoredAnswer; metrics: RunMetrics }, ctx: ReadContext): Promise<void>;
  listThreads(ctx: ReadContext): Promise<Thread[]>;
  loadThread(id: string, ctx: ReadContext): Promise<ThreadHistory | null>;
  /** False when no own thread has this ID (foreign or missing): the route answers 404. */
  deleteThread(id: string, ctx: ReadContext): Promise<boolean>;
}
