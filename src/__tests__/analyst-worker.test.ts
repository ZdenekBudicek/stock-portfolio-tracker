// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runAnalystWorker } from '../../scripts/analyst-worker.mjs';
import { analystRaw, marketNow } from '../test/agentMarketFixture';

function fixture(fail = false, nasdaqFail = false) {
  const pages: string[] = [], writes: Record<string, unknown>[] = [];
  const db = {
    async read(table: string, from: number, to: number) {
      pages.push(`${table}:${from}`);
      const tables = {
        positions: Array.from({ length: 1001 }, (_, i) => ({ id: String(i), ticker: i === 1000 ? 'SECOND' : 'RKLB', type: 'Stock', shares: 1 })),
        watchlist: [{ ticker: 'RKLB' }, { ticker: 'WATCH' }, { ticker: 'BTC' }], ticker_alias: [], ticker_profiles: [],
        fundamentals_requests: [],
        analyst_snapshots: [{ symbol: 'RKLB', data: { targetMean: 130 }, fetched_at: new Date(marketNow - 25 * 3600000).toISOString(), status: 'ok', last_attempt_at: null }],
      };
      if (!(table in tables)) throw new Error('Unexpected table');
      return tables[table].slice(from, to + 1);
    },
    async write(symbol: string, patch: Record<string, unknown>, preserve: boolean) { writes.push({ symbol, patch, preserve }); },
  };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const target = new URL(url);
    expect(init.signal).toBeDefined(); expect(JSON.stringify(init.headers)).not.toContain('synthetic-secret');
    if (target.hostname === 'fc.yahoo.com') return new Response(null, { status: 404, headers: { 'set-cookie': 'A3=synthetic-cookie; Domain=.yahoo.com' } });
    // Ocenění v3: later years of consensus EPS from Nasdaq (no key, no cookie).
    if (target.hostname === 'api.nasdaq.com') {
      expect(target.pathname).toMatch(/^\/api\/analyst\/[A-Z]+\/earnings-forecast$/); expect(JSON.stringify(init.headers)).not.toContain('Cookie');
      return new Response(JSON.stringify(nasdaqFail ? {} : { data: { yearlyForecast: { rows: [
        { fiscalEnd: 'Dec 2026', consensusEPSForecast: 1, noOfEstimates: 5 }, { fiscalEnd: 'Dec 2027', consensusEPSForecast: 2, noOfEstimates: 5 },
        { fiscalEnd: 'Dec 2028', consensusEPSForecast: 3, noOfEstimates: 4 }, { fiscalEnd: 'Dec 2029', consensusEPSForecast: 4, noOfEstimates: 2 }] } } }));
    }
    expect(target.hostname).toBe('query2.finance.yahoo.com'); expect(init.redirect).toBe('error');
    if (target.pathname === '/v1/test/getcrumb') {
      // Yahoo answers HTTP 406 to `Accept: application/json` here, and every quote is then 401.
      expect((init.headers as Record<string, string>).Accept).toBe('*/*');
      return new Response('synthetic.crumb');
    }
    expect(target.pathname).toMatch(/^\/v10\/finance\/quoteSummary\/[A-Z]+$/);
    expect(target.searchParams.get('crumb')).toBe('synthetic.crumb'); expect((init.headers as Record<string, string>).Cookie).toBe('A3=synthetic-cookie');
    return new Response(JSON.stringify(fail ? { quoteSummary: { error: { code: 'Denied' } } } : analystRaw), { status: fail ? 429 : 200 });
  });
  return { db, fetchImpl, pages, writes };
}
describe('analyst worker', () => {
  it('pages/deduplicates the equity union independently of any fundamentals queue', async () => {
    const f = fixture();
    expect(await runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {} })).toEqual({ updated: 3, failed: 0, skipped: 0 });
    expect(f.pages).toContain('positions:1000'); expect(f.fetchImpl).toHaveBeenCalledTimes(8);
    expect(f.fetchImpl.mock.calls.filter(c => String(c[0]).includes('quoteSummary'))).toHaveLength(3);
    expect(f.fetchImpl.mock.calls.filter(c => String(c[0]).includes('api.nasdaq.com'))).toHaveLength(3);
    expect(f.writes.map(w => w.symbol).sort()).toEqual(['RKLB', 'SECOND', 'WATCH']);
    expect(f.writes[0].patch).toMatchObject({ status: 'ok', data: { targetMean: 150 } });
  });
  it('adds later years of consensus EPS from Nasdaq after the two Yahoo years, keeping them when Nasdaq fails', async () => {
    const { withLaterYears } = await import('../../scripts/analyst-worker.mjs');
    const yahoo = { estimates: [{ period: 'current', endDate: '2026-12-31', eps: 1.1 }, { period: 'next', endDate: '2027-12-31', eps: 2.2 }] };
    const nasdaq = { estimates: [{ period: 'current', endDate: '2026-12-31', eps: 1 }, { period: 'next', endDate: '2027-12-31', eps: 2 },
      { period: 'later', endDate: '2028-12-31', eps: 3 }, { period: 'later', endDate: '2029-12-31', eps: 4 }, { period: 'later', endDate: '2030-12-31', eps: 5 }] };
    expect(withLaterYears(yahoo, nasdaq).estimates.map((e: { period: string; eps: number }) => [e.period, e.eps])).toEqual([['current', 1.1], ['next', 2.2], ['later', 3], ['later', 4]]);
    expect(withLaterYears(yahoo, null)).toBe(yahoo);
    expect(withLaterYears({ estimates: [] }, nasdaq)).toEqual({ estimates: [] });
    const f = fixture(false, true);
    expect(await runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {}, log: () => {} })).toEqual({ updated: 3, failed: 0, skipped: 0 });
  });
  it('patches only attempt/status after a failed refresh, preserving successful data/time', async () => {
    const f = fixture(true); await runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {} });
    const row = f.writes.find(w => w.symbol === 'RKLB');
    expect(row).toEqual({ symbol: 'RKLB', preserve: true, patch: { status: 'error', last_attempt_at: new Date(marketNow).toISOString() } });
    // HTTP 429 stops the run: the other due symbols are deferred, not marked failed.
    expect(f.writes).toHaveLength(1);
  });
  it('records a first failure without data and an empty payload as unavailable', async () => {
    const f = fixture(); const writes: Record<string, unknown>[] = [];
    f.db.write = async (symbol, patch, preserve) => { writes.push({ symbol, patch, preserve }); };
    const fetchImpl = vi.fn(async (url: string) => new URL(url).hostname === 'fc.yahoo.com' ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ quoteSummary: { result: [{ financialData: {} }], error: null } })));
    expect(await runAnalystWorker({ db: f.db, fetchImpl, now: () => marketNow, sleep: async () => {}, log: () => {} })).toEqual({ updated: 0, failed: 3, skipped: 0 });
    expect(writes.find(w => w.symbol === 'WATCH')).toEqual({ symbol: 'WATCH', preserve: false, patch: { data: null, fetched_at: null, last_attempt_at: new Date(marketNow).toISOString(), status: 'unavailable' } });
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.has('crumb')).toBe(false);
  });
  it('skips funds and snapshots that are not due, whatever the fundamentals state', async () => {
    const f = fixture(); const original = f.db.read;
    f.db.read = async (table, from, to) => table === 'ticker_profiles' ? [{ ticker: 'WATCH', asset_type: 'ETF' }]
      : table === 'analyst_snapshots' ? [{ symbol: 'SECOND', data: {}, fetched_at: new Date(marketNow - 3600000).toISOString(), status: 'ok', last_attempt_at: null }]
        : original(table, from, to);
    expect(await runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {}, log: () => {} })).toEqual({ updated: 1, failed: 0, skipped: 1 });
    expect(f.writes.map(w => w.symbol)).toEqual(['RKLB']);
  });
  it('does not start without the explicit enable flag', async () => {
    const { execFileSync } = await import('node:child_process');
    const output = execFileSync(process.execPath, ['scripts/analyst-worker.mjs'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(output).toContain('analyst worker disabled');
  });
  it('fails closed on a later page error without writing a partial union', async () => {
    const f = fixture(); const original = f.db.read;
    f.db.read = async (table, from, to) => { if (from === 1000) throw new Error('Read failed'); return original(table, from, to); };
    await expect(runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {} })).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });
  it('also covers companies someone asked about in the last 90 days', async () => {
    const f = fixture(); const original = f.db.read;
    f.db.read = async (table, from, to) => table === 'fundamentals_requests' ? [
      { symbol: 'ASKED', requested_at: new Date(marketNow - 10 * 86_400_000).toISOString() },
      { symbol: 'OLDASK', requested_at: new Date(marketNow - 100 * 86_400_000).toISOString() },
    ].slice(from, to + 1) : original(table, from, to);
    expect(await runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {}, log: () => {} })).toEqual({ updated: 4, failed: 0, skipped: 0 });
    expect(f.writes.map(w => w.symbol).sort()).toEqual(['ASKED', 'RKLB', 'SECOND', 'WATCH']);
  });
  it('on demand fetches exactly the requested tickers, due or not, and still leaves funds out', async () => {
    const f = fixture(); const original = f.db.read;
    f.db.read = async (table, from, to) => table === 'ticker_profiles' ? [{ ticker: 'FUNDX', asset_type: 'ETF' }] : original(table, from, to);
    // RKLB was fetched 25 hours ago and NEWCO is in nobody's data yet: both are fetched now; FUNDX is a fund.
    expect(await runAnalystWorker({ db: f.db, fetchImpl: f.fetchImpl, now: () => marketNow, sleep: async () => {}, log: () => {}, only: ['RKLB', 'NEWCO', 'FUNDX'] }))
      .toEqual({ updated: 2, failed: 0, skipped: 0 });
    expect(f.writes.map(w => w.symbol).sort()).toEqual(['NEWCO', 'RKLB']);
  });
  it('runs nightly since the owner enabled it (Ocenění v2) and for the symbols of an on-demand run, never blocking it', () => {
    const workflow = readFileSync('.github/workflows/price-history.yml', 'utf8');
    expect(workflow).toContain('AGENT_MARKET_ENABLED: "true"');
    expect(workflow).toMatch(/analysts:\s*\n\s*if: \$\{\{ (?:vars\.ENABLE_PORTFOLIO_WORKERS == 'true' && )?!inputs\.symbols \}\}/);
    expect(workflow).toContain('test "$AGENT_MARKET_ENABLED" = true');
    expect(workflow).toContain('node scripts/analyst-worker.mjs');
    const demand = workflow.slice(workflow.indexOf('  on-demand:'));
    expect(demand).toMatch(/- name: Fetch analyst estimates\s*\n\s*if: [^\n]+\n\s*continue-on-error: true/);
    expect(demand.indexOf('Fetch analyst estimates')).toBeLessThan(demand.indexOf('Finish requests'));
  });
});
