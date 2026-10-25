import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactDir, buildAgentLib } from './build-agent-lib.mjs';
import ts from 'typescript';

export function checkDeclarationArtifact(text) {
  const declaration = resolve(artifactDir, 'trackora-lib.d.ts');
  const consumer = resolve(artifactDir, '__contract.ts');
  const root = resolve(artifactDir, '../../../..');
  const options = { noEmit: true, skipLibCheck: false, strict: false, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true, baseUrl: root, paths: { '@/*': ['./src/*'] } };
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  const source = `import * as source from '../../../../src/lib/agentLib';
import * as bundle from './trackora-lib.js';
const toSource: Pick<typeof source, keyof typeof bundle> = {} as typeof bundle;
const toBundle: typeof bundle = {} as typeof source;
const sourceProfile: source.TaxProfile = {} as bundle.TaxProfile;
const bundleProfile: bundle.TaxProfile = {} as source.TaxProfile;
`;
  host.fileExists = file => [declaration, consumer].includes(resolve(file)) || exists(file);
  host.readFile = file => resolve(file) === declaration ? text : resolve(file) === consumer ? source : read(file);
  const program = ts.createProgram([consumer], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
}

export async function checkAgentLib({ artifacts = {} } = {}) {
  const expected = await buildAgentLib({ write: false });
  for (const [name, text] of Object.entries(expected.artifacts)) {
    let actual;
    try { actual = artifacts[name] ?? await readFile(resolve(artifactDir, name), 'utf8'); } catch { actual = null; }
    if (actual?.replaceAll('\r\n', '\n') !== text.replaceAll('\r\n', '\n')) {
      throw new Error(`Stale or missing ${name}. Run npm run build:agent-lib and commit the sources and all three artifacts together.`);
    }
  }
  checkDeclarationArtifact(expected.artifacts['trackora-lib.d.ts']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkAgentLib();
  console.info('Calculation bundle, declarations and manifest are current.');
}
