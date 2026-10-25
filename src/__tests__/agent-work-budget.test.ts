// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import manifest from '../../supabase/functions/agent/_lib/manifest.json';
import { fixtureMarket, snapshotRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { createToolContext, workLedger } from '../../supabase/functions/agent/core/context.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { ToolInputError } from '../../supabase/functions/agent/core/types.ts';
import { createWorkLedger, estimateWorkMs, WORK_KINDS, WORK_LIMIT_MESSAGE, type WorkPolicy } from '../../supabase/functions/agent/core/workBudget.ts';
import { createRequestCpuSnapshot, REQUEST_TODAY } from '../test/agentRequestCpuFixture';
import { errorOf, ok, testBudget, toolPreferences } from '../test/agentToolsFixture';

const costs = (perKind: number) => Object.fromEntries(WORK_KINDS.map(k => [k, { fixedMs: 0, per1000TransactionsMs: perKind }])) as WorkPolicy['costs'];
const policy = (over: Partial<WorkPolicy> = {}): WorkPolicy =>
  ({ mode: 'limited', maxTransactions: 1000, maxSnapshots: 731, requestWorkMs: 100, costs: costs(10), ...over });
const size = { transactions: 1000, snapshots: 731 };

describe('request work ledger', () => {
  it('estimates fixed plus per-1,000-transaction and per-1,000-snapshot cost', () => {
    const p = policy({ costs: { ...costs(10), foreign_tax: { fixedMs: 5, per1000TransactionsMs: 200 },
      performance: { fixedMs: 1, per1000TransactionsMs: 2, per1000SnapshotsMs: 4 } } });
    expect(estimateWorkMs(p, 'foreign_tax', { transactions: 2500, snapshots: 731 })).toBe(505);
    expect(estimateWorkMs(p, 'cz_tax', { transactions: 500, snapshots: 0 })).toBe(5);
    expect(estimateWorkMs(p, 'performance', { transactions: 1000, snapshots: 2000 })).toBe(11);
  });

  it('refuses before starting synchronous work that would exceed the request budget', () => {
    const ledger = createWorkLedger(policy());
    const first = vi.fn(() => 1), second = vi.fn(() => 2);
    expect(ledger.run('a', size, ['cz_tax', 'portfolio'], first)).toBe(1);
    expect(ledger.spentMs()).toBe(20);
    // 20 spent + 9 × 10 estimated > 100: refused, the work never starts and nothing is charged.
    expect(() => ledger.run('b', size, Array(9).fill('realized_year'), second)).toThrow(WORK_LIMIT_MESSAGE);
    expect(second).not.toHaveBeenCalled();
    expect(ledger.spentMs()).toBe(20);
    try { ledger.run('b', size, Array(9).fill('realized_year'), second); } catch (error) {
      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as ToolInputError).code).toBe('unavailable');
    }
  });

  it('memoizes identical computations of one request and charges them once', () => {
    const ledger = createWorkLedger(policy());
    const work = vi.fn(() => ({ model: true }));
    const value = ledger.run('cz_tax:2026', size, ['fifo_real', 'cz_tax'], work);
    expect(ledger.run('cz_tax:2026', size, ['fifo_real', 'cz_tax'], work)).toBe(value);
    expect(work).toHaveBeenCalledTimes(1);
    expect(ledger.spentMs()).toBe(20);
  });

  it('charges the shared FIFO once per request, whichever model needs it first', () => {
    const ledger = createWorkLedger(policy());
    ledger.run('cz', size, ['fifo_real', 'cz_tax'], () => 1);
    ledger.run('realized', size, ['fifo_real', 'realized_year', 'realized_year'], () => 2);
    expect(ledger.spentMs()).toBe(40);
  });

  it('a failed computation is not cached', () => {
    const ledger = createWorkLedger(policy());
    expect(() => ledger.run('x', size, ['allocation'], () => { throw new Error('boom'); })).toThrow('boom');
    expect(ledger.run('x', size, ['allocation'], () => 3)).toBe(3);
  });

  it('keeps the hard history caps and never truncates', () => {
    const ledger = createWorkLedger(policy());
    const work = vi.fn(() => 1);
    expect(() => ledger.run('a', { transactions: 1001, snapshots: 0 }, ['portfolio'], work)).toThrow(/rozsáhlou historii/);
    expect(() => ledger.run('a', { transactions: 10, snapshots: 732 }, ['portfolio'], work)).toThrow(/rozsáhlou historii/);
    expect(work).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid policy', () => {
    for (const bad of [policy({ requestWorkMs: NaN }), policy({ requestWorkMs: -1 }), { ...policy(), costs: {} } as unknown as WorkPolicy,
      policy({ costs: { ...costs(10), cz_tax: { fixedMs: -1, per1000TransactionsMs: 1 } } }),
      policy({ costs: { ...costs(10), performance: { fixedMs: 0, per1000TransactionsMs: 1, per1000SnapshotsMs: NaN } } })]) {
      const work = vi.fn(() => 1);
      expect(() => createWorkLedger(bad).run('a', { transactions: 1, snapshots: 1 }, ['cz_tax'], work)).toThrow(ToolInputError);
      expect(work).not.toHaveBeenCalled();
    }
  });

  it('the distributed policy is limited, keeps the measured caps and has a cost for every kind', () => {
    const p = manifest.cpuPolicy as unknown as WorkPolicy;
    expect(p.mode).toBe('limited');
    expect(p.requestWorkMs).toBeGreaterThan(0);
    expect(p.requestWorkMs).toBeLessThanOrEqual(1200);
    for (const kind of WORK_KINDS) expect(p.costs[kind].per1000TransactionsMs).toBeGreaterThan(0);
  });
});

/* ----------------------------- tools share one request budget ----------------------------- */

function requestCtx(snapshotSize: number, over: { policy?: WorkPolicy; lib?: typeof lib; residence?: 'CZ' | 'SK' } = {}) {
  const snapshot = createRequestCpuSnapshot(snapshotSize, over.residence ?? 'CZ');
  return createToolContext({ repo: snapshotRepo(snapshot, `work-${snapshotSize}`), market: fixtureMarket(),
    lib: over.lib ?? lib, budget: testBudget(), today: REQUEST_TODAY, lang: 'cs', preferences: toolPreferences },
  over.policy ? { workPolicy: over.policy } : {});
}

const spyLib = () => {
  const counts = { realized: 0, cz: 0, foreign: 0 };
  const wrapped = { ...lib,
    computeRealized: ((...a: Parameters<typeof lib.computeRealized>) => { counts.realized++; return lib.computeRealized(...a); }) as typeof lib.computeRealized,
    computeCzTaxModel: ((...a: Parameters<typeof lib.computeCzTaxModel>) => { counts.cz++; return lib.computeCzTaxModel(...a); }) as typeof lib.computeCzTaxModel,
    computeInternationalTaxModel: ((...a: Parameters<typeof lib.computeInternationalTaxModel>) => { counts.foreign++; return lib.computeInternationalTaxModel(...a); }) as typeof lib.computeInternationalTaxModel,
  };
  return { counts, lib: wrapped as typeof lib };
};

describe('request-level work budget across tools', () => {
  it('rejects a dividend period longer than 30 years before any read', async () => {
    const result = await executeTool('get_dividends', { mode: 'received', from: '1990-01-01', to: REQUEST_TODAY }, requestCtx(100));
    expect(errorOf(result)?.code).toBe('invalid');
  });

  it('computes the Czech model once for the tax report, the lots and a simulated sale of the same year', async () => {
    const spy = spyLib(), p = policy({ requestWorkMs: 1000 });
    const ctx = requestCtx(400, { lib: spy.lib, policy: p });
    ok(await executeTool('get_tax_report', { year: 2026 }, ctx));
    const afterReport = workLedger(ctx).spentMs();
    ok(await executeTool('get_tax_lots', {}, ctx));
    expect(workLedger(ctx).spentMs()).toBe(afterReport);
    ok(await executeTool('simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150, broker: 'synthetic', account: 'fixture-0' }, ctx));
    expect(spy.counts.cz).toBe(1);
    // Only the sale itself is new work.
    expect(workLedger(ctx).spentMs()).toBe(afterReport + estimateWorkMs(p, 'cz_sale', { transactions: 400, snapshots: 731 }));
  });

  it('counts every tool of the request: a later tool is refused before its synchronous work starts', async () => {
    const spy = spyLib();
    // 1,000 transactions × 10 ms per kind: the priced portfolio (fifo_all, fifo_real, portfolio) and the Czech tax model fit
    // into 60 ms; three realized years (30 ms) would exceed it.
    const ctx = requestCtx(1000, { lib: spy.lib, policy: policy({ requestWorkMs: 60 }) });
    ok(await executeTool('get_tax_report', { year: 2026 }, ctx));
    const refused = await executeTool('get_realized_pnl', { from: '2024-01-01', to: REQUEST_TODAY, currency: 'CZK' }, ctx);
    expect(errorOf(refused)).toEqual({ code: 'unavailable', message: WORK_LIMIT_MESSAGE });
    expect(spy.counts.realized).toBe(0);
    // A new request has its own budget.
    const next = requestCtx(1000, { lib: spy.lib, policy: policy({ requestWorkMs: 60 }) });
    ok(await executeTool('get_realized_pnl', { from: '2024-01-01', to: REQUEST_TODAY, currency: 'CZK' }, next));
    expect(spy.counts.realized).toBe(3);
  });

  it('charges a multi-year dividend loop as one unit up front: refused whole, never partially computed', async () => {
    const spy = spyLib();
    const ctx = requestCtx(1000, { lib: spy.lib, policy: policy({ requestWorkMs: 40 }) });
    const refused = await executeTool('get_dividends', { mode: 'received', from: '2021-11-01', to: REQUEST_TODAY }, ctx);
    expect(errorOf(refused)?.message).toBe(WORK_LIMIT_MESSAGE);
    expect(spy.counts.realized).toBe(0);
    const year = ok(await executeTool('get_dividends', { mode: 'received', from: '2026-01-01', to: REQUEST_TODAY }, ctx));
    expect(year.data.received.count).toBeGreaterThan(0);
    expect(spy.counts.realized).toBe(1);
  });

  it('repeating an identical realized question in one request reuses the computed years', async () => {
    const spy = spyLib();
    const ctx = requestCtx(400, { lib: spy.lib, policy: policy({ requestWorkMs: 1000 }) });
    const args = { from: '2025-01-01', to: REQUEST_TODAY, currency: 'CZK' };
    const first = ok(await executeTool('get_realized_pnl', args, ctx));
    const spent = workLedger(ctx).spentMs();
    const second = ok(await executeTool('get_realized_pnl', args, ctx));
    expect(second.data).toEqual(first.data);
    expect(spy.counts.realized).toBe(2);
    expect(workLedger(ctx).spentMs()).toBe(spent);
  });

  it('refuses a foreign tax engine over a large history with a human message, keeping Czech answers', async () => {
    const spy = spyLib();
    const p = policy({ maxTransactions: 5000, requestWorkMs: 600,
      costs: { ...costs(5), foreign_tax: { fixedMs: 0, per1000TransactionsMs: 250 } } });
    const foreign = requestCtx(5000, { lib: spy.lib, policy: p, residence: 'SK' });
    expect(errorOf(await executeTool('get_tax_report', { year: 2026 }, foreign))?.message).toBe(WORK_LIMIT_MESSAGE);
    expect(spy.counts.foreign).toBe(0);
    ok(await executeTool('get_tax_report', { year: 2026 }, requestCtx(5000, { lib: spy.lib, policy: p })));
  });

  it('the shipped policy answers Czech questions over 5,000 trades and refuses a foreign engine above its measured envelope', async () => {
    const spy = spyLib();
    const cz = requestCtx(5000, { lib: spy.lib });
    ok(await executeTool('get_tax_report', { year: 2026 }, cz));
    ok(await executeTool('get_realized_pnl', { from: '2024-01-01', to: REQUEST_TODAY, currency: 'CZK' }, cz));
    ok(await executeTool('get_dividends', { mode: 'received', from: '2021-10-23', to: REQUEST_TODAY }, cz));
    ok(await executeTool('get_performance', { from: '2025-10-23', to: REQUEST_TODAY }, cz));
    expect(workLedger(cz).spentMs()).toBeLessThan(workLedger(cz).policy.requestWorkMs / 2);
    const foreign = requestCtx(1000, { lib: spy.lib, residence: 'SK' });
    expect(errorOf(await executeTool('get_tax_report', { year: 2026 }, foreign))?.message).toBe(WORK_LIMIT_MESSAGE);
    expect(spy.counts.foreign).toBe(0);
    // Beyond the largest measured history nothing starts at all.
    expect(errorOf(await executeTool('get_portfolio_summary', {}, requestCtx(5001)))?.message).toMatch(/rozsáhlou historii/);
  });
});
