// @vitest-environment node
import { RETRIEVAL_TIME_NOTE } from '../../supabase/functions/agent/core/marketTypes.ts';
import { describe, expect, it } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { FIXTURE_TODAY, fixtureSnapshot, snapshotRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { errorOf, factOf, ok, toolCtx, toolPeriod, toolPreferences } from '../test/agentToolsFixture';

const quotes = { SYNA: { price: 150, prev: 148 }, SYNB: { price: 210, prev: 209 }, BTC: { price: 60000, prev: 59000 } };

// The UI's computation over the same snapshot, prices and FX: the tools must not be a second engine.
function uiPortfolio() {
  const snap = fixtureSnapshot('A');
  const fx = lib.localFx('CZK');
  const prices = Object.fromEntries(Object.entries(quotes).map(([t, q]) => [t, { price: q.price, changePct: (q.price - q.prev) / q.prev * 100, prevClose: q.prev }]));
  const snapshots = lib.toDisplaySnapshots(snap.snapshots, fx);
  const portfolio = lib.computePortfolio({ positions: snap.positions, prices, transactions: snap.transactions, snapshots,
    t212Summary: null, dividends: snap.dividends, usdCzk: 23.5, fx });
  return { snap, fx, snapshots, portfolio };
}

describe('portfolio tools', () => {
  it('summary facts equal the UI model over the same snapshot', async () => {
    const { portfolio } = uiPortfolio();
    const result = ok(await executeTool('get_portfolio_summary', {}, toolCtx('A')));
    expect(result.data).toEqual({ totalValue: portfolio.totalValue, netDepositsUsd: portfolio.netDepositsUsd, totalProfit: portfolio.totalProfit,
      unrealizedProfit: portfolio.unrealizedProfit, usdCzk: portfolio.usdCzk, usdLocal: portfolio.usdLocal, cashUsd: 500 });
    expect(factOf(result, 'portfolio:total_value')).toMatchObject({ value: portfolio.totalValue, unit: 'money', currency: 'USD', source: 'portfolio_model' });
    // Missing deposits stay null, never zero.
    expect(factOf(result, 'portfolio:net_deposits')?.value).toBe(portfolio.netDepositsUsd);
    expect(result.meta).toMatchObject({ complete: true, scope: { all: true }, snapshotId: 'fixture-A' });
    // SYNB and USD/CZK come from cache rows: dated by their provider fetch time, with a note saying so.
    expect(result.meta.warnings).toContain(RETRIEVAL_TIME_NOTE);
    expect(result.meta.warnings).not.toContain('quote_time_unknown:SYNB');
    expect(factOf(result, 'portfolio:usd_czk')).toMatchObject({ value: 23.5, source: 'price_cache', as_of: '2026-10-23T11:50:00.000Z' });
  });

  it('holdings keep the model rows, allocation and full share precision', async () => {
    const { portfolio } = uiPortfolio();
    const result = ok(await executeTool('get_holdings', {}, toolCtx('A')));
    expect(result.data.rows).toEqual(portfolio.positions);
    expect(result.data.totalRows).toBe(portfolio.positions.length);
    expect(factOf(result, 'holding:SYNA:allocation')).toMatchObject({ value: portfolio.positions.find(p => p.ticker === 'SYNA')!.allocation, unit: 'percent' });
    const etf = ok(await executeTool('get_holdings', { assetType: 'etf' }, toolCtx('A')));
    expect(etf.data.rows.map(r => r.ticker)).toEqual(['SYNB']);
    expect(ok(await executeTool('get_holdings', { ticker: 'synthetic alpha' }, toolCtx('A'))).data.rows.map(r => r.ticker)).toEqual(['SYNA']);
  });

  it('transactions keep tiny crypto amounts and sum every row while returning at most 50', async () => {
    const btc = ok(await executeTool('get_transactions', { from: '2025-01-01', to: '2025-12-31', ticker: 'BTC' }, toolCtx('A')));
    expect(btc.data.boughtShares).toBe(0.00001234);
    expect(factOf(btc, 'transactions:BTC:bought_shares')).toMatchObject({ value: 0.00001234, unit: 'shares', ticker: 'BTC' });

    const snapshot = fixtureSnapshot('A');
    const base = snapshot.transactions[0];
    snapshot.transactions = Array.from({ length: 51 }, (_, i) => ({ ...base, id: `t-${i}`, ext_id: `synthetic:t:${i}`,
      shares: 1, price_usd: 10 + i, fee_usd: 0.5, executed_at: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z` }));
    const result = ok(await executeTool('get_transactions', { ...toolPeriod, ticker: 'SYNA' }, toolCtx('A', { repo: snapshotRepo(snapshot, 'fifty-one') })));
    expect(result.data.rows).toHaveLength(50);
    expect(result.data.totalRows).toBe(51);
    expect(result.meta.omittedRows).toBe(1);
    expect(result.data.boughtShares).toBe(51);
    expect(result.data.buyUsd).toBe(Array.from({ length: 51 }, (_, i) => 10 + i).reduce((a, b) => a + b, 0));
    expect(result.data.feesUsd).toBeCloseTo(25.5, 10);
  });

  it('realized results are filtered only after the full FIFO', async () => {
    const snap = fixtureSnapshot('A');
    const expected = lib.computeRealized({ transactions: snap.transactions, dividends: snap.dividends, year: 2026, currency: 'USD', today: FIXTURE_TODAY });
    const result = ok(await executeTool('get_realized_pnl', { ...toolPeriod, currency: 'USD' }, toolCtx('A')));
    expect(result.data.reports).toHaveLength(1);
    expect(result.data.reports[0].net).toBe(expected.report.net);
    expect(factOf(result, 'realized:2026:net')).toMatchObject({ value: expected.report.net, currency: 'USD', unit: 'money' });
    const scoped = ok(await executeTool('get_realized_pnl', { ...toolPeriod, currency: 'USD', scope: { broker: 'synthetic', account: 'A2' } }, toolCtx('A')));
    expect(scoped.data.reports[0].rows).toEqual([]);
    expect(scoped.data.reports[0].net).toBe(0);
    expect(scoped.meta.scope).toEqual({ broker: 'synthetic', account: 'A2' });
  });

  it('Czech tax report equals the shared model and serializes without the resolver', async () => {
    const { portfolio, snap } = uiPortfolio();
    const expected = lib.computeCzTaxModel({ transactions: snap.transactions, positions: portfolio.positions, registry: snap.registry,
      year: 2026, today: FIXTURE_TODAY, usdCzk: 23.5, settings: toolPreferences.tax });
    const result = ok(await executeTool('get_tax_report', { year: 2026 }, toolCtx('A')));
    expect(result.data.residence).toBe('CZ');
    expect(JSON.parse(JSON.stringify(result.data.model))).toMatchObject({ report: JSON.parse(JSON.stringify(expected.report)) });
    expect(factOf(result, 'tax:2026:tax_base')).toMatchObject({ value: expected.report.taxBaseCzk, currency: 'CZK' });
    expect(Object.values(result.data.model).some(v => typeof v === 'function')).toBe(false);
  });

  it('a Slovak resident gets the international engine and lots without the Czech time test', async () => {
    const result = ok(await executeTool('get_tax_report', { year: 2026 }, toolCtx('B')));
    expect(result.data.residence).toBe('SK');
    const lots = ok(await executeTool('get_tax_lots', {}, toolCtx('B')));
    expect(lots.data.residence).toBe('SK');
    expect(JSON.stringify(lots.data.lots)).not.toMatch(/exemptFrom|remainingDays/);
    const cz = ok(await executeTool('get_tax_lots', { ticker: 'BTC' }, toolCtx('A')));
    expect((cz.data.lots as { shares: number }[])[0].shares).toBe(0.00001234);
  });

  it('sale simulation clarifies an ambiguous account instead of picking one', async () => {
    const result = await executeTool('simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150 }, toolCtx('A'));
    expect(result).toMatchObject({ ok: false, error: { code: 'clarify' } });
    expect(errorOf(result)?.message).toMatch(/A1/);
    const sim = ok(await executeTool('simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150, broker: 'synthetic', account: 'A1' }, toolCtx('A')));
    expect(sim.data.jurisdiction).toBe('CZ');
    expect(factOf(sim, 'sale:SYNA:sale_fx')).toMatchObject({ value: 23.5, source: 'assumption' });
    expect(factOf(sim, 'sale:SYNA:price')).toMatchObject({ value: 150, source: 'user' });
    expect(factOf(sim, 'sale:SYNA:extra_tax')?.currency).toBe('CZK');
  });

  it('performance matches the shared summary and admits missing per-position history', async () => {
    const { portfolio, snap, snapshots } = uiPortfolio();
    const result = ok(await executeTool('get_performance', { ...toolPeriod, benchmark: 'SPX' }, toolCtx('A')));
    const model = lib.computePerformanceModel({ snapshots, portfolio, transactions: snap.transactions, dividends: snap.dividends,
      benchmark: (await import('../../supabase/functions/agent/fixtures/demo.json')).default.market.benchmark.SPX, currency: 'USD', today: FIXTURE_TODAY });
    const summary = lib.summarizePerformance(model, toolPeriod);
    expect(result.data.portfolioReturn).toBe(summary.portfolioReturn);
    expect(result.data.benchmarkReturn).toBe(summary.benchmarkReturn);
    expect(result.data.best.length).toBeGreaterThan(0);
    expect(result.data.best[0].unit).toBe('ratio');
    expect(result.meta.warnings).toContain('position_history_missing:BTC');
  });

  it('allocation, dividends and watchlist come from the shared models without private notes', async () => {
    const alloc = ok(await executeTool('get_allocation', {}, toolCtx('A')));
    expect(alloc.data.sectors.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 10);
    expect(alloc.data.sectors.some(s => /cash/i.test(s.name))).toBe(false);
    const received = ok(await executeTool('get_dividends', { mode: 'received', ...toolPeriod }, toolCtx('A')));
    expect(received.data.received?.total).toBe(12);
    expect(factOf(received, 'dividends:gross')?.value).toBeCloseTo(12 / 0.85, 10);
    expect(factOf(received, 'dividends:withheld')?.value).toBeCloseTo(12 / 0.85 - 12, 10);
    expect(received.meta.warnings).toContain('withholding_assumed');
    const forecast = ok(await executeTool('get_dividends', { mode: 'forecast' }, toolCtx('A')));
    expect(forecast.data.forecast).not.toBeNull();
    expect(() => JSON.stringify(forecast.data)).not.toThrow();
    const watch = ok(await executeTool('get_watchlist', {}, toolCtx('A')));
    expect(watch.data.rows).toEqual([{ ticker: 'SYNW', targetPriceUsd: 40, quote: expect.objectContaining({ price: 45 }) }]);
    expect(JSON.stringify(watch)).not.toContain('private note');
    expect(factOf(watch, 'watchlist:SYNW:target')).toMatchObject({ value: 40, source: 'user' });
  });

  it('user B sees a different synthetic portfolio', async () => {
    const a = ok(await executeTool('get_holdings', {}, toolCtx('A'))), b = ok(await executeTool('get_holdings', {}, toolCtx('B')));
    expect(a.data.rows.map(r => r.ticker)).not.toEqual(b.data.rows.map(r => r.ticker));
    expect(b.data.rows.map(r => r.ticker)).toContain('SYNC');
    expect(b.meta.snapshotId).toBe('fixture-B');
  });
});
