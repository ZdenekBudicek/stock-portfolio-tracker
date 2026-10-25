// @vitest-environment node
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { createMarketSource } from '../../supabase/functions/agent/live/market.ts';
import { lastUsClose, quoteFreshness } from '../../supabase/functions/agent/core/marketTypes.ts';
import type { MarketSource } from '../../supabase/functions/agent/core/ports.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { FIXTURE_TODAY, fixtureMarket, fixtureSnapshot } from '../../supabase/functions/agent/core/fixture.ts';
import { fakeCaller } from '../test/agentDbFake';
import { marketContext, marketNow } from '../test/agentMarketFixture';
import { ok, toolCtx } from '../test/agentToolsFixture';

// Synthetic only. marketNow = Fri 2026-10-23 12:00 UTC = 08:00 New York: the US market is closed,
// the last regular session closed on Thu 2026-10-22 16:00 New York = 20:00 UTC.
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const keys = { FINNHUB_API_KEY: 'synthetic', TWELVE_DATA_KEY: 'synthetic' };
function setup(tables: Record<string, Record<string, unknown>[]> = {}, fetchImpl: Mock<typeof fetch> = vi.fn(async () => json({}))) {
  return { fetchImpl, source: createMarketSource(fakeCaller(tables).client, { fetchImpl, now: Date.now, keys }) };
}
function clock(at = marketNow) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); }
afterEach(() => vi.useRealTimers());
const sec = (iso: string) => Date.parse(iso) / 1000;
const twelve = (currency: string, close = '90') => json({ symbol: 'SYNA', close, previous_close: '88', currency, timestamp: marketNow / 1000 });

describe('I1: provider quotes in another currency', () => {
  it.each(['EUR', 'GBP', 'GBp', 'GBX'])('never labels a %s Twelve Data price as USD; the USD stored close is used', async currency => {
    clock();
    const { source } = setup({ price_history: [{ symbol: 'SYNA', date: '2026-10-22', close: 101 }] },
      vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(twelve(currency)));
    const quote = await source.quote('SYNA', marketContext());
    expect(quote).toMatchObject({ source: 'price_history', data: { price: 101, currency: 'USD', kind: 'close' } });
    expect(quote.warnings).toContain(`quote_currency_unsupported:${currency}`);
  });
  it('reports a non-USD price as unavailable when there is nothing in USD to fall back to', async () => {
    clock();
    const { source } = setup({}, vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(twelve('EUR')));
    expect(await source.quote('SYNA', marketContext())).toMatchObject({ data: null, freshness: 'missing' });
  });
  it('keeps a Twelve Data quote without a currency as USD, the convention the price job stores', async () => {
    clock();
    const { source } = setup({}, vi.fn().mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ symbol: 'SYNA', close: '90', previous_close: '88', timestamp: marketNow / 1000 })));
    expect(await source.quote('SYNA', marketContext())).toMatchObject({ source: 'Twelve Data', data: { price: 90, currency: 'USD' } });
  });
  it('values a Binance USDT price at par in USD, as the price job stores it, and says so', async () => {
    clock();
    const { source } = setup({}, vi.fn().mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ lastPrice: '60000', prevClosePrice: '59000', priceChangePercent: '1.7', closeTime: marketNow })));
    const quote = await source.quote('BTC', marketContext());
    expect(quote).toMatchObject({ source: 'Binance', data: { price: 60000, currency: 'USD', previousClose: 59000 } });
    expect(quote.warnings).toContain('usdt_valued_as_usd');
  });
  it('does not price a holding with a non-USD quote even if a market source returns one', async () => {
    const base = fixtureMarket();
    const market: MarketSource = { ...base, async quote(ticker, ctx) {
      const value = await base.quote(ticker, ctx);
      return ticker === 'SYNA' && value.data ? { ...value, data: { ...value.data, currency: 'EUR', price: 1 } } : value;
    } };
    const result = ok(await executeTool('get_holdings', { ticker: 'SYNA' }, toolCtx('A', { market })));
    const row = result.data.rows[0];
    // Unpriced exactly like a missing quote: at cost, flagged, never 1 EUR as 1 USD.
    expect(row.currentPrice).not.toBe(1);
    expect(row.value).toBeCloseTo(10 * 105);
    expect(result.meta.warnings).toContain('quote_currency_unsupported:SYNA:EUR');
    expect(result.meta).toMatchObject({ complete: false, valuationFallback: 'cost' });
  });
});

describe('I1: parity with the UI on the same inputs', () => {
  // What the UI's get-live-prices returns for these inputs: the cache row, else the latest stored
  // close; refresh-prices writes the Binance USDT price into the cache unchanged (at par).
  const tables = () => ({
    price_cache: [{ symbol: 'SYNB', price: 210, prev_close: 209, change_pct: 0.47846889952153115, fetched_at: '2026-10-23T11:55:00Z' },
      { symbol: 'USDCZK', price: 23.5, prev_close: null, change_pct: null, fetched_at: '2026-10-23T11:55:00Z' }],
    price_history: [{ symbol: 'SYNA', date: '2026-10-21', close: 99 }, { symbol: 'SYNA', date: '2026-10-22', close: 101 }],
  });
  const binance = { lastPrice: '60000', prevClosePrice: '59000', priceChangePercent: '1.6949', closeTime: marketNow };
  function uiPortfolio() {
    const snap = fixtureSnapshot('A'), fx = lib.localFx('CZK');
    const prices = { SYNA: { price: 101, changePct: 0, prevClose: null }, SYNB: { price: 210, changePct: 0.47846889952153115, prevClose: 209 },
      BTC: { price: 60000, changePct: 1.6949, prevClose: 59000 } };
    return lib.computePortfolio({ positions: snap.positions, prices, transactions: snap.transactions, snapshots: lib.toDisplaySnapshots(snap.snapshots, fx),
      t212Summary: null, dividends: snap.dividends, usdCzk: 23.5, fx });
  }
  it.each(['EUR', 'GBP', 'GBp'])('a %s quote for SYNA and a USDT quote for BTC give the UI totals exactly', async currency => {
    clock();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      if (host === 'api.twelvedata.com') return twelve(currency, '95');
      if (host === 'api.binance.com') return json(binance);
      return json({}, 500);
    }) as Mock<typeof fetch>;
    const { source } = setup(tables(), fetchImpl);
    const ui = uiPortfolio();
    const summary = ok(await executeTool('get_portfolio_summary', {}, toolCtx('A', { market: source })));
    expect(summary.data).toMatchObject({ totalValue: ui.totalValue, totalProfit: ui.totalProfit, unrealizedProfit: ui.unrealizedProfit, usdCzk: 23.5 });
    const holdings = ok(await executeTool('get_holdings', {}, toolCtx('A', { market: source })));
    for (const row of ui.positions) expect(holdings.data.rows.find((r: { ticker: string }) => r.ticker === row.ticker)).toMatchObject({ value: row.value, allocation: row.allocation });
  });
});

describe('I7: retrieval time is not validity time', () => {
  it('knows the last US regular close on the New York clock', () => {
    expect(new Date(lastUsClose(marketNow)).toISOString()).toBe('2026-10-22T20:00:00.000Z');
    // Saturday → Friday's close; after the 1 Nov 2026 DST change the close is 21:00 UTC.
    expect(new Date(lastUsClose(Date.parse('2026-10-24T12:00:00Z'))).toISOString()).toBe('2026-10-23T20:00:00.000Z');
    expect(new Date(lastUsClose(Date.parse('2026-11-02T22:00:00Z'))).toISOString()).toBe('2026-11-02T21:00:00.000Z');
    expect(new Date(lastUsClose(Date.parse('2026-11-02T14:00:00Z'))).toISOString()).toBe('2026-10-30T20:00:00.000Z');
  });
  it('per-kind rules: crypto 15 minutes, stocks 15 minutes in session or the last close when closed', () => {
    const open = Date.parse('2026-10-23T15:00:00Z');
    expect(quoteFreshness('stock', '2026-10-23T14:50:00Z', open)).toBe('fresh');
    expect(quoteFreshness('stock', '2026-10-23T14:30:00Z', open)).toBe('stale');
    expect(quoteFreshness('stock', '2026-10-22T20:00:00Z', marketNow)).toBe('fresh');
    expect(quoteFreshness('stock', '2026-10-21T20:00:00Z', marketNow)).toBe('stale');
    expect(quoteFreshness('crypto', '2026-10-23T11:50:00Z', marketNow)).toBe('fresh');
    expect(quoteFreshness('crypto', '2026-10-23T10:00:00Z', marketNow)).toBe('stale');
    expect(quoteFreshness('stock', null, marketNow)).toBe('stale');
    expect(quoteFreshness('crypto', '2026-10-23T13:00:00Z', marketNow)).toBe('stale');
  });
  it('marks a just-downloaded Finnhub quote stale when its market time is days old', async () => {
    clock();
    const { source } = setup({}, vi.fn(async () => json({ c: 10, pc: 9, dp: 1, t: sec('2026-10-20T20:00:00Z') })));
    const quote = await source.quote('RKLB', marketContext());
    expect(quote).toMatchObject({ source: 'Finnhub', asOf: '2026-10-20T20:00:00.000Z', fetchedAt: '2026-10-23T12:00:00.000Z', freshness: 'stale' });
    expect(quote.warnings).toContain('quote_outdated');
  });
  it('keeps last night\'s close fresh while the market is closed', async () => {
    clock();
    const { source } = setup({}, vi.fn(async () => json({ c: 10, pc: 9, dp: 1, t: sec('2026-10-22T20:00:00Z') })));
    expect(await source.quote('RKLB', marketContext())).toMatchObject({ source: 'Finnhub', freshness: 'fresh' });
  });
  it('a quote without market time is not fresh', async () => {
    clock();
    const { source } = setup({}, vi.fn(async () => json({ c: 10, pc: 8, dp: 25, t: 0 })));
    expect(await source.quote('RKLB', marketContext())).toMatchObject({ asOf: null, freshness: 'stale' });
  });
  it('marks a CoinGecko price stale by its last update, not by the download', async () => {
    clock();
    const { source } = setup({}, vi.fn(async () => json({ bitcoin: { usd: 100, usd_24h_change: 1, last_updated_at: marketNow / 1000 - 7200 } })));
    expect(await source.quote('BTC', marketContext())).toMatchObject({ source: 'CoinGecko', freshness: 'stale' });
  });
  it('keeps the newer cached price when the provider only has an older one', async () => {
    clock();
    const { source } = setup({ price_cache: [{ symbol: 'RKLB', price: 12, fetched_at: '2026-10-23T11:00:00Z' }] },
      vi.fn(async () => json({ c: 10, pc: 9, dp: 1, t: sec('2026-10-20T20:00:00Z') })));
    expect(await source.quote('RKLB', marketContext())).toMatchObject({ source: 'price_cache', freshness: 'stale', data: { price: 12 } });
  });
  it('dates the Finnhub recommendation fallback by its period: an old month is stale', async () => {
    clock();
    const old = setup({}, vi.fn(async () => json([{ period: '2026-07-01', buy: 7, hold: 3, sell: 0, strongBuy: 1, strongSell: 0 }])));
    const stale = await old.source.analysts('RKLB', marketContext());
    expect(stale).toMatchObject({ source: 'Finnhub', asOf: '2026-07-01', fetchedAt: '2026-10-23T12:00:00.000Z', freshness: 'stale' });
    expect(stale.warnings).toContain('analysts_stale');
    const current = setup({}, vi.fn(async () => json([{ period: '2026-10-01', buy: 7, hold: 3, sell: 0, strongBuy: 1, strongSell: 0 }])));
    expect(await current.source.analysts('RKLB', marketContext())).toMatchObject({ freshness: 'fresh' });
  });
});

describe('I7: analyst target currency', () => {
  it('drops the currency of a stored snapshot that does not say it is the trading currency', async () => {
    clock();
    const { source } = setup({ analyst_snapshots: [{ symbol: 'TSM', fetched_at: '2026-10-23T06:00:00Z', status: 'ok',
      data: { ticker: 'TSM', targetMean: 250, currency: 'TWD', counts: { buy: 7 }, changes: [] } }] });
    expect((await source.analysts('TSM', marketContext())).data).toMatchObject({ targetMean: 250, currency: null });
    const marked = setup({ analyst_snapshots: [{ symbol: 'TSM', fetched_at: '2026-10-23T06:00:00Z', status: 'ok',
      data: { ticker: 'TSM', targetMean: 250, currency: 'USD', currencyBasis: 'trading', counts: { buy: 7 }, changes: [] } }] });
    expect((await marked.source.analysts('TSM', marketContext())).data).toMatchObject({ targetMean: 250, currency: 'USD' });
  });
});

describe('audit A9: a USD/CZK rate taken from an old snapshot', () => {
  it('is reported stale instead of fresh', async () => {
    const market = fixtureMarket();
    const noFx: MarketSource = { ...market, quote: (ticker, ctx) => ticker === 'USDCZK'
      ? Promise.resolve({ data: null, source: 'none', asOf: null, fetchedAt: null, freshness: 'missing', warnings: [] }) : market.quote(ticker, ctx) };
    // The newest fixture snapshot is from about FIXTURE_TODAY: a month later its rate is old.
    const later = new Date(Date.parse(FIXTURE_TODAY) + 30 * 86_400_000).toISOString().slice(0, 10);
    const summary = ok(await executeTool('get_portfolio_summary', {}, toolCtx('A', { market: noFx, today: later })));
    expect(summary.meta.warnings).toEqual(expect.arrayContaining(['usdczk_from_snapshot', 'usdczk_stale']));
    expect(summary.meta.freshness).toBe('stale');
    const recent = ok(await executeTool('get_portfolio_summary', {}, toolCtx('A', { market: noFx })));
    expect(recent.meta.warnings).toContain('usdczk_from_snapshot');
    expect(recent.meta.warnings).not.toContain('usdczk_stale');
  });
});
