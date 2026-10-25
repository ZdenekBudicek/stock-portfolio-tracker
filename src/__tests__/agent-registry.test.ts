// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { createRegistry, executeTool, exportToolSchemas, projectForModel } from '../../supabase/functions/agent/core/registry.ts';
import { validateSchema } from '../../supabase/functions/agent/core/schema.ts';
import { fixtureMarket, fixtureSnapshot, snapshotRepo } from '../../supabase/functions/agent/core/fixture.ts';
import type { MarketSource } from '../../supabase/functions/agent/core/ports.ts';
import type { Fact } from '../../supabase/functions/agent/core/types.ts';
import { countingRepo, factOf, ok, testBudget, toolCtx, toolPeriod } from '../test/agentToolsFixture';

const NAMES = ['get_portfolio_summary', 'get_holdings', 'get_transactions', 'get_realized_pnl', 'get_tax_report', 'get_tax_lots',
  'simulate_sale', 'get_performance', 'get_allocation', 'get_dividends', 'get_watchlist', 'get_quote', 'get_price_history', 'get_peers',
  'get_fundamentals', 'get_valuation_history', 'get_fair_value', 'get_analyst_view', 'get_stock_news', 'get_market_news',
  'get_earnings_calendar', 'calculate', 'get_company_research', 'get_key_metrics', 'search_web'];

const samples: Record<string, unknown> = {
  get_portfolio_summary: {}, get_holdings: {}, get_transactions: { ...toolPeriod }, get_realized_pnl: { ...toolPeriod, currency: 'USD' },
  get_tax_report: { year: 2026 }, get_tax_lots: {}, simulate_sale: { ticker: 'SYNA', shares: 1, priceUsd: 150, broker: 'synthetic', account: 'A1' },
  get_performance: { ...toolPeriod, benchmark: 'SPX' }, get_allocation: {}, get_dividends: { mode: 'received', ...toolPeriod },
  get_watchlist: {}, get_quote: { ticker: 'SYNA' }, get_price_history: { ticker: 'SYNA', period: toolPeriod, benchmark: 'SPX' }, get_peers: { ticker: 'SYNN' },
  get_fundamentals: { ticker: 'SYNA' }, get_valuation_history: { ticker: 'SYNA' }, get_fair_value: { ticker: 'SYNA' },
  get_analyst_view: { ticker: 'SYNA' }, get_stock_news: { ticker: 'SYNA', period: toolPeriod }, get_market_news: { period: toolPeriod },
  get_earnings_calendar: { ticker: 'SYNA' }, get_company_research: { ticker: 'SYNA' }, get_key_metrics: { ticker: 'SYNA' }, search_web: { query: 'semiconductor outlook' },
};

function spyMarket(): { market: MarketSource; calls: string[] } {
  const inner = fixtureMarket(), calls: string[] = [];
  const market = Object.fromEntries(Object.entries(inner).map(([key, fn]) => [key, (...args: unknown[]) => {
    calls.push(key); return (fn as (...a: unknown[]) => unknown)(...args);
  }])) as unknown as MarketSource;
  return { market, calls };
}

describe('tool registry', () => {
  it('exposes exactly the 25 read-only tools (21 MVP + get_peers, Běh 22; company research, key metrics and web search, Běh 27) with JSON-serializable schemas', () => {
    const registry = createRegistry();
    expect([...registry.keys()].sort()).toEqual([...NAMES].sort());
    const schemas = exportToolSchemas();
    expect(schemas.map(s => s.name).sort()).toEqual([...NAMES].sort());
    expect(JSON.parse(JSON.stringify(schemas))).toEqual(schemas);
    for (const s of schemas) {
      expect(s.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(s.outputSchema.type).toBe('object');
      expect(['portfolio', 'dane', 'trh', 'valuace', 'obecne']).toContain(s.group);
      expect(s.description.length).toBeGreaterThan(20);
    }
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it.each(['web_search', 'get_sec_filings', 'get_broker_key', 'rpc', 'execute_sql', 'broker_connections', '__proto__', 'constructor', 'toString'])(
    'refuses %s as invalid before any read or network call', async name => {
      const { repo, calls } = countingRepo();
      const { market, calls: marketCalls } = spyMarket();
      const result = await executeTool(name, { query: 'x' }, toolCtx('A', { repo, market }));
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
      expect(calls).toEqual({ load: 0, loadHistory: 0 });
      expect(marketCalls).toEqual([]);
    });

  it('runs every tool over the fixture with outputs valid against their schemas and unique fact IDs', async () => {
    const ctx = toolCtx('A');
    const registry = createRegistry();
    const facts: Fact[] = [];
    for (const [name, args] of Object.entries(samples)) {
      const result = ok(await executeTool(name, args, ctx));
      expect(validateSchema(registry.get(name)!.outputSchema, result.data), name).toEqual([]);
      expect(result.meta.calculationVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(result.meta.snapshotId.length).toBeGreaterThan(0);
      facts.push(...result.facts);
    }
    const summary = ok(await executeTool('get_portfolio_summary', {}, ctx));
    const calc = ok(await executeTool('calculate', { op: 'subtract', inputs: [factOf(summary, 'portfolio:total_value')!.id,
      factOf(summary, 'portfolio:cash')!.id] }, ctx));
    expect(validateSchema(registry.get('calculate')!.outputSchema, calc.data)).toEqual([]);
    facts.push(...calc.facts);
    const unique = new Map(facts.map(f => [f.id, f]));
    for (const f of facts) {
      expect(unique.get(f.id)).toEqual(f);
      expect(ctx.facts.get(f.id)).toEqual(f);
      expect(f.source.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(f.as_of))).toBe(true);
    }
    expect(unique.size).toBeGreaterThan(40);
  });

  it.each([
    ['get_transactions', { from: '2026-02-30', to: '2026-03-01' }],
    ['get_transactions', { from: '2026-05-01', to: '2026-03-01' }],
    ['get_transactions', { from: '2026-01-01' }],
    ['simulate_sale', { ticker: 'SYNA', shares: -1, priceUsd: 150, broker: 'synthetic', account: 'A1' }],
    ['simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150, broker: 'synthetic', account: 'A1', saleFx: 0 }],
    ['get_quote', { ticker: 'A'.repeat(40) }],
    ['get_portfolio_summary', { foo: 1 }],
    ['get_quote', {}],
    ['get_quote', null],
    ['get_quote', { ticker: 42 }],
    ['get_tax_report', { year: 2026.5 }],
    ['get_dividends', { mode: 'received' }],
    ['get_fair_value', { ticker: 'SYNA', assumptions: { discount: 0 } }],
  ])('%s %j is invalid before any read', async (name, args) => {
    const { repo, calls } = countingRepo();
    const { market, calls: marketCalls } = spyMarket();
    expect(await executeTool(name, args, toolCtx('A', { repo, market }))).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(calls.load + marketCalls.length).toBe(0);
  });

  it('asks to clarify an unknown ticker and returns a legitimate zero for a known ticker without trades', async () => {
    const ctx = toolCtx('A');
    expect(await executeTool('get_quote', { ticker: 'nic' }, ctx)).toMatchObject({ ok: false, error: { code: 'clarify' } });
    expect(await executeTool('get_transactions', { ...toolPeriod, ticker: 'nic' }, ctx)).toMatchObject({ ok: false, error: { code: 'clarify' } });
    const watched = ok(await executeTool('get_transactions', { ...toolPeriod, ticker: 'SYNW' }, ctx));
    expect(watched.data).toMatchObject({ boughtShares: 0, soldShares: 0, buyUsd: 0, sellUsd: 0, feesUsd: 0, rows: [], totalRows: 0 });
    expect(watched.meta.complete).toBe(true);
    expect(factOf(watched, 'transactions:SYNW:buy_usd')?.value).toBe(0);
  });

  it('does not report a tax year without a profile or one in the future', async () => {
    const future = await executeTool('get_tax_report', { year: 2027 }, toolCtx('A'));
    expect(future.ok === false && ['unsupported', 'invalid'].includes(future.error.code)).toBe(true);
    const noProfile = await executeTool('get_tax_report', { year: 2025 }, toolCtx('B'));
    expect(noProfile).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });

  it('loads the snapshot once for concurrent tools within a request', async () => {
    const { repo, calls } = countingRepo();
    const ctx = toolCtx('A', { repo });
    const results = await Promise.all(['get_portfolio_summary', 'get_holdings', 'get_allocation', 'get_transactions']
      .map(name => executeTool(name, name === 'get_transactions' ? { ...toolPeriod } : {}, ctx)));
    expect(results.every(r => r.ok)).toBe(true);
    expect(calls.load).toBe(1);
  });

  it('times a hanging market read out and aborts the underlying request', async () => {
    let aborted = false;
    const market = { ...fixtureMarket(), quote: (_t: string, rc: { signal: AbortSignal }) => new Promise<never>((_r, reject) => {
      rc.signal.addEventListener('abort', () => { aborted = true; reject(rc.signal.reason); }, { once: true });
    }) } as MarketSource;
    const result = await executeTool('get_quote', { ticker: 'SYNA' }, toolCtx('A', { market, budget: testBudget(60) }));
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(aborted).toBe(true);
  });

  it('refuses an oversized history as unavailable before any synchronous model runs', async () => {
    const snapshot = fixtureSnapshot('A');
    const base = snapshot.transactions[0];
    snapshot.transactions = Array.from({ length: 5001 }, (_, i) => ({ ...base, id: `bulk-${i}`, ext_id: `synthetic:bulk:${i}` }));
    const spy = { ...lib, computePortfolio: vi.fn(lib.computePortfolio), computeRealized: vi.fn(lib.computeRealized) };
    const ctx = toolCtx('A', { repo: snapshotRepo(snapshot, 'oversize'), lib: spy as typeof lib });
    for (const [name, args] of [['get_portfolio_summary', {}], ['get_realized_pnl', { ...toolPeriod, currency: 'USD' }]] as const) {
      expect(await executeTool(name, args, ctx)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    }
    expect(spy.computePortfolio).not.toHaveBeenCalled();
    expect(spy.computeRealized).not.toHaveBeenCalled();
  });

  it('projects results for the model within 50 rows / 6000 characters, keeping provenance and dropping private fields', async () => {
    const snapshot = fixtureSnapshot('A');
    const base = snapshot.transactions[0];
    snapshot.transactions = [...snapshot.transactions, ...Array.from({ length: 200 }, (_, i) => ({ ...base, id: `p-${i}`,
      ext_id: `synthetic:p:${i}`, note: 'private', executed_at: `2026-0${1 + (i % 9)}-10T10:00:00Z` }))];
    const ctx = toolCtx('A', { repo: snapshotRepo(snapshot, 'projection') });
    const result = ok(await executeTool('get_transactions', { ...toolPeriod }, ctx));
    const projected = projectForModel('get_transactions', result) as ReturnType<typeof ok>;
    const text = JSON.stringify(projected);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).not.toMatch(/broker_account|private|"note"|ext_id/);
    expect(JSON.stringify(projected.data)).not.toMatch(/"id"|"account"/);
    expect(projected.meta).toMatchObject({ complete: result.meta.complete, warnings: expect.arrayContaining(result.meta.warnings) });
    expect(projected.facts.every(f => f.source && f.as_of)).toBe(true);
    const rows = (projected.data as { rows?: unknown[] } | null)?.rows ?? [];
    expect(rows.length).toBeLessThanOrEqual(50);
    const tax = ok(await executeTool('get_tax_report', { year: 2026 }, toolCtx('A')));
    expect(JSON.stringify(projectForModel('get_tax_report', tax))).not.toContain('kindOf');
    expect(() => JSON.stringify(tax.data)).not.toThrow();
  });
});
