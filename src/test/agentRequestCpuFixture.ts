import { runFifo } from '../lib/fifo.ts';
import type { DbTransaction } from '../lib/portfolioTypes.ts';
import type { DividendRecord } from '../lib/dividendTax.ts';
import type { Country } from '../lib/tax/engines.ts';
import type { PortfolioSnapshot } from '../../supabase/functions/agent/core/dataTypes.ts';
import { createInternationalFixture } from './agentPortfolioFixture.ts';

// Synthetic request-level CPU input (Běh 18): a whole family-sized snapshot as the repository would load it,
// over five years up to the fixture's today (2026-10-23). Deterministic, no real data. Tickers SYNA/SYNB/SYNC
// have quotes and history in the demo market fixture; SYN3–SYN7 do not (valued at cost, like a missing quote).
export const REQUEST_TODAY = '2026-10-23';
const TICKERS = ['SYNA', 'SYNB', 'SYNC', 'SYN3', 'SYN4', 'SYN5', 'SYN6', 'SYN7'];
const DAY = 86_400_000;
const START = Date.UTC(2021, 10, 1);
const day = (offset: number) => new Date(START + offset * DAY).toISOString().slice(0, 10);
const SPAN_DAYS = Math.round((Date.parse(`${REQUEST_TODAY}T00:00:00Z`) - START) / DAY);

export function createRequestCpuSnapshot(count: number, residence: 'CZ' | Country = 'CZ', snapshotDays = 731): PortfolioSnapshot {
  const transactions: DbTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const scope = i % 24, round = Math.floor(i / 24), sell = round % 4 === 3;
    transactions.push({ id: `synthetic-${String(i).padStart(6, '0')}`, ticker: TICKERS[scope % 8], side: sell ? 'SELL' : 'BUY',
      shares: sell ? 1 : 3, price_usd: 50 + scope + round / 10, fee_usd: 0.1, note: null, ext_id: `synthetic:trade:${i}`,
      executed_at: `${day(Math.floor(i * SPAN_DAYS / count))}T15:00:00Z`, broker: 'synthetic', broker_account: `fixture-${Math.floor(scope / 8)}` });
  }
  const held = new Map<string, number>();
  for (const lot of runFifo(transactions).openLots) held.set(lot.ticker, (held.get(lot.ticker) ?? 0) + lot.shares);
  const positions = [...held].map(([ticker, shares]) => ({ id: `pos-${ticker}`, ticker, name: `Synthetic ${ticker}`, type: 'Stock',
    shares, avg_cost_usd: 60, sector: null, holding_start_date: null }));
  positions.push({ id: 'pos-cash', ticker: 'CASH', name: 'Cash', type: 'Cash', shares: 500, avg_cost_usd: 1, sector: null, holding_start_date: null });
  const dividends: DividendRecord[] = [];
  for (let q = 0; q < 20; q++) {
    const month = new Date(START + (q * 91 + 40) * DAY).toISOString().slice(0, 8);
    TICKERS.forEach((ticker, t) => dividends.push({ id: `synthetic-div-${q}-${t}`, ticker, ex_date: `${month}10`, pay_date: `${month}15`,
      amount_per_share: 0.25, shares_held: 40, total_amount_usd: 10, status: 'paid', broker: 'manual', broker_account: null, ext_id: null }));
  }
  const snapshots = Array.from({ length: snapshotDays }, (_, i) => {
    const date = new Date(Date.parse(`${REQUEST_TODAY}T00:00:00Z`) - (snapshotDays - 1 - i) * DAY).toISOString().slice(0, 10);
    const fx = 22 + i / 1000, value = 10000 + i * 25;
    return { snapshot_date: date, value_usd: value, value_czk: value * fx, profit_usd: 0, profit_czk: 0, profit_pct: 0, fx_rate: fx,
      cash_usd: 500, fxBasis: 'raw-czk' as const };
  });
  const storedProfiles = residence === 'CZ' ? {} : createInternationalFixture(residence).storedProfiles;
  return { positions, transactions, dividends, deposits: [], snapshots, splits: [], watchlist: [],
    registry: { positions, aliases: [], profiles: [] },
    settings: { taxResidence: residence, baseCurrency: 'CZK', storedProfiles }, brokerSummary: null } as unknown as PortfolioSnapshot;
}
