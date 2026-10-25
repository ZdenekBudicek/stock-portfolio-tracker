import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** @typedef {{transactions:number,iterations:number,nodeCpuMs:number[],computeWallMs:number[],runtime:string,inputHash:string}} CpuReport */
export async function bundleCpuFixture() {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/test/agentCpuFixture.ts', import.meta.url))],
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', tsconfig: 'tsconfig.app.json' });
  return result.outputFiles[0].text;
}

/** @returns {Promise<CpuReport>} */
export async function runCpuBenchmark({ transactions = 5000, iterations = 20, portfolio = false, analytics = false } = {}) {
  if (!Number.isInteger(transactions) || transactions < 100 || !Number.isInteger(iterations) || iterations < 1) throw new Error('Invalid benchmark size');
  const source = await bundleCpuFixture();
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const create = analytics ? module.createAnalyticsCpuFixture : portfolio ? module.createPortfolioCpuFixture : module.createCpuFixture;
  const compute = analytics ? module.computeAnalyticsCpuFixture : portfolio ? module.computePortfolioCpuFixture : module.computeCpuFixture;
  const fixture = create(transactions);
  const inputHash = createHash('sha256').update(JSON.stringify(fixture, (_key, value) => value instanceof Map ? [...value] : value)).digest('hex');
  for (let i = 0; i < 3; i++) compute(fixture);
  const nodeCpuMs = [], computeWallMs = [];
  for (let i = 0; i < iterations; i++) {
    const cpu = process.cpuUsage(), wall = performance.now();
    const result = compute(fixture);
    computeWallMs.push(performance.now() - wall);
    const elapsed = process.cpuUsage(cpu);
    nodeCpuMs.push((elapsed.user + elapsed.system) / 1000);
    if (!result.sales.rows.length || result.performance.length !== 731) throw new Error('Incomplete benchmark traversal');
  }
  return { transactions, iterations, nodeCpuMs, computeWallMs, runtime: `Node ${process.version} ${process.platform}/${process.arch}`, inputHash };
}

export async function runDenoWallBenchmark({ portfolio = false, analytics = false, transactions = 5000 } = {}) {
  if (!Number.isInteger(transactions) || transactions < 100) throw new Error('Invalid benchmark size');
  const source = await bundleCpuFixture();
  const program = `${source}
const compute = ${analytics ? 'computeAnalyticsCpuFixture' : portfolio ? 'computePortfolioCpuFixture' : 'computeCpuFixture'};
const fixture = ${analytics ? 'createAnalyticsCpuFixture' : portfolio ? 'createPortfolioCpuFixture' : 'createCpuFixture'}(${transactions});
const serialized = JSON.stringify(fixture, (_key, value) => value instanceof Map ? [...value] : value);
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
const inputHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
for (let i = 0; i < 3; i++) compute(fixture);
const computeWallMs = [];
for (let i = 0; i < 20; i++) {
  const start = performance.now();
  const result = compute(fixture);
  computeWallMs.push(performance.now() - start);
  if (!result.sales.rows.length || result.performance.length !== 731) throw new Error('Incomplete traversal');
}
console.log(JSON.stringify({ transactions: ${transactions}, iterations: 20, computeWallMs, runtime: 'Deno ' + Deno.version.deno, inputHash, edgeCpuMs: null }));`;
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd --no-install deno run --cached-only --no-config -'], { input: program, encoding: 'utf8', windowsHide: true })
    : spawnSync('npx', ['--no-install', 'deno', 'run', '--cached-only', '--no-config', '-'], { input: program, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Deno benchmark failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portfolio = process.argv.includes('--portfolio');
  const analytics = process.argv.includes('--analytics');
  const transactions = Number(process.argv.find(arg => arg.startsWith('--transactions='))?.split('=')[1] ?? 5000);
  console.info(JSON.stringify(process.argv.includes('--deno-wall') ? await runDenoWallBenchmark({ portfolio, analytics, transactions })
    : await runCpuBenchmark({ transactions, iterations: 20, portfolio, analytics }), null, 2));
}
