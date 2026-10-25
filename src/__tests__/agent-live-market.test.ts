import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMarketSource } from '../../supabase/functions/agent/live/market.ts';
import { marketFetch } from '../../supabase/functions/agent/live/marketFetch.ts';
import { RETRIEVAL_TIME_NOTE } from '../../supabase/functions/agent/core/marketTypes.ts';
import { fakeCaller } from '../test/agentDbFake';
import { marketContext, marketNow, marketRegistry } from '../test/agentMarketFixture';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function setup(tables = {}, fetchImpl: Mock<typeof fetch> = vi.fn(async () => json({})), keys = { FINNHUB_API_KEY: 'synthetic', TWELVE_DATA_KEY: 'synthetic' }) {
  const db = fakeCaller(tables);
  return { db, fetchImpl, source: createMarketSource(db.client, { fetchImpl, now: Date.now, keys }) };
}
afterEach(() => vi.useRealTimers());
describe('market sources', () => {
  function clock() { vi.useFakeTimers(); vi.setSystemTime(marketNow); }
  it('fetches a company without stored data right away (once per request) and reads it again', async () => {
    const tables: Record<string, Record<string, unknown>[]> = {};
    const db = fakeCaller(tables);
    const requestData = vi.fn(async (ticker: string) => {
      // The edge function writes both rows; the agent then reads them like any stored data.
      tables.company_fundamentals = [{ symbol: ticker, data: { symbol: ticker, currency: 'USD', status: 'ok', fetchedAt: new Date().toISOString(),
        annual: { periods: ['2025-12-31'], values: { revenue: [100] } }, quarterly: { periods: [], values: {} } }, currency: 'USD', fetched_at: new Date().toISOString(), status: 'ok' }];
      tables.analyst_snapshots = [{ symbol: ticker, data: { targetMean: 50, targetLow: 40, targetHigh: 60, currency: 'USD', currencyBasis: 'trading', counts: { buy: 3, hold: 1, sell: 0 }, changes: [],
        estimates: [{ period: 'next', endDate: '2027-12-31', eps: 2, revenue: null, epsGrowth: null, revenueGrowth: null, analysts: 5 }], estimatesCurrency: 'USD' },
        fetched_at: new Date().toISOString(), last_attempt_at: new Date().toISOString(), status: 'ok' }];
      return { fundamentals: 'loaded' as const, analysts: 'loaded' as const };
    });
    const source = createMarketSource(db.client, { fetchImpl: vi.fn(async () => json({})), now: Date.now, keys: {}, requestData });
    const ctx = { signal: new AbortController().signal, deadline: Date.now() + 8000 };
    const [f, a] = await Promise.all([source.fundamentals('NEWCO', ctx), source.analysts('NEWCO', ctx)]);
    expect(f.data?.symbol).toBe('NEWCO');
    expect(a).toMatchObject({ source: 'analyst_snapshots', data: { targetMean: 50, estimates: [{ eps: 2 }] } });
    expect(requestData).toHaveBeenCalledTimes(1);
    // Stored data: no live fetch; crypto never.
    expect((await source.fundamentals('NEWCO', ctx)).data).toBeTruthy();
    expect(requestData).toHaveBeenCalledTimes(1);
    expect(await source.requestCompanyData!('BTC', ctx)).toEqual({ fundamentals: 'unavailable', analysts: 'unavailable' });
    // A failing live fetch leaves the stored answer as it was.
    const failing = createMarketSource(fakeCaller({}).client, { fetchImpl: vi.fn(async () => json({})), now: Date.now, keys: {}, requestData: async () => { throw new Error('down'); } });
    expect((await failing.fundamentals('OTHER', ctx)).data).toBeNull();
  });
  it('resolves names and explicit coin spellings locally, including registry collisions', async () => {
    clock(); const { source, fetchImpl } = setup();
    for (const input of ['bitcoin', 'BTC-USD']) expect(await source.resolveTicker(input, marketRegistry, marketContext())).toEqual({ status: 'resolved', ticker: 'BTC', assetType: 'crypto' });
    for (const input of ['rklb', 'Rocket Lab']) expect(await source.resolveTicker(input, marketRegistry, marketContext())).toEqual({ status: 'resolved', ticker: 'RKLB', assetType: 'stock' });
    expect(await source.resolveTicker('nic', marketRegistry, marketContext())).toEqual({ status: 'unknown', candidates: [] });
    expect((await source.resolveTicker('LTC', marketRegistry, marketContext())).status).toBe('ambiguous');
    expect(await source.resolveTicker('LTC', { ...marketRegistry, profiles: [{ ticker: 'LTC', asset_type: 'stock' }] }, marketContext())).toEqual({ status: 'resolved', ticker: 'LTC', assetType: 'stock' });
    expect(await source.resolveTicker('LTC', { ...marketRegistry, profiles: [{ ticker: 'LTC', asset_type: 'crypto' }] }, marketContext())).toEqual({ status: 'resolved', ticker: 'LTC', assetType: 'crypto' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refreshes a 16-minute cache with the actual Finnhub market timestamp', async () => {
    clock(); const { source, fetchImpl } = setup({ price_cache: [{ symbol: 'RKLB', price: 10, fetched_at: new Date(marketNow - 960000).toISOString() }] }, vi.fn(async () => json({ c: 151, pc: 150, dp: null, t: marketNow / 1000 - 120 })));
    const result = await source.quote('RKLB', marketContext());
    expect(result).toMatchObject({ source: 'Finnhub', asOf: '2026-10-23T11:58:00.000Z', freshness: 'fresh', data: { price: 151, changePct: (151 - 150) / 150 * 100 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('dates a cache price by its provider fetch time, never by the time of reading the cache', async () => {
    clock(); const fetchedAt = new Date(marketNow - 5 * 60_000).toISOString();
    const { source, fetchImpl } = setup({ price_cache: [{ symbol: 'RKLB', price: 10, prev_close: null, change_pct: null, fetched_at: fetchedAt }] });
    const result = await source.quote('RKLB', marketContext());
    expect(result).toMatchObject({ source: 'price_cache', asOf: fetchedAt, fetchedAt, freshness: 'fresh', data: { previousClose: null, changePct: null } });
    expect(result.warnings).toEqual([RETRIEVAL_TIME_NOTE]);
    expect(result.asOf).not.toBe(new Date(marketNow).toISOString());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('treats a cache price exactly 15 minutes old as fresh and an older one as stale', async () => {
    clock(); const edge = new Date(marketNow - 15 * 60_000).toISOString();
    const atEdge = setup({ price_cache: [{ symbol: 'RKLB', price: 10, fetched_at: edge }] });
    expect(await atEdge.source.quote('RKLB', marketContext())).toMatchObject({ source: 'price_cache', asOf: edge, freshness: 'fresh' });
    expect(atEdge.fetchImpl).not.toHaveBeenCalled();
    const older = new Date(marketNow - 15 * 60_000 - 1000).toISOString();
    const failing = setup({ price_cache: [{ symbol: 'RKLB', price: 10, fetched_at: older }] }, vi.fn(async () => json({}, 500)));
    const stale = await failing.source.quote('RKLB', marketContext());
    expect(stale).toMatchObject({ source: 'price_cache', asOf: older, freshness: 'stale', data: { price: 10 } });
    expect(stale.warnings).toEqual(expect.arrayContaining([RETRIEVAL_TIME_NOTE, 'refresh_failed']));
  });
  it.each([json({}, 429), json({ error: 'provider' }), json({}), json({ c: 0, pc: 0 })])('uses Twelve Data after an unusable Finnhub response', async response => {
    clock(); const { source, fetchImpl } = setup({}, vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(json({ symbol: 'RKLB', close: '150', previous_close: '100', currency: 'USD', timestamp: marketNow / 1000 })));
    expect(await source.quote('RKLB', marketContext())).toMatchObject({ source: 'Twelve Data', data: { price: 150, currency: 'USD' } });
    expect(new URL(String(fetchImpl.mock.calls[1][0])).hostname).toBe('api.twelvedata.com');
  });
  it('preserves a stale cache after provider failures and falls back to dated closes otherwise', async () => {
    clock(); const cached = setup({ price_cache: [{ symbol: 'RKLB', price: 10, fetched_at: '2026-10-20T12:00:00Z' }] });
    expect(await cached.source.quote('RKLB', marketContext())).toMatchObject({ freshness: 'stale', data: { price: 10 } });
    const close = setup({ price_history: [{ symbol: 'RKLB', date: '2026-10-21', close: 12 }] });
    expect(await close.source.quote('RKLB', marketContext())).toMatchObject({ source: 'price_history', asOf: '2026-10-21', freshness: 'stale', data: { price: 12, kind: 'close' } });
    expect(await setup().source.quote('RKLB', marketContext())).toMatchObject({ data: null, freshness: 'missing' });
  });
  it('uses CoinGecko then Binance for crypto; values USDT at par in USD as the UI does, with a note', async () => {
    clock(); const cg = setup({}, vi.fn(async () => json({ bitcoin: { usd: 100, usd_24h_change: null, last_updated_at: marketNow / 1000 } })));
    expect(await cg.source.quote('BTC', marketContext())).toMatchObject({ source: 'CoinGecko', data: { currency: 'USD', price: 100, changePct: null } });
    const binance = setup({}, vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ lastPrice: '100', prevClosePrice: '90', priceChangePercent: '11', closeTime: marketNow })));
    expect(await binance.source.quote('BTC', marketContext())).toMatchObject({ source: 'Binance', data: { currency: 'USD' }, warnings: ['usdt_valued_as_usd'] });
  });
  it('ends the whole fallback chain within 8 seconds and forwards cancellation', async () => {
    clock(); let signal: AbortSignal | undefined;
    const { source, fetchImpl } = setup({ price_history: [{ symbol: 'RKLB', date: '2026-10-22', close: 12 }] }, vi.fn(async (_url, init) => { signal = init.signal; return await new Promise<Response>(() => {}); }));
    let settled: unknown;
    void source.quote('RKLB', marketContext()).then(v => { settled = v; });
    // A hanging provider is aborted early enough to still answer from the stored close inside 8 s.
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toMatchObject({ source: 'price_history', freshness: 'stale', data: { price: 12, kind: 'close' } });
    expect(signal?.aborted).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
    const hanging = setup({}, vi.fn(async () => await new Promise<Response>(() => {})));
    const outer = new AbortController();
    const cancelled = hanging.source.quote('RKLB', { ...marketContext(), signal: outer.signal });
    const rejection = expect(cancelled).rejects.toThrow(); outer.abort(); await rejection;
    const abort = new AbortController(); abort.abort();
    await expect(source.quote('RKLB', { ...marketContext(), signal: abort.signal })).rejects.toThrow();
  });
  it('pins provider paths, rejects redirects, caps streamed bytes and times out bodies', async () => {
    clock(); const fetchImpl = vi.fn(async () => json({}));
    await expect(marketFetch('https://query1.finance.yahoo.com/v8/finance/chart/BTC', { fetchImpl, now: Date.now }, marketContext())).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    const url = 'https://finnhub.io/api/v1/quote?symbol=RKLB';
    await expect(marketFetch(url, { fetchImpl: vi.fn(async (_url, init) => { expect(init?.redirect).toBe('error'); return new Response(null, { status: 302 }); }), now: Date.now }, marketContext())).rejects.toThrow();
    await expect(marketFetch(url, { fetchImpl: vi.fn(async () => new Response('x'.repeat(300000))), now: Date.now }, marketContext())).rejects.toThrow();
    let cancelled = false;
    const pending = marketFetch(url, { fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))), now: Date.now }, marketContext());
    const assertion = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(8000); await assertion; expect(cancelled).toBe(true);
  });
  it('does not send arbitrary input or ambiguous coin identities to providers', async () => {
    clock(); const { source, fetchImpl } = setup();
    for (const ticker of ['person@example.com', 'RKLB?account=123', 'https://evil.test', 'LTC']) expect((await source.quote(ticker, marketContext())).data).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reads full dated history and benchmarks, and never fetches missing history', async () => {
    clock(); const rows = Array.from({ length: 1001 }, (_, i) => ({ symbol: 'RKLB', date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10), close: i + 1 }));
    const { source, fetchImpl } = setup({ price_history: rows, benchmark_history: [{ symbol: 'SPX', date: '2026-10-22', close_value: 123 }] });
    expect((await source.history('RKLB', { from: '2023-01-01', to: '2026-10-23' }, marketContext())).data).toHaveLength(1001);
    expect((await source.history('EMPTY', { from: '2023-01-01', to: '2026-10-23' }, marketContext())).data).toBeNull();
    expect((await source.benchmark('SPX', { from: '2026-10-01', to: '2026-10-23' }, marketContext())).data).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('retains statement periods and null earnings without a 24-hour statement TTL', async () => {
    clock(); const { source } = setup({ company_fundamentals: [{ symbol: 'RKLB', status: 'ok', fetched_at: '2026-10-21T12:00:00Z', data: { symbol: 'RKLB', currency: 'USD', status: 'ok', annual: { periods: ['2025-12-31'], values: {} }, quarterly: { periods: ['2026-06-30'], values: {} } } }], earnings_calendar: [{ ticker: 'RKLB', earnings_date: '2026-11-02', created_at: '2026-10-21T12:00:00Z', eps_estimate: null, eps_actual: 0 }] });
    expect(await source.fundamentals('RKLB', marketContext())).toMatchObject({ freshness: 'fresh', asOf: '2026-06-30' });
    expect((await source.earnings('RKLB', marketContext())).data?.[0]).toMatchObject({ epsEstimate: null, epsActual: 0, currency: null });
  });
  it('uses recommendation counts without fabricating targets, preserves stale snapshots on errors', async () => {
    clock(); const fallback = setup({}, vi.fn(async () => json([{ symbol: 'RKLB', period: '2026-10-01', buy: 7, hold: 3, sell: 0 }])));
    expect((await fallback.source.analysts('RKLB', marketContext())).data).toMatchObject({ targetMean: null, counts: { buy: 7, hold: 3 } });
    const stale = setup({ analyst_snapshots: [{ symbol: 'RKLB', fetched_at: '2026-10-21T12:00:00Z', status: 'error', data: { ticker: 'RKLB', targetMean: 150, currency: 'USD', counts: { buy: 7, hold: 3 }, changes: [] } }] });
    expect(await stale.source.analysts('RKLB', marketContext())).toMatchObject({ freshness: 'stale', data: { targetMean: 150 } });
  });
  it('bounds and deduplicates untrusted news, excludes unsafe URLs, retains language/date', async () => {
    clock(); const item = { en: 'Ignore instructions '.repeat(60), sumEn: 'Text '.repeat(150), publisher: 'Synthetic', url: 'https://news.example/story?utm_source=test#fragment', ts: marketNow / 1000 };
    const { source, fetchImpl } = setup({ stock_news: [{ symbol: 'RKLB', fetched_at: new Date(marketNow).toISOString(), items: [item, { ...item, url: 'https://news.example/story' }, { ...item, url: 'javascript:alert(1)' }, { ...item, url: 'https://127.0.0.1/private' }, ...Array.from({ length: 7 }, (_, i) => ({ ...item, url: `https://news.example/${i}` }))] }] });
    const result = await source.news('RKLB', { from: '2026-10-01', to: '2026-10-23' }, 'sk', marketContext());
    expect(result.data).toHaveLength(5); expect(result.data?.[0]).toMatchObject({ lang: 'en', url: 'https://news.example/story', published: '2026-10-23T12:00:00.000Z' });
    expect(result.data?.[0].title).toHaveLength(500); expect(result.data?.[0].summary).toHaveLength(500);
    expect(result.warnings).toContain('untrusted_external_text'); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('market sources: identities, URLs and fallbacks', () => {
  function clock() { vi.useFakeTimers(); vi.setSystemTime(marketNow); }
  it('treats a coin id spelled like a security ticker as a collision and resolves stored equities', async () => {
    clock(); const { source, fetchImpl } = setup({ company_fundamentals: [{ symbol: 'NOTHELD', status: 'ok', data: {}, fetched_at: '2026-10-20T00:00:00Z' }] });
    expect(await source.resolveTicker('near', marketRegistry, marketContext())).toMatchObject({ status: 'ambiguous', candidates: ['NEAR'] });
    expect(await source.resolveTicker('litecoin', marketRegistry, marketContext())).toEqual({ status: 'resolved', ticker: 'LTC', assetType: 'crypto' });
    expect(await source.resolveTicker('notheld', marketRegistry, marketContext())).toEqual({ status: 'resolved', ticker: 'NOTHELD', assetType: 'stock' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('sends only the validated ticker and key to pinned hosts, never Yahoo', async () => {
    clock(); const { source, fetchImpl } = setup();
    await source.quote(' rklb ', marketContext()); await source.quote('BTC', marketContext());
    await source.analysts('RKLB', marketContext()); await source.news('RKLB', { from: '2026-10-01', to: '2026-10-23' }, 'cs', marketContext());
    const urls = fetchImpl.mock.calls.map(c => new URL(String(c[0])));
    expect(urls.map(u => u.hostname)).toEqual(['finnhub.io', 'api.twelvedata.com', 'api.coingecko.com', 'api.binance.com', 'finnhub.io', 'finnhub.io']);
    expect(urls.every(u => !/yahoo/.test(u.hostname))).toBe(true);
    expect(urls[0].search).toBe('?symbol=RKLB&token=synthetic');
    expect(urls[3].search).toBe('?symbol=BTCUSDT');
  });
  it('reads a coin-named ticker without an identity only from stored data', async () => {
    clock(); const { source, fetchImpl } = setup({ price_cache: [{ symbol: 'LTC', price: 80, fetched_at: '2026-10-20T00:00:00Z' }] });
    expect(await source.quote('LTC', marketContext())).toMatchObject({ source: 'price_cache', asOf: '2026-10-20T00:00:00.000Z', freshness: 'stale', data: { price: 80 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reads CZK exchange-rate pairs only from the cache, never from stock providers', async () => {
    clock(); const { source, fetchImpl } = setup({ price_cache: [{ symbol: 'USDCZK', price: 23.5, fetched_at: '2026-10-22T00:00:00Z' }] });
    const rate = await source.quote('USDCZK', marketContext());
    expect(rate).toMatchObject({ source: 'price_cache', asOf: '2026-10-22T00:00:00.000Z', freshness: 'stale', data: { price: 23.5, currency: 'CZK' } });
    expect(rate.warnings).toContain(RETRIEVAL_TIME_NOTE);
    expect((await source.quote('EURCZK', marketContext())).data).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('labels a missing Finnhub market time and keeps the explicit daily change', async () => {
    clock(); const { source } = setup({}, vi.fn(async () => json({ c: 10, pc: 8, dp: 25, t: 0 })));
    expect(await source.quote('RKLB', marketContext())).toMatchObject({ asOf: null, warnings: ['market_time_unknown'], data: { changePct: 25, previousClose: 8 } });
  });
  it('reports CoinGecko without a 24h change as null, not zero', async () => {
    clock(); const { source } = setup({}, vi.fn(async () => json({ bitcoin: { usd: 100 } })));
    expect(await source.quote('BTC', marketContext())).toMatchObject({ asOf: null, data: { previousClose: null, changePct: null } });
  });
  it('refreshes stale news from Finnhub and keeps the stored news on a provider failure', async () => {
    clock(); const stored = { stock_news: [{ symbol: 'RKLB', fetched_at: '2026-10-23T09:00:00Z', items: [{ en: 'Stored', cs: 'Uložená', sumEn: 'S', sumCs: 'U', publisher: 'P', url: 'https://news.example/a', ts: marketNow / 1000 - 3600 }] }] };
    const live = setup(structuredClone(stored), vi.fn(async () => json([{ headline: 'Live', summary: null, source: 'Wire', url: 'https://wire.example/b', datetime: marketNow / 1000 }])));
    expect(await live.source.news('RKLB', { from: '2026-10-01', to: '2026-10-23' }, 'cs', marketContext())).toMatchObject({ source: 'Finnhub', freshness: 'fresh', data: [{ title: 'Live', summary: null, lang: 'original' }] });
    const failed = setup(structuredClone(stored), vi.fn(async () => json({}, 429)));
    expect(await failed.source.news('RKLB', { from: '2026-10-01', to: '2026-10-23' }, 'cs', marketContext())).toMatchObject({ source: 'stock_news', freshness: 'stale', data: [{ title: 'Uložená', lang: 'cs' }] });
  });
  it('drops earnings rows without a date and reports missing analysts instead of zeros', async () => {
    clock(); const { source } = setup({ earnings_calendar: [{ ticker: 'RKLB', earnings_date: null, eps_actual: 1 }] }, vi.fn(async () => json([])));
    expect(await source.earnings('RKLB', marketContext())).toMatchObject({ data: null, freshness: 'missing' });
    expect(await source.analysts('RKLB', marketContext())).toMatchObject({ data: null, freshness: 'missing' });
  });
  it('marks statements stale when a reported quarter is still missing, not merely after 24 hours', async () => {
    clock(); const data = { symbol: 'RKLB', currency: 'USD', status: 'ok', annual: { periods: ['2025-12-31'], values: {} }, quarterly: { periods: ['2026-03-31'], values: {} } };
    const { source } = setup({ company_fundamentals: [{ symbol: 'RKLB', status: 'ok', fetched_at: '2026-09-30T00:00:00Z', data }], earnings_calendar: [{ ticker: 'RKLB', earnings_date: '2026-10-10' }] });
    expect(await source.fundamentals('RKLB', marketContext())).toMatchObject({ freshness: 'stale', warnings: ['reported_quarter_missing'], fetchedAt: '2026-09-30T00:00:00.000Z' });
  });
});

describe('market destinations', () => {
  // Every provider URL the market source builds must pass the pinned allowlist; a missing path was
  // swallowed as "no data" (Finnhub /stock/metric: P/E, EPS and growth silently missing).
  it('allows every GET endpoint written in live/market.ts', async () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/agent/live/market.ts'), 'utf8');
    const urls = [...source.matchAll(/`(https:\/\/[^`?]+)\?/g)].map(m => m[1].replace(/\$\{[^}]+\}/g, 'X'));
    expect(urls.length).toBeGreaterThan(5);
    for (const url of new Set(urls)) {
      const fetchImpl = vi.fn(async () => json({}));
      await expect(marketFetch(`${url}?symbol=X`, { fetchImpl, now: Date.now }, { signal: new AbortController().signal, deadline: Date.now() + 8000 }), url).resolves.toEqual({});
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
