import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fundamentalsDue, fundamentalsFresh, fundamentalsSymbols, fundamentalsUrl, runFundamentalsWorker } from '../../scripts/fundamentals-worker.mjs';

const NOW = Date.parse('2026-10-18T06:00:00.000Z');
const valid = { timeseries: { result: [{ annualTotalRevenue: [
  { asOfDate: '2025-12-31', currencyCode: 'USD', reportedValue: { raw: 123 } },
] }] } };
const reply = (json: unknown, status = 200) => ({ ok: status < 400, status, json: async () => json });

// jsdom 20 lacks Node 24's timeout helper. Requests are fully mocked in this suite.
beforeEach(() => vi.stubGlobal('AbortSignal', { timeout: () => new AbortController().signal }));
afterEach(() => vi.unstubAllGlobals());

describe('fundamentals worker', () => {
  it('deduplicates open holdings and watchlist, applies aliases and excludes cash/crypto', () => {
    const result = fundamentalsSymbols([
      { ticker: 'FB', shares: 1 }, { ticker: 'META', shares: 2 }, { ticker: 'CLOSED', shares: 0 },
      { ticker: 'CASH', shares: 100 }, { ticker: 'EUR', shares: 10, type: 'Cash' },
      { ticker: 'BTC', shares: 1, type: 'Stock' }, { ticker: 'ATOM', shares: 1, type: 'Stock' },
      { ticker: 'LTC', shares: 1, type: 'ETF' }, { ticker: 'brk.b', shares: 1 }, { ticker: 'SAP.DE', shares: 1 },
    ], [{ ticker: 'META' }, { ticker: 'BTCUSD' }, { ticker: 'CASH' }, { ticker: 'BATSl' }], [
      { alias: 'FB', canonical: 'META', yahoo_symbol: null },
      { alias: 'ATOM', canonical: 'ATOM', yahoo_symbol: 'ATOM' },
      { alias: 'BATSl', canonical: 'BATSl', yahoo_symbol: 'BATS.L' },
    ]);
    expect(result).toEqual([
      { symbol: 'ATOM', yahooSymbol: 'ATOM' }, { symbol: 'BATSL', yahooSymbol: 'BATS.L' },
      { symbol: 'BRK.B', yahooSymbol: 'BRK-B' }, { symbol: 'LTC', yahooSymbol: 'LTC' },
      { symbol: 'META', yahooSymbol: 'META' }, { symbol: 'SAP.DE', yahooSymbol: 'SAP.DE' },
    ]);
  });

  it('honors canonical crypto aliases and explicitly pinned coin pairs', () => {
    expect(fundamentalsSymbols([], [{ ticker: 'COIN_ALIAS' }, { ticker: 'CUSTOM' }], [
      { alias: 'COIN_ALIAS', canonical: 'BTC' }, { alias: 'CUSTOM', canonical: 'CUSTOM', yahoo_symbol: 'SOL-USD' },
    ])).toEqual([]);
  });

  it('skips only timestamps younger than 20 hours and requests all annual/quarterly types', () => {
    expect(fundamentalsFresh({ fetched_at: new Date(NOW - 20 * 3600000 + 1).toISOString() }, NOW)).toBe(true);
    expect(fundamentalsFresh({ fetched_at: new Date(NOW - 20 * 3600000).toISOString() }, NOW)).toBe(false);
    expect(fundamentalsFresh({ fetched_at: 'bad' }, NOW)).toBe(false);
    expect(fundamentalsFresh(undefined, NOW)).toBe(false);
    const url = new URL(fundamentalsUrl('BRK-B', NOW));
    expect(url.searchParams.get('type')!.split(',')).toHaveLength(38);
    expect(url.searchParams.get('type')).toContain('quarterlyRepurchaseOfCapitalStock');
    expect(url.searchParams.get('type')).toContain('annualStockholdersEquity');
    expect(url.searchParams.get('period1')).toBe('1483228800');
    expect(url.searchParams.get('period2')).toBe(String(NOW / 1000 + 86400));
  });

  it('paginates reads, throttles Yahoo, upserts successes and patches only error fields on failure', async () => {
    const calls: { url: string; options: any }[] = [];
    const sleep = vi.fn(async () => {});
    const fetchFn = vi.fn(async (url: string, options: any) => {
      calls.push({ url, options });
      if (url.includes('query2.finance.yahoo.com')) {
        expect(options.headers).toEqual({ 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' });
        if (url.includes('/FAIL?')) return reply(null, 429);
        if (url.includes('/EMPTY?')) return reply({ timeseries: { result: [] } });
        return reply(valid);
      }
      if (options.method) return reply(null, 204);
      if (url.includes('/positions?')) return reply(options.headers.Range === '0-999'
        ? Array.from({ length: 1000 }, () => ({ ticker: 'FB', shares: 1 })) : [{ ticker: 'FAIL', shares: 1 }]);
      if (url.includes('/watchlist?')) return reply([{ ticker: 'FRESH' }, { ticker: 'EMPTY' }]);
      if (url.includes('/ticker_alias?')) return reply([{ alias: 'FB', canonical: 'META', yahoo_symbol: 'META' }]);
      if (url.includes('/company_fundamentals?')) return reply([
        { symbol: 'FRESH', fetched_at: new Date(NOW - 1000).toISOString() },
        { symbol: 'FAIL', fetched_at: '2025-01-01T00:00:00Z' },
      ]);
      if (url.includes('/earnings_calendar?')) return reply([]);
      throw new Error('Unexpected request');
    });
    const result = await runFundamentalsWorker({ url: 'https://db.example', key: 'test-only', fetchFn, now: NOW, sleep, log: () => {} });
    expect(result).toEqual({ updated: 1, failed: 2, skipped: 1 });
    expect(calls.filter((c) => c.url.includes('/positions?')).map((c) => c.options.headers.Range)).toEqual(['0-999', '1000-1999']);
    expect(sleep.mock.calls).toEqual([[500], [500]]);
    const writes = calls.filter((c) => c.options.method);
    const errors = writes.filter((c) => c.options.method === 'PATCH');
    // A known symbol keeps its data (PATCH); a first-ever failure stores the attempt (POST).
    expect(errors.map((c) => JSON.parse(c.options.body))).toEqual([{ status: 'error', last_error: 'Yahoo HTTP 429', last_attempt_at: new Date(NOW).toISOString() }]);
    const firstFail = writes.filter((c) => c.options.method === 'POST').map((c) => JSON.parse(c.options.body)).find((b) => b.symbol === 'EMPTY');
    expect(firstFail).toMatchObject({ status: 'error', last_error: 'Yahoo returned no usable fundamentals', data: { annual: { periods: [] } } });
    // A parallel run's real data must survive: the first-failure row never overwrites.
    const firstFailCall = writes.find((c) => c.options.method === 'POST' && JSON.parse(c.options.body).symbol === 'EMPTY')!;
    expect(firstFailCall.options.headers.Prefer).toContain('ignore-duplicates');
    const success = writes.find((c) => c.options.method === 'POST' && JSON.parse(c.options.body).status === 'ok')!;
    expect(JSON.parse(success.options.body)).toMatchObject({
      symbol: 'META', currency: 'USD', status: 'ok', last_error: null,
      fetched_at: new Date(NOW).toISOString(), data: { symbol: 'META', annual: { values: { revenue: [123] } } },
    });
  });

  it('fails closed on DB read errors without making writes or Yahoo requests', async () => {
    const fetchFn = vi.fn(async () => reply(null, 503));
    await expect(runFundamentalsWorker({ url: 'https://db.example', key: 'test-only', fetchFn })).rejects.toThrow('HTTP 503');
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('surfaces failed writes instead of reporting a successful refresh', async () => {
    const fetchFn = vi.fn(async (url: string, options: any) => {
      if (options.method) return reply(null, 403);
      if (url.includes('query2.finance.yahoo.com')) return reply(valid);
      return reply(url.includes('/positions?') ? [{ ticker: 'META', shares: 1 }] : []);
    });
    await expect(runFundamentalsWorker({ url: 'https://db.example', key: 'test-only', fetchFn })).rejects.toThrow('Write company_fundamentals: HTTP 403');
  });

  it('fetches only the requested symbols on demand, fresh or not', async () => {
    const calls: { url: string; options: any }[] = [];
    const fetchFn = vi.fn(async (url: string, options: any) => {
      calls.push({ url, options });
      if (url.includes('query2.finance.yahoo.com')) return reply(valid);
      if (options.method) return reply(null, 204);
      if (url.includes('/ticker_alias?')) return reply([{ alias: 'FB', canonical: 'META', yahoo_symbol: 'META' }]);
      return reply(url.includes('/company_fundamentals?') ? [{ symbol: 'META', fetched_at: new Date(NOW - 1000).toISOString() }] : []);
    });
    const result = await runFundamentalsWorker({ url: 'https://db.example', key: 'test-only', fetchFn, now: NOW, sleep: async () => {}, log: () => {}, only: ['fb'] });
    expect(result).toEqual({ updated: 1, failed: 0, skipped: 0 }); // fresh, but requested
    // The request is closed by the workflow's last step, after prices too — not here.
    expect(calls.some((c) => c.url.includes('/fundamentals_requests?'))).toBe(false);
    expect(calls.filter((c) => c.url.includes('query2.finance.yahoo.com/')).map((c) => c.url)).toEqual([expect.stringContaining('/META?')]);
  });
});

describe('fundamentalsDue', () => {
  const D = 86_400_000;
  const at = (days: number) => new Date(NOW - days * D).toISOString();
  const day = (days: number) => at(days).slice(0, 10);
  it('fetches new symbols, skips anything fetched within a day', () => {
    expect(fundamentalsDue(undefined, undefined, NOW)).toBe(true);
    expect(fundamentalsDue({ fetched_at: at(0.5), status: 'ok' }, day(2), NOW)).toBe(false);
  });
  it('waits a month without results, a week for symbols without statements', () => {
    expect(fundamentalsDue({ fetched_at: at(29), status: 'ok' }, undefined, NOW)).toBe(false);
    expect(fundamentalsDue({ fetched_at: at(30), status: 'ok' }, undefined, NOW)).toBe(true);
    expect(fundamentalsDue({ fetched_at: at(6), status: 'error' }, undefined, NOW)).toBe(false);
    expect(fundamentalsDue({ fetched_at: at(7), status: 'error' }, undefined, NOW)).toBe(true);
  });
  it('spaces retries of a symbol without statements from the last attempt', () => {
    expect(fundamentalsDue({ fetched_at: at(20), last_attempt_at: at(1), status: 'error' }, undefined, NOW)).toBe(false);
    expect(fundamentalsDue({ fetched_at: at(20), last_attempt_at: at(8), status: 'error' }, undefined, NOW)).toBe(true);
  });
  it('refreshes after results until the new quarter appears', () => {
    // fetched before results 3 days ago → due
    expect(fundamentalsDue({ fetched_at: at(10), status: 'ok', qperiods: [day(120)] }, day(3), NOW)).toBe(true);
    // fetched after results, quarter not there yet → keep checking
    expect(fundamentalsDue({ fetched_at: at(2), status: 'ok', qperiods: [day(200)] }, day(3), NOW)).toBe(true);
    // quarter present → done until the next results
    expect(fundamentalsDue({ fetched_at: at(2), status: 'ok', qperiods: [day(200), day(40)] }, day(3), NOW)).toBe(false);
    // results 2 Oct for the quarter ending 30 Sep: a stored 30 Jun quarter is NOT the new one
    expect(fundamentalsDue({ fetched_at: at(2), status: 'ok', qperiods: [day(97)] }, day(3), NOW)).toBe(true);
    // results today → give Yahoo the day; results long ago → window over
    expect(fundamentalsDue({ fetched_at: at(10), status: 'ok', qperiods: [] }, day(0), NOW)).toBe(false);
    expect(fundamentalsDue({ fetched_at: at(25), status: 'ok', qperiods: [] }, day(22), NOW)).toBe(false);
  });
});
