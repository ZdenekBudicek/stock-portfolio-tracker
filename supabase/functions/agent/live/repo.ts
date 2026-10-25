import { toBrokerSummary } from '../_lib/trackora-lib.js';
import type { Loaded, MarketHistory, PortfolioSnapshot, ReadContext } from '../core/dataTypes.ts';
import type { CallerDbClient, PortfolioRepo } from '../core/ports.ts';
import manifest from '../_lib/manifest.json' with { type: 'json' };
import { HISTORY_LIMIT_MESSAGE } from '../core/workBudget.ts';
import { ToolInputError } from '../core/types.ts';
import { readWithinDeadline, scanRows, TooManyRows } from './paging.ts';

const tables = {
  positions: ['id,ticker,name,type,shares,avg_cost_usd,sector,holding_start_date', ['id']],
  transactions: ['id,ticker,side,shares,price_usd,fee_usd,executed_at,note,ext_id,broker,broker_account', ['executed_at', 'id']],
  dividends: ['id,ticker,ex_date,pay_date,amount_per_share,shares_held,total_amount_usd,gross_amount_usd,withholding_tax_usd,status,broker,broker_account,ext_id', ['id']],
  deposits: ['id,flow_date,amount_usd,broker,broker_account', ['id']],
  daily_snapshots: ['snapshot_date,value_usd,value_czk,profit_usd,profit_pct,profit_czk,fx_rate,cash_usd', ['snapshot_date']],
  splits: ['id,ticker,split_date,ratio,status,applied_at', ['id']],
  watchlist: ['id,ticker,target_price_usd,note', ['id']],
  ticker_alias: ['alias,canonical,yahoo_symbol', ['alias']],
  ticker_profiles: ['ticker,asset_type,sector', ['ticker']],
  user_settings: ['tax_residence,base_currency,tax_profile', ['user_id']],
  price_history: ['symbol,date,close', ['symbol', 'date']],
  benchmark_history: ['symbol,date,close_value', ['symbol', 'date']],
} as const;
type Table = keyof typeof tables;
// Audit A5: a history larger than the calculations accept is refused on the first page's count, before the rest is
// read, frozen and hashed (the 2 s Edge CPU limit cannot interrupt that work once it starts).
const policy = manifest.cpuPolicy as { maxTransactions: number; maxSnapshots: number };
const ROW_LIMITS: Partial<Record<Table, number>> = { transactions: policy.maxTransactions, daily_snapshots: policy.maxSnapshots };

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

async function stamp<T>(data: T, complete: boolean, warnings: string[]): Promise<Loaded<T>> {
  const asOf = new Date().toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify({ data, asOf }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const snapshotId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return freeze({ data, meta: { asOf, complete, warnings, snapshotId } });
}

export function createPortfolioRepo(client: CallerDbClient): PortfolioRepo {
  const portfolios = new WeakMap<ReadContext, Promise<Loaded<PortfolioSnapshot>>>();
  const histories = new WeakMap<ReadContext, Promise<Loaded<MarketHistory>>>();
  async function read<T>(names: Table[], map: (rows: Record<string, Record<string, unknown>[]>, ctx: ReadContext) => Promise<T>, ctx: ReadContext): Promise<Loaded<T>> {
    const warnings: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const rows: Record<string, Record<string, unknown>[]> = {};
      let changed = false;
      for (const name of names) {
        const [columns, keys] = tables[name];
        const result = await scanRows(() => client.from(name).select(columns, { count: 'exact' }), keys, ctx, ROW_LIMITS[name]).catch(error => {
          throw error instanceof TooManyRows ? new ToolInputError('unavailable', HISTORY_LIMIT_MESSAGE) : error;
        });
        rows[name] = result.rows;
        changed ||= result.changed;
      }
      const data = await map(rows, ctx);
      if (!changed) return stamp(data, true, warnings);
      if (attempt === 1) return stamp(data, false, [...warnings, 'Concurrent changes prevented a complete read']);
      warnings.push('Concurrent change detected; load repeated');
    }
  }
  async function portfolio(rows: Record<string, Record<string, unknown>[]>, ctx: ReadContext): Promise<PortfolioSnapshot> {
    const status = await readWithinDeadline(signal => client.rpc('get_broker_connection_status').abortSignal(signal), ctx);
    if (status.error || !Array.isArray(status.data)) throw new Error('Database read failed');
    if (rows.user_settings.length > 1) throw new Error('Invalid caller settings');
    const settings = rows.user_settings[0];
    if (settings && (!['CZ', 'SK', 'US', 'DE', 'GB', 'PL', 'OTHER'].includes(String(settings.tax_residence))
      || !['USD', 'CZK', 'EUR', 'GBP', 'PLN'].includes(String(settings.base_currency)))) throw new Error('Invalid caller settings');
    return {
      positions: rows.positions, transactions: rows.transactions, dividends: rows.dividends,
      deposits: rows.deposits.map(r => ({ date: r.flow_date, amount_usd: r.amount_usd, broker: r.broker, broker_account: r.broker_account })),
      snapshots: rows.daily_snapshots.map(r => ({ ...r, fxBasis: 'raw-czk' })),
      splits: rows.splits.map(({ id: _id, ...r }) => r), watchlist: rows.watchlist.map(({ id: _id, ...r }) => r),
      registry: { positions: rows.positions, aliases: rows.ticker_alias, profiles: rows.ticker_profiles },
      settings: { taxResidence: settings?.tax_residence ?? 'OTHER', baseCurrency: settings?.base_currency ?? 'USD', storedProfiles: settings?.tax_profile ?? {} },
      brokerSummary: toBrokerSummary(status.data.find(r => r.broker === 'T212')),
    } as unknown as PortfolioSnapshot;
  }
  return {
    load(ctx) {
      if (!portfolios.has(ctx)) portfolios.set(ctx, read(Object.keys(tables).filter(t => t !== 'price_history' && t !== 'benchmark_history') as Table[], portfolio, ctx));
      return portfolios.get(ctx)!;
    },
    loadHistory(ctx) {
      if (!histories.has(ctx)) histories.set(ctx, read(['price_history', 'benchmark_history'], async rows => ({
        prices: rows.price_history, benchmarks: rows.benchmark_history,
      } as MarketHistory), ctx));
      return histories.get(ctx)!;
    },
  };
}
