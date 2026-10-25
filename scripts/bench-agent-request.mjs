// Request-level CPU benchmark (Běh 18): realistic per-question tool combinations through the real tool code
// (registry → tools → calculation bundle) over a synthetic family-sized snapshot, one fresh request context
// per sample, questions interleaved round-robin. Every synchronous model call is timed by kind (nested time
// subtracted) to calibrate the work-budget cost model; the production policy then decides each question.
//
//   node --expose-gc scripts/bench-agent-request.mjs [--sizes=1000,2500,5000] [--iterations=20] [--foreign-max=2500]
//     [--snapshots=731] [--only=overview,performance_1y] [--out=file.json]
//
// Synthetic data only; the fixture market answers in memory; no network.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TODAY = '2026-10-23';
export const QUESTIONS = {
  overview: { residences: ['CZ'], calls: [['get_portfolio_summary', {}], ['get_holdings', {}]] },
  realized_2y: { residences: ['CZ'], calls: [['get_realized_pnl', { from: '2024-10-23', to: TODAY, currency: 'CZK' }]] },
  tax_this_year: { residences: ['CZ', 'SK', 'US'], calls: [['get_tax_report', { year: 2026 }]] },
  tax_and_lots: { residences: ['CZ'], calls: [['get_tax_report', { year: 2026 }], ['get_tax_lots', {}]] },
  sale_simulation: { residences: ['CZ', 'SK', 'US'], calls: [['get_tax_lots', { ticker: 'SYNA' }],
    ['simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150, broker: 'synthetic', account: 'fixture-0' }]] },
  // The mandatory evidence of a buy analysis, exactly as agent.ts collectAnalysisEvidence plans it.
  buy_analysis: { residences: ['CZ'], calls: [['get_quote', { ticker: 'SYNA' }], ['get_analyst_view', { ticker: 'SYNA' }],
    ['get_fundamentals', { ticker: 'SYNA' }], ['get_valuation_history', { ticker: 'SYNA' }], ['get_fair_value', { ticker: 'SYNA' }],
    ['get_stock_news', { ticker: 'SYNA', period: { from: '2026-09-23', to: TODAY } }], ['get_earnings_calendar', { ticker: 'SYNA' }],
    ['get_holdings', { ticker: 'SYNA' }], ['get_allocation', {}]] },
  dividends_5y: { residences: ['CZ'], calls: [['get_dividends', { mode: 'received', from: '2021-10-23', to: TODAY }]] },
  performance_1y: { residences: ['CZ'], calls: [['get_performance', { from: '2025-10-23', to: TODAY, benchmark: 'SPX' }]] },
};

const ENTRY = `
export * as lib from './supabase/functions/agent/_lib/trackora-lib.js';
export { default as manifest } from './supabase/functions/agent/_lib/manifest.json';
export { createToolContext, workLedger } from './supabase/functions/agent/core/context.ts';
export { executeTool } from './supabase/functions/agent/core/registry.ts';
export { fixtureMarket, snapshotRepo } from './supabase/functions/agent/core/fixture.ts';
export { createRequestCpuSnapshot } from './src/test/agentRequestCpuFixture.ts';
`;

async function load() {
  const out = await build({ stdin: { contents: ENTRY, resolveDir: root, loader: 'ts', sourcefile: 'bench-request-entry.ts' }, bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'es2022', tsconfig: 'tsconfig.app.json', absWorkingDir: root });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/** A copy of the bundle whose synchronous models report their own duration (nested calls subtracted) by work kind. */
function timedLib(lib, record) {
  const stack = [];
  const timed = (kindOf, fn) => (...args) => {
    const frame = { child: 0 }; stack.push(frame);
    const start = performance.now();
    try { return fn(...args); } finally {
      const total = performance.now() - start; stack.pop();
      if (stack.length) stack[stack.length - 1].child += total;
      const kind = kindOf(...args);
      if (kind) record(kind, total - frame.child);
    }
  };
  return { ...lib,
    createCalculationCache() {
      const cache = lib.createCalculationCache(), seen = new Set();
      return { ...cache, model: cache.model,
        fifo: timed((_tx, filter) => { if (seen.has(filter)) return null; seen.add(filter); return `fifo_${filter}`; }, cache.fifo) };
    },
    computePortfolio: timed(() => 'portfolio', lib.computePortfolio),
    computeRealized: timed(() => 'realized_year', lib.computeRealized),
    computeCzTaxModel: timed(() => 'cz_tax', lib.computeCzTaxModel),
    computeInternationalTaxModel: timed(() => 'foreign_tax', lib.computeInternationalTaxModel),
    computeSaleModel: timed(input => input.jurisdiction === 'CZ' ? 'cz_sale' : 'foreign_sale', lib.computeSaleModel),
    computePerformanceModel: timed(() => 'performance', lib.computePerformanceModel),
    computeDividendModel: timed(() => 'dividend_forecast', lib.computeDividendModel),
    computeAllocationModel: timed(() => 'allocation', lib.computeAllocationModel),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
const q = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)] : null; };
const r1 = v => v === null ? null : Math.round(v * 10) / 10;

// Foreign engines grow faster than linearly (≈ 5 s per sample at 5,000 rows); above `foreignMaxSize` they are not timed.
export async function runRequestBenchmark({ sizes = [1000, 2500, 5000], iterations = 20, warmup = 3, foreignMaxSize = 2500, snapshots: snapshotDays = 731,
  only = null } = {}) {
  const m = await load();
  const production = m.manifest.cpuPolicy;
  // Measuring policy: production costs (so estimates are comparable), no caps, no budget.
  const measuring = { ...production, maxTransactions: Number.MAX_SAFE_INTEGER, maxSnapshots: Number.MAX_SAFE_INTEGER, requestWorkMs: Number.MAX_SAFE_INTEGER };
  const kindSamples = {};
  const results = [], loads = [];
  for (const size of sizes) {
    const cases = Object.entries(QUESTIONS).filter(([name]) => !only || only.includes(name)).flatMap(([name, def]) => def.residences.filter(r => r === 'CZ' || size <= foreignMaxSize).map(residence => ({ name, residence, calls: def.calls })));
    const snapshots = Object.fromEntries(['CZ', 'SK', 'US'].map(r => [r, m.createRequestCpuSnapshot(size, r, snapshotDays)]));
    const repos = Object.fromEntries(Object.entries(snapshots).map(([r, s]) => [r, m.snapshotRepo(s, `bench-${r}-${size}`)]));
    const ctxFor = (c, lib, policy) => m.createToolContext({ repo: repos[c.residence], market: m.fixtureMarket(), lib,
      budget: { startedAt: Date.now(), deadline: Date.now() + 45_000, signal: new AbortController().signal, remainingMs: () => 45_000 },
      today: TODAY, lang: 'cs', preferences: { displayCurrency: 'USD', localCurrency: 'CZK', tax: { fxMethod: 'cnb-daily', limitIncludesExempt: true } } },
    { workPolicy: policy });
    const samples = cases.map(() => ({ cpuMs: [], wallMs: [], estimateMs: null, failed: new Set() }));
    for (let i = -warmup; i < iterations; i++) {
      for (const [index, c] of cases.entries()) {
        const record = (kind, ms) => { if (i >= 0) ((kindSamples[kind] ??= {})[size] ??= []).push(ms); };
        const ctx = ctxFor(c, timedLib(m.lib, record), measuring);
        if (globalThis.gc) globalThis.gc();
        const cpu = process.cpuUsage(), wall = performance.now();
        for (const [name, args] of c.calls) {
          const result = await m.executeTool(name, args, ctx);
          if (!result.ok) samples[index].failed.add(`${name}:${result.error.code}`);
        }
        const elapsedWall = performance.now() - wall, used = process.cpuUsage(cpu);
        if (i < 0) continue;
        samples[index].cpuMs.push((used.user + used.system) / 1000);
        samples[index].wallMs.push(elapsedWall);
        samples[index].estimateMs = m.workLedger(ctx).spentMs();
      }
    }
    // Fixed per-request cost outside the models: live/repo.ts stamps every loaded snapshot (JSON, SHA-256, deep freeze).
    const loadMs = [];
    for (let i = -warmup; i < iterations; i++) {
      const data = structuredClone(snapshots.CZ);
      const start = performance.now();
      const bytes = new TextEncoder().encode(JSON.stringify({ data, asOf: new Date().toISOString() }));
      await crypto.subtle.digest('SHA-256', bytes);
      deepFreeze(data);
      if (i >= 0) loadMs.push(performance.now() - start);
    }
    loads.push({ transactions: size, snapshots: snapshotDays, p50: r1(q(loadMs, 0.5)), p95: r1(q(loadMs, 0.95)) });
    for (const [index, c] of cases.entries()) {
      // The decision the shipped policy makes for the same question.
      const ctx = ctxFor(c, m.lib, production), decision = [];
      for (const [name, args] of c.calls) {
        const result = await m.executeTool(name, args, ctx);
        decision.push(result.ok ? 'ok' : `${name}:${result.error.code}`);
      }
      const s = samples[index];
      results.push({ question: c.name, residence: c.residence, transactions: size, snapshots: snapshotDays, cpuP50: r1(q(s.cpuMs, 0.5)), cpuP95: r1(q(s.cpuMs, 0.95)),
        wallP50: r1(q(s.wallMs, 0.5)), wallP95: r1(q(s.wallMs, 0.95)), wallMax: r1(Math.max(...s.wallMs)), estimateMs: r1(s.estimateMs),
        toolFailuresWhileMeasuring: [...s.failed], production: decision.every(d => d === 'ok') ? 'answered' : `refused (${decision.filter(d => d !== 'ok').join(', ')})`,
        productionSpentMs: r1(m.workLedger(ctx).spentMs()) });
    }
  }
  const kinds = Object.fromEntries(Object.entries(kindSamples).map(([kind, bySize]) => [kind, Object.fromEntries(Object.entries(bySize)
    .map(([size, v]) => [size, { n: v.length, p50: r1(q(v, 0.5)), p95: r1(q(v, 0.95)), max: r1(Math.max(...v)), p95Per1000: r1(q(v, 0.95) / (size / 1000)) }]))]));
  return { runtime: `Node ${process.version} ${process.platform}/${process.arch}`, gc: !!globalThis.gc, iterations, warmup, foreignMaxSize,
    calculationVersion: m.manifest.calculationVersion, policy: production, results, kinds, snapshotLoadMs: loads };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  const report = await runRequestBenchmark({ sizes: (arg('sizes') ?? '1000,2500,5000').split(',').map(Number), iterations: Number(arg('iterations') ?? 20),
    foreignMaxSize: Number(arg('foreign-max') ?? 2500), snapshots: Number(arg('snapshots') ?? 731), only: arg('only')?.split(',') ?? null });
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify(report, null, 2) + '\n');
  console.table(report.results.map(({ toolFailuresWhileMeasuring, ...row }) => ({ ...row, failures: toolFailuresWhileMeasuring.join(' ') })));
  console.table(report.snapshotLoadMs);
  console.table(Object.fromEntries(Object.entries(report.kinds).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, x]) => [s, `${x.p50}/${x.p95} (${x.p95Per1000}/1k)`]))])));
}
