// Paired, interleaved CPU benchmark of two calculation bundles in ONE process (Běh 18).
// A = the Edge bundle as committed at a baseline revision (read with `git show`, never written to disk),
// B = the bundle in the working tree. Same synthetic input, same phased traversal, alternating order
// (A,B / B,A) so drift, thermal state, JIT and GC pressure hit both sides equally.
//
//   node --expose-gc scripts/bench-agent-paired.mjs [--baseline=b6d2cb2] [--transactions=5000] [--iterations=20]
//   node scripts/bench-agent-paired.mjs --source-identity [--baseline=3f06f81]
//
// Synthetic data only; no network.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleCpuFixture } from './bench-agent-cpu.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = 'supabase/functions/agent/_lib/trackora-lib.js';
export const PHASES = ['fifo', 'portfolio', 'realized', 'czTax', 'foreign', 'performance', 'dividends', 'allocation', 'valuation'];
const sha = text => createHash('sha256').update(text).digest('hex');
const importText = text => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The analytics traversal of Běh 5 (agentCpuFixture.computeAnalyticsCpuFixture), split into marked phases. */
export function runPhases(lib, fixture, mark) {
  const cache = lib.createCalculationCache();
  const tx = fixture.portfolio.transactions;
  cache.fifo(tx, 'real'); cache.fifo(tx, 'all'); mark('fifo');
  const portfolio = cache.model(lib.computePortfolio, fixture.portfolio); mark('portfolio');
  const common = { transactions: tx, dividends: fixture.portfolio.dividends, positions: portfolio.positions, registry: fixture.registry,
    year: 2025, today: '2025-12-31', usdCzk: 25, settings: { fxMethod: 'cnb-daily', limitIncludesExempt: true }, currency: 'USD' };
  const realized = cache.model(lib.computeRealized, common); mark('realized');
  const cz = cache.model(lib.computeCzTaxModel, common);
  if (realized.fifo !== cz.fifo) throw new Error('Compatible FIFO not reused');
  const sale = { ticker: 'SYN0', broker: 'synthetic', account: 'fixture-0', shares: 1, priceUsd: 100, feeUsd: 0, at: '2025-12-31T15:00:00Z', saleFx: 25 };
  lib.computeSaleModel({ jurisdiction: 'CZ', model: cz, transactions: tx, sale }); mark('czTax');
  for (const input of fixture.international) {
    const model = lib.computeInternationalTaxModel(input);
    if (model.status !== 'ready') throw new Error('International benchmark input rejected');
    lib.computeSaleModel({ jurisdiction: input.residence, model, sale: { ...sale, assumedLocalFx: input.residence === 'US' ? 1 : 0.9 } });
  }
  mark('foreign');
  const performance = lib.computePerformanceModel({ ...common, portfolio, snapshots: fixture.portfolio.snapshots,
    benchmark: fixture.snapshots.map((s, i) => ({ date: s.snapshot_date, close_value: 4000 + i })) });
  lib.summarizePerformance(performance, { from: '2024-01-01', to: common.today });
  if (performance.points.length !== 731) throw new Error('Incomplete performance traversal');
  mark('performance');
  lib.computeDividendModel(common); mark('dividends');
  lib.computeAllocationModel({ positions: portfolio.positions, dbPositions: fixture.portfolio.positions, profiles: new Map(), quoteCurrencies: {} });
  mark('allocation');
  lib.calculateFairValue(fixture.fundamentals, 100, undefined, fixture.closes);
  lib.medianOf(lib.valuationSeries(fixture.fundamentals, fixture.closes), 'pe'); mark('valuation');
}

function sample(lib, fixture) {
  if (globalThis.gc) globalThis.gc();
  const phases = {};
  let cpu = process.cpuUsage(), wall = performance.now();
  const totalCpu = cpu, totalWall = wall;
  runPhases(lib, fixture, name => {
    const nowWall = performance.now(), used = process.cpuUsage(cpu);
    phases[name] = { cpuMs: (used.user + used.system) / 1000, wallMs: nowWall - wall };
    cpu = process.cpuUsage(); wall = performance.now();
  });
  const used = process.cpuUsage(totalCpu);
  return { cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - totalWall, phases };
}

const p = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)]; };
const stats = values => ({ p50: +p(values, 0.5).toFixed(3), p95: +p(values, 0.95).toFixed(3), max: +Math.max(...values).toFixed(3) });

export async function runPaired({ baseline = 'b6d2cb2', transactions = 5000, iterations = 20, warmup = 3 } = {}) {
  const baseText = git('show', `${baseline}:${BUNDLE}`), headText = readFileSync(join(root, BUNDLE), 'utf8');
  const libs = { A: await importText(baseText), B: await importText(headText) };
  const fixtureModule = await importText(await bundleCpuFixture());
  const fixture = fixtureModule.createAnalyticsCpuFixture(transactions);
  const inputHash = sha(JSON.stringify(fixture, (_k, v) => v instanceof Map ? [...v] : v));
  for (let i = 0; i < warmup; i++) { sample(libs.A, fixture); sample(libs.B, fixture); }
  const samples = { A: [], B: [] };
  for (let i = 0; i < iterations; i++) for (const side of i % 2 ? ['B', 'A'] : ['A', 'B']) samples[side].push(sample(libs[side], fixture));
  const summary = side => ({ cpuMs: stats(samples[side].map(s => s.cpuMs)), wallMs: stats(samples[side].map(s => s.wallMs)),
    phasesWallMs: Object.fromEntries(PHASES.map(n => [n, stats(samples[side].map(s => s.phases[n].wallMs))])),
    phasesCpuMs: Object.fromEntries(PHASES.map(n => [n, stats(samples[side].map(s => s.phases[n].cpuMs))])) });
  // Paired difference per iteration: B − A of the same round.
  const diffs = samples.B.map((b, i) => b.cpuMs - samples.A[i].cpuMs), wallDiffs = samples.B.map((b, i) => b.wallMs - samples.A[i].wallMs);
  return { runtime: `Node ${process.version} ${process.platform}/${process.arch}`, gc: !!globalThis.gc, transactions, iterations, warmup, inputHash,
    A: { label: `${baseline}:${BUNDLE}`, sha256: sha(baseText), ...summary('A') },
    B: { label: `worktree:${BUNDLE}`, sha256: sha(headText), ...summary('B') },
    pairedCpuDiffMs: stats(diffs), pairedWallDiffMs: stats(wallDiffs),
    pairedWallDiffMedianPct: +(100 * p(wallDiffs, 0.5) / p(samples.A.map(s => s.wallMs), 0.5)).toFixed(2),
    raw: { A: samples.A.map(s => [+s.cpuMs.toFixed(1), +s.wallMs.toFixed(2)]), B: samples.B.map(s => [+s.cpuMs.toFixed(1), +s.wallMs.toFixed(2)]) } };
}

/** Builds the Běh 5 benchmark traversal from a revision's sources (git archive in a temp dir) and from the worktree; compares bytes. */
export async function sourceIdentity({ baseline = '3f06f81' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trackora-bench-'));
  try {
    const tar = join(dir, 'src.tar');
    git('archive', '-o', tar, baseline, 'src', 'supabase/functions/_shared', 'tsconfig.app.json', 'tsconfig.json');
    execFileSync('tar', ['-xf', 'src.tar'], { cwd: dir });
    const bundleAt = async at => (await build({ entryPoints: [join(at, 'src/test/agentCpuFixture.ts')], absWorkingDir: at, bundle: true, write: false,
      format: 'esm', platform: 'neutral', target: 'es2022', tsconfig: join(at, 'tsconfig.app.json'), nodePaths: [join(root, 'node_modules')] })).outputFiles[0].text;
    const [base, head] = [await bundleAt(dir), await bundleAt(root)];
    // The bundle embeds absolute source paths only in comments; strip `// path` lines before comparing.
    const code = text => text.split('\n').filter(line => !/^\s*\/\/ /.test(line)).join('\n');
    return { baseline, baselineSha256: sha(code(base)), headSha256: sha(code(head)), identical: code(base) === code(head) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  if (process.argv.includes('--source-identity')) console.info(JSON.stringify(await sourceIdentity({ baseline: arg('baseline') ?? '3f06f81' }), null, 2));
  else console.info(JSON.stringify(await runPaired({ baseline: arg('baseline') ?? 'b6d2cb2', transactions: Number(arg('transactions') ?? 5000),
    iterations: Number(arg('iterations') ?? 20) }), null, 2));
}
