// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAllPages } from '../../supabase/functions/agent/live/paging.ts';
import { createPortfolioRepo } from '../../supabase/functions/agent/live/repo.ts';
import { fakeCaller } from '../test/agentDbFake.ts';
import { runFifo, realizedUsd } from '@/lib/fifo';

const context = () => ({ signal: new AbortController().signal, deadline: Date.now() + 45000 });
const transactions = () => Array.from({ length: 2501 }, (_, i) => ({
  id: String(i).padStart(6, '0'), ticker: i === 0 || i === 2500 ? 'TEST' : `X${i}`,
  side: i === 2500 ? 'SELL' : 'BUY', shares: 1, price_usd: i === 2500 ? 150 : 100,
  fee_usd: 0, executed_at: i === 0 ? '2020-01-01T00:00:00Z' : '2026-10-01T00:00:00Z',
  note: null, ext_id: null, broker: 'manual', broker_account: 'synthetic',
}));
afterEach(() => vi.useRealTimers());

describe('complete caller-owned repository reads', () => {
  it('reads 2501 unique transactions with timestamp ties and keeps the old FIFO purchase', async () => {
    const fake = fakeCaller({ transactions: transactions().reverse() });
    fake.rpcResult.data = [];
    const loaded = await createPortfolioRepo(fake.client).load(context());
    expect(loaded.data.transactions).toHaveLength(2501);
    expect(new Set(loaded.data.transactions.map(t => t.id)).size).toBe(2501);
    expect(realizedUsd(runFifo(loaded.data.transactions))).toBe(50);
    expect(loaded.meta.complete).toBe(true);
    const pages = fake.reads.filter(r => r.table === 'transactions' && r.to - r.from === 999);
    expect(pages.map(r => r.from)).toEqual([0, 1000, 2000]);
    expect(pages.every(r => r.order.join(',') === 'executed_at,id')).toBe(true);
    expect(fake.reads.every(r => r.columns && !r.columns.includes('*') && !r.columns.includes('user_id'))).toBe(true);
    expect(fake.rpcCalls.map(r => r.name)).toEqual(['get_broker_connection_status']);
  });

  it('rejects the entire load on a second-page error, without exposing its payload', async () => {
    const fake = fakeCaller({ transactions: transactions() });
    fake.errors.set('transactions:1000', { message: 'sensitive database detail' });
    fake.rpcResult.data = [];
    await expect(createPortfolioRepo(fake.client).load(context())).rejects.toThrow('Database read failed');
  });

  it('pages registry, snapshots, dividends and both historical series completely', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), ticker: `X${i}`, alias: `X${i}`,
      canonical: `X${i}`, asset_type: 'stock', symbol: 'TEST', date: String(i).padStart(5, '0'),
      snapshot_date: String(i).padStart(5, '0'), close: 1, close_value: 2 }));
    const fake = fakeCaller(Object.fromEntries(['ticker_alias', 'ticker_profiles', 'daily_snapshots', 'dividends', 'price_history', 'benchmark_history'].map(t => [t, rows])));
    fake.rpcResult.data = [];
    const repo = createPortfolioRepo(fake.client), ctx = context();
    const result = await repo.load(ctx), history = await repo.loadHistory(ctx);
    expect(result.data.registry.aliases).toHaveLength(1001);
    expect(result.data.registry.profiles).toHaveLength(1001);
    expect(result.data.snapshots).toHaveLength(1001);
    expect(result.data.snapshots[0].fxBasis).toBe('raw-czk');
    expect(result.data.dividends).toHaveLength(1001);
    expect(history.data.prices).toHaveLength(1001);
    expect(history.data.benchmarks).toHaveLength(1001);
  });

  it('memoizes and freezes only within a request context; snapshot IDs include content and time', async () => {
    const fake = fakeCaller(); fake.rpcResult.data = [];
    const repo = createPortfolioRepo(fake.client), ctx = context();
    const [a, b] = await Promise.all([repo.load(ctx), repo.load(ctx)]);
    expect(a).toBe(b);
    expect(Object.isFrozen(a.data.transactions)).toBe(true);
    expect(() => a.data.transactions.push({} as never)).toThrow();
    fake.tables.watchlist = [{ id: '1', ticker: 'TEST', note: null, target_price_usd: 50 }];
    const c = await repo.load(context());
    expect(c.meta.snapshotId).not.toBe(a.meta.snapshotId);
    expect(c.data.watchlist[0].target_price_usd).toBe(50);
  });

  it('maps actual deposit/settings columns and chooses only exact T212 status', async () => {
    const fake = fakeCaller({ deposits: [{ id: '1', flow_date: '2026-01-01', amount_usd: 42, broker: 'manual', broker_account: null }],
      user_settings: [{ tax_residence: 'SK', base_currency: 'EUR', tax_profile: { 'SK-2026': {} } }] });
    fake.rpcResult.data = [{ broker: 'XT212', account_summary: { total: 999 } }, { broker: 'T212', account_summary: { total: 123 }, last_sync_at: '2026-01-01' }];
    const result = await createPortfolioRepo(fake.client).load(context());
    expect(result.data.deposits).toEqual([{ date: '2026-01-01', amount_usd: 42, broker: 'manual', broker_account: null }]);
    expect(result.data.settings).toEqual({ taxResidence: 'SK', baseCurrency: 'EUR', storedProfiles: { 'SK-2026': {} } });
    expect(result.data.brokerSummary?.total).toBe(123);
    fake.rpcResult.data = [{ broker: 'XT212', account_summary: { total: 999 } }];
    expect((await createPortfolioRepo(fake.client).load(context())).data.brokerSummary).toBeNull();
  });

  it('retries a detected concurrent change once and returns a complete fresh load', async () => {
    const fake = fakeCaller({ transactions: transactions() }); fake.rpcResult.data = [];
    let changed = false;
    fake.intercept((table, from) => { if (table === 'transactions' && from === 1000 && !changed) { changed = true; fake.tables.transactions.pop(); } });
    const result = await createPortfolioRepo(fake.client).load(context());
    expect(result.meta.complete).toBe(true);
    expect(result.data.transactions).toHaveLength(2500);
    expect(result.meta.warnings).toContain('Concurrent change detected; load repeated');
  });

  it('marks repeated concurrent changes incomplete rather than silently accepting partial data', async () => {
    const fake = fakeCaller({ transactions: transactions() }); fake.rpcResult.data = [];
    fake.intercept((table, from) => { if (table === 'transactions' && from === 1000) fake.tables.transactions.pop(); });
    const result = await createPortfolioRepo(fake.client).load(context());
    expect(result.meta.complete).toBe(false);
    expect(result.meta.warnings).toContain('Concurrent changes prevented a complete read');
  });

  it('detects same-count boundary edits, not only changed row counts', async () => {
    const fake = fakeCaller({ transactions: transactions() }); fake.rpcResult.data = [];
    let changed = false;
    fake.intercept((table, from) => { if (table === 'transactions' && from === 1000 && !changed) {
      changed = true; fake.tables.transactions[999].price_usd = 200;
    } });
    const result = await createPortfolioRepo(fake.client).load(context());
    expect(result.meta.warnings).toContain('Concurrent change detected; load repeated');
    expect(result.data.transactions[999].price_usd).toBe(200);
  });
});

describe('paging deadlines and failure semantics', () => {
  it('uses inclusive ranges of 1000 and requires a final empty page at an exact multiple', async () => {
    const page = vi.fn(async (from: number) => ({ data: from < 2000 ? Array(1000).fill(from) : [], error: null }));
    expect(await readAllPages(page, context())).toHaveLength(2000);
    expect(page.mock.calls.map(c => c[0])).toEqual([0, 1000, 2000]);
  });
  it('rejects null success data and oversized pages', async () => {
    for (const data of [null, Array(1001).fill(1)]) await expect(readAllPages(async () => ({ data, error: null }), context())).rejects.toThrow();
  });
  it('does no work after abort or deadline', async () => {
    const page = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(readAllPages(page, { signal: controller.signal, deadline: Date.now() + 1000 })).rejects.toThrow();
    await expect(readAllPages(page, { ...context(), deadline: Date.now() - 1 })).rejects.toThrow();
    expect(page).not.toHaveBeenCalled();
  });
  it('aborts a hanging page at the shared deadline even if the client ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    const work = readAllPages((_from, _to, s) => { signal = s; return new Promise(() => {}); }, { ...context(), deadline: Date.now() + 20 });
    const assertion = expect(work).rejects.toThrow('Deadline');
    await vi.advanceTimersByTimeAsync(20); await assertion;
    expect(signal!.aborted).toBe(true);
  });
});

describe('audit A5: an oversized history is refused before it is loaded', () => {
  it('stops on the first page of transactions with the history-limit message and reads no further page', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ ...transactions()[1], id: String(i).padStart(6, '0') }));
    const fake = fakeCaller({ transactions: many });
    fake.rpcResult.data = [];
    await expect(createPortfolioRepo(fake.client).load(context())).rejects.toThrow('Tuto rozsáhlou historii');
    expect(fake.reads.filter(r => r.table === 'transactions')).toHaveLength(1);
  });
});
