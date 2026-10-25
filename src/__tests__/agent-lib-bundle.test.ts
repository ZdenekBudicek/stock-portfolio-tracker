// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { auditRuntimeGraph, auditRuntimeSource, buildAgentLib } from '../../scripts/build-agent-lib.mjs';
import { checkAgentLib, checkDeclarationArtifact } from '../../scripts/check-agent-lib.mjs';
import { runFifo, realizedUsd } from '@/lib/fifo';
import { createPortfolioFixture } from '@/test/agentPortfolioFixture';
import * as sourceLib from '@/lib/agentLib';

describe('distributed calculation bundle', () => {
  it('is reproducible, current, and has an audited runtime graph', async () => {
    const result = await buildAgentLib({ write: false });
    expect(result.manifest.schemaVersion).toBe(1);
    // The measured policy travels verbatim; it stays limited and never exceeds the largest measured history (Běh 18).
    expect(result.manifest.cpuPolicy).toEqual(JSON.parse(await readFile(new URL('../../docs/ai-assistant/cpu-policy.json', import.meta.url), 'utf8')));
    expect(result.manifest.cpuPolicy).toMatchObject({ mode: 'limited' });
    expect(result.manifest.cpuPolicy.maxTransactions).toBeLessThanOrEqual(5000);
    expect(result.manifest.cpuPolicy.maxSnapshots).toBeLessThanOrEqual(3653);
    expect(Object.keys(result.manifest.inputHashes)).toContain('src/data/cnbRates.json');
    expect(Object.keys(result.manifest.inputHashes)).toContain('src/data/cnbUsdCzk.json');
    expect(() => auditRuntimeGraph(result.metafile)).not.toThrow();
    expect(Object.keys(result.metafile.inputs)).toContain('supabase/functions/_shared/crypto.js');
    await expect(checkAgentLib()).resolves.toBeUndefined();
  }, 60000);

  it.each(['src/lib/fifo.ts', 'src/data/cnbRates.json', 'src/data/cnbUsdCzk.json', 'tsconfig.app.json'])(
    'hashes a transitive input change: %s', async path => {
      const original = await buildAgentLib({ write: false });
      const changed = await buildAgentLib({ write: false, overrides: { [path]: await readFile(path, 'utf8') + '\n' } });
      expect(changed.manifest.calculationVersion).not.toBe(original.manifest.calculationVersion);
    }, 60000);

  it('rejects stale artifacts with a repair command', async () => {
    await expect(checkAgentLib({ artifacts: { 'trackora-lib.js': 'stale' } })).rejects.toThrow('npm run build:agent-lib');
  }, 60000);

  it('imports the actual artifact in Node and matches source realized profit', async () => {
    const lib = await import(/* @vite-ignore */ pathToFileURL(`${process.cwd()}/supabase/functions/agent/_lib/trackora-lib.js`).href);
    const txs = createPortfolioFixture().transactions;
    expect(Object.keys(lib).sort()).toEqual(Object.keys(sourceLib).sort());
    expect(realizedUsd(runFifo(txs))).toBe(200);
    expect(lib.realizedUsd(lib.runFifo(txs))).toBe(200);
    expect(await readFile('supabase/functions/agent/_lib/trackora-lib.d.ts', 'utf8')).not.toMatch(/@\/|hooks\//);
  });

  it.each(['node_modules/react/index.js', 'src/hooks/usePortfolio.ts', 'src/contexts/CurrencyContext.tsx',
    'node_modules/@supabase/supabase-js/index.js', 'node_modules/xlsx/index.js', 'node_modules/pdfjs-dist/index.js', 'node:fs'])(
    'rejects a forbidden runtime dependency: %s', path => {
      expect(() => auditRuntimeGraph({ inputs: { [path]: { imports: [] } } })).toThrow('Forbidden runtime dependency');
    });

  it('rejects external environment imports even from an allowed source module', () => {
    expect(() => auditRuntimeGraph({ inputs: { 'src/lib/example.ts': { imports: [{ path: 'node:fs', external: true }] } } }))
      .toThrow('External runtime dependency');
  });

  it('checks runtime syntax rather than matching words in comments', () => {
    expect(() => auditRuntimeSource('// react process Deno\nexport const label = "fetch";')).not.toThrow();
    for (const code of ['process.cwd()', 'Deno.env.get("x")', 'window.location', 'fetch("https://example.invalid")', 'import("node:fs")']) {
      expect(() => auditRuntimeSource(code)).toThrow('Environment access');
    }
  });

  it('typechecks standalone declarations and detects a broken public type', async () => {
    const declaration = await readFile('supabase/functions/agent/_lib/trackora-lib.d.ts', 'utf8');
    expect(() => checkDeclarationArtifact(declaration)).not.toThrow();
    expect(() => checkDeclarationArtifact(declaration.replace(/usdCzk: number/g, 'usdCzk: string'))).toThrow();
  }, 60000);

  it('is unchanged by Windows checkout line endings', async () => {
    const path = 'src/lib/fifo.ts';
    const original = await buildAgentLib({ write: false });
    const crlf = await buildAgentLib({ write: false, overrides: { [path]: (await readFile(path, 'utf8')).replace(/\r?\n/g, '\r\n') } });
    expect(crlf.artifacts).toEqual(original.artifacts);
  }, 60000);

  it('reports the older coverage date when the two CNB tables differ', async () => {
    const path = 'src/data/cnbRates.json';
    const rates = JSON.parse(await readFile(path, 'utf8'));
    const result = await buildAgentLib({ write: false, overrides: { [path]: JSON.stringify({ ...rates, to: '2026-10-20' }) } });
    expect(result.manifest.cnbThrough).toBe('2026-10-20');
  }, 60000);
});
