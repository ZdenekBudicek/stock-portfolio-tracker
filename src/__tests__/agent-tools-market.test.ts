// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import demo from '../../supabase/functions/agent/fixtures/demo.json';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import type { CompanyFundamentals } from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { factOf, ok, toolCtx, toolPeriod } from '../test/agentToolsFixture';
import { FIXTURE_NOW, fixtureMarket } from '../../supabase/functions/agent/core/fixture.ts';
import { cachedQuoteTime, RETRIEVAL_TIME_NOTE } from '../../supabase/functions/agent/core/marketTypes.ts';

const fundamentals = demo.market.fundamentals.SYNA.data as unknown as CompanyFundamentals;
const closes = demo.market.history.SYNA;

describe('market tools', () => {
  it('quote facts carry the market time; a cache price is dated by its provider fetch time with a note', async () => {
    const dated = ok(await executeTool('get_quote', { ticker: 'syna' }, toolCtx()));
    expect(dated.data).toMatchObject({ ticker: 'SYNA', price: 150, currency: 'USD' });
    expect(factOf(dated, 'quote:SYNA:price')).toMatchObject({ value: 150, unit: 'money', currency: 'USD', as_of: '2026-10-23T11:55:00.000Z', source: 'Finnhub' });
    const cached = ok(await executeTool('get_quote', { ticker: 'SYNB' }, toolCtx()));
    expect(cached.data.price).toBe(210);
    // fetched_at of the price_cache row (11:50), not the fixture's "now" (12:00) when the cache is read.
    expect(factOf(cached, 'quote:SYNB:price')).toMatchObject({ value: 210, unit: 'money', currency: 'USD', source: 'price_cache', as_of: '2026-10-23T11:50:00.000Z' });
    expect(cached.meta.warnings).toContain(RETRIEVAL_TIME_NOTE);
    expect(cached.meta.warnings.some(w => w.startsWith('fact_undated'))).toBe(false);
    expect(cached.meta.freshness).toBe('fresh');
  });

  it('a cache price older than 15 minutes is a stale fact, still dated by its fetch time', async () => {
    const base = fixtureMarket();
    const market = { ...base, quote: async (t: string, c: Parameters<typeof base.quote>[1]) => t === 'SYNB'
      ? { ...cachedQuoteTime('2026-10-23T11:30:00.000Z', Date.parse(FIXTURE_NOW)), data: { ticker: 'SYNB', price: 210, currency: 'USD', previousClose: null, changePct: null, kind: 'quote' as const },
        source: 'price_cache', fetchedAt: '2026-10-23T11:30:00.000Z' }
      : base.quote(t, c) };
    const result = ok(await executeTool('get_quote', { ticker: 'SYNB' }, toolCtx('A', { market })));
    expect(factOf(result, 'quote:SYNB:price')).toMatchObject({ value: 210, as_of: '2026-10-23T11:30:00.000Z' });
    expect(result.meta).toMatchObject({ freshness: 'stale', complete: false });
    expect(result.meta.warnings).toContain(RETRIEVAL_TIME_NOTE);
  });

  it('asks to clarify unknown and colliding tickers', async () => {
    expect(await executeTool('get_quote', { ticker: 'nic' }, toolCtx())).toMatchObject({ ok: false, error: { code: 'clarify' } });
    const ltc = await executeTool('get_quote', { ticker: 'LTC' }, toolCtx());
    expect(ltc).toMatchObject({ ok: false, error: { code: 'clarify' } });
    expect(ok(await executeTool('get_quote', { ticker: 'bitcoin' }, toolCtx())).data.ticker).toBe('BTC');
  });

  it('price history uses daily close-to-close returns and a sample SD of the last 60', async () => {
    const result = ok(await executeTool('get_price_history', { ticker: 'SYNA', period: { from: '2026-01-01', to: '2026-10-23' }, benchmark: 'SPX' }, toolCtx()));
    const points = closes.filter(p => p.date >= '2026-01-01');
    expect(result.data.points.map(p => p.close)).toEqual(points.map(p => p.close));
    const returns = points.slice(1).map((p, i) => p.close / points[i].close - 1).slice(-60);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1));
    expect(result.data.volatility60d).toBeCloseTo(sd, 12);
    const spx = demo.market.benchmark.SPX.filter(p => p.date >= '2026-01-01');
    expect(result.data.benchmarkChangePct).toBeCloseTo((spx[spx.length - 1].close_value / spx[0].close_value - 1) * 100, 10);
    expect(factOf(result, 'history:SYNA:volatility_60d')).toMatchObject({ unit: 'ratio', ticker: 'SYNA' });
    const short = ok(await executeTool('get_price_history', { ticker: 'SYNA', period: { from: '2026-10-21', to: '2026-10-21' } }, toolCtx()));
    expect(short.data.volatility60d).toBeNull();
    expect(short.data.benchmarkChangePct).toBeNull();
  });

  it('fundamentals become per-metric facts with period and currency', async () => {
    const result = ok(await executeTool('get_fundamentals', { ticker: 'SYNA' }, toolCtx()));
    const revenue = factOf(result, 'fundamentals:SYNA:annual:revenue');
    expect(revenue).toMatchObject({ value: 1000e6, unit: 'money', currency: 'USD', period: { from: '2025-01-01', to: '2025-12-31' } });
    expect(factOf(result, 'fundamentals:SYNA:quarterly:revenue')).toMatchObject({ value: 270e6, period: { from: '2026-04-01', to: '2026-06-30' } });
    expect(result.data.metrics.length).toBe(result.facts.length);
    // Unreported metrics stay out instead of becoming zero.
    expect(factOf(result, 'fundamentals:SYNA:annual:rnd')).toBeUndefined();
  });

  it('valuation history reports percentiles with their history length and never invents a sector comparison', async () => {
    const result = ok(await executeTool('get_valuation_history', { ticker: 'SYNA' }, toolCtx()));
    const series = lib.valuationSeries(fundamentals, closes);
    expect(factOf(result, 'valuation:SYNA:median_5y:pe')?.value).toBe(lib.medianOf(series, 'pe'));
    const pe = series.map(p => p.pe).filter((x): x is number => x != null);
    const current = pe[pe.length - 1];
    expect(factOf(result, 'valuation:SYNA:percentile:pe')?.value).toBe(pe.filter(v => v <= current).length / pe.length);
    expect(result.data.sectorComparison).toEqual([]);
    expect(result.meta.warnings).toEqual(expect.arrayContaining(['sector_comparison_unavailable', `history_points:pe:${pe.length}`]));
  });

  it('fair value equals the shared calculation and labels assumptions by origin', async () => {
    // The tool passes the stored analyst view (SYNA: mean target 150, 12 analysts) like the app does.
    const context = { estimates: null, estimatesCurrency: null, targetMean: 150, targetLow: null, targetHigh: 180, targetCurrency: 'USD', asOf: FIXTURE_NOW.slice(0, 10), analystCount: 12 };
    const expected = lib.calculateFairValue(fundamentals, 150, undefined, closes, context);
    expect(expected.weights.analysts).toBeGreaterThan(0);
    const result = ok(await executeTool('get_fair_value', { ticker: 'SYNA' }, toolCtx()));
    expect(result.data.value).toBe(expected.value);
    expect(result.data.sensitivity.cells).toHaveLength(3);
    expect(factOf(result, 'fair_value:SYNA:assumption:discount')).toMatchObject({ source: 'assumption' });
    const custom = ok(await executeTool('get_fair_value', { ticker: 'SYNA', assumptions: { discount: 0.1 } }, toolCtx()));
    const defaults = lib.defaultAssumptions(fundamentals, closes).assumptions;
    expect(custom.data.value).toBe(lib.calculateFairValue(fundamentals, 150, { ...defaults, discount: 0.1 }, closes, context).value);
    expect(factOf(custom, 'fair_value:SYNA:assumption:discount')).toMatchObject({ value: 0.1, source: 'user' });
    expect(factOf(custom, 'fair_value:SYNA:assumption:growth')).toMatchObject({ source: 'assumption' });
  });

  it('fair value v2: analyst consensus feeds the growth model, scenarios for the asked horizon are facts', async () => {
    const base = fixtureMarket();
    const estimates = [
      { period: 'current' as const, endDate: '2026-12-31', eps: 4.2, revenue: 1.25e9, epsGrowth: 0.3, revenueGrowth: 0.3, analysts: 12 },
      { period: 'next' as const, endDate: '2027-12-31', eps: 5.6, revenue: 1.65e9, epsGrowth: 0.33, revenueGrowth: 0.32, analysts: 12 },
    ];
    const market = { ...base, analysts: async (t: string, c: Parameters<typeof base.analysts>[1]) => {
      const v = await base.analysts(t, c);
      return v.data ? { ...v, data: { ...v.data, estimates, estimatesCurrency: 'USD' } } : v;
    } };
    const result = ok(await executeTool('get_fair_value', { ticker: 'SYNA', years: 5 }, toolCtx('A', { market })));
    const context = { estimates, estimatesCurrency: 'USD', targetMean: 150, targetLow: null, targetHigh: 180, targetCurrency: 'USD', asOf: FIXTURE_NOW.slice(0, 10) };
    const expected = lib.calculateFairValue(fundamentals, 150, undefined, closes, context);
    expect(expected.model).toBe('revenue');
    expect(result.data.value).toBeCloseTo(expected.value!, 10);
    expect(factOf(result, 'fair_value:SYNA:model')).toMatchObject({ value: 'revenue', unit: 'text' });
    expect(factOf(result, 'fair_value:SYNA:forward_eps')).toMatchObject({ value: 5.6, unit: 'money' });
    expect(result.meta.warnings).toEqual(expect.arrayContaining(['valuation_model:revenue', 'growth_from_consensus']));
    const scenarios = lib.priceScenarios(fundamentals, 150, 5, context, closes);
    expect(result.data.scenarios.years).toBe(5);
    for (const s of scenarios.scenarios) {
      expect(factOf(result, `scenario:SYNA:${s.kind}:price`)!.value).toBeCloseTo(s.price, 8);
      expect(factOf(result, `scenario:SYNA:${s.kind}:assumption:pe`)!.value).toBeCloseTo(s.multiple, 10);
      expect(factOf(result, `scenario:SYNA:${s.kind}:assumption:margin`)!.value).toBeCloseTo(s.netMargin!, 10);
    }
    expect(factOf(result, 'scenario:SYNA:basis')).toMatchObject({ value: 'earnings' });
    // No analyst snapshot at all: the valuation still runs on the latest growth.
    const none = { ...base, analysts: async () => { throw new Error('down'); } };
    expect(ok(await executeTool('get_fair_value', { ticker: 'SYNA' }, toolCtx('A', { market: none }))).data.value).not.toBeNull();
  });

  it('analyst view keeps a missing target null and labels the opinion', async () => {
    const result = ok(await executeTool('get_analyst_view', { ticker: 'SYNA' }, toolCtx()));
    expect(result.data.targetMean).toBe(150);
    expect(result.data.targetLow).toBeNull();
    expect(result.data.counts).toMatchObject({ buy: 7, hold: 3 });
    expect(factOf(result, 'analysts:SYNA:target_mean')).toMatchObject({ value: 150, currency: 'USD', source: 'analyst_opinion:analyst_snapshots' });
    expect(factOf(result, 'analysts:SYNA:target_low')).toBeUndefined();
    expect(factOf(result, 'analysts:SYNA:buy')).toMatchObject({ value: 7, unit: 'count' });
  });

  it('news is capped, period-filtered and marked untrusted; earnings carry event dates', async () => {
    const news = ok(await executeTool('get_stock_news', { ticker: 'SYNA', period: toolPeriod }, toolCtx()));
    expect(news.data.items.length).toBeLessThanOrEqual(5);
    expect(news.meta.warnings).toContain('untrusted_external_text');
    const recent = ok(await executeTool('get_stock_news', { ticker: 'SYNA', period: { from: '2026-10-16', to: '2026-10-23' } }, toolCtx()));
    expect(recent.data.items.every(i => i.published! >= '2026-10-16')).toBe(true);
    expect(ok(await executeTool('get_market_news', { period: toolPeriod }, toolCtx())).data.items.length).toBe(3);
    const earnings = ok(await executeTool('get_earnings_calendar', { ticker: 'SYNA' }, toolCtx()));
    expect(earnings.data.items).toHaveLength(2);
    expect(factOf(earnings, 'earnings:SYNA:2026-07-30:eps_actual')).toMatchObject({ value: 2.05, as_of: '2026-07-30' });
    expect(factOf(earnings, 'earnings:SYNA:2026-10-29:eps_actual')).toBeUndefined();
  });
});
