import type { BrokerSummary, DbPosition, DbTransaction, DividendRecord, DisplayCurrency,
  InstrumentRegistry, RawSnapshot, TaxResidence } from '../_lib/trackora-lib.js';
import type { ChatMessage, Lang, Link, TraceItem } from './protocol.ts';
import type { AttemptAudit } from './llm.ts';

export type Scope = { broker: string; account: string } | { all: true };
export type Period = { from: string; to: string };
export type ReadMeta = { asOf: string; complete: boolean; warnings: string[]; snapshotId: string };
export type Loaded<T> = { data: T; meta: ReadMeta };
export type ReadContext = { signal: AbortSignal; deadline: number };
export type PortfolioSnapshot = {
  positions: DbPosition[];
  transactions: DbTransaction[];
  dividends: DividendRecord[];
  deposits: { date: string; amount_usd: number; broker: string | null; broker_account: string | null }[];
  snapshots: RawSnapshot[];
  splits: { ticker: string; split_date: string; ratio: number; status: string; applied_at: string | null }[];
  watchlist: { ticker: string; target_price_usd: number | null; note: string | null }[];
  registry: InstrumentRegistry;
  settings: { taxResidence: TaxResidence; baseCurrency: DisplayCurrency; storedProfiles: unknown };
  brokerSummary: BrokerSummary | null;
};
export type MarketHistory = {
  prices: { symbol: string; date: string; close: number }[];
  benchmarks: { symbol: string; date: string; close_value: number }[];
};
export type StoredAnswer = { text: string; links: Link[]; trace: TraceItem[]; lang: Lang;
  outcome: 'ok' | 'fallback' | 'timeout' | 'error'; verified: true;
  /** The answer's sections in reading order, each final when made (streamed as `section` events, Ocenění v3). */
  sections?: { key: string; order: number; text: string }[] };
export type Reservation =
  | { kind: 'accepted'; threadId: string; remainingToday: number }
  | { kind: 'replay'; threadId: string; answer: StoredAnswer; remainingToday: number }
  | { kind: 'busy' | 'quota' | 'conflict'; retryAt?: string; /** quota: 'shared' when the daily cap of all accounts is spent */ scope?: 'shared' };
export type Thread = { id: string; title: string; updatedAt: string };
export type ThreadHistory = { thread: Thread; messages: ChatMessage[] };
export type RunMetrics = { model: string | null; routerModel: string | null; tokensIn: number; tokensOut: number;
  attempts?: AttemptAudit[];
  maxCallTokens: number; toolCalls: number; toolsUsed: string[]; wallMs: number; ttftMs: number | null;
  outcome: string; groundingOk: boolean; calculationVersion: string; errorCode: string | null };
