// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as parsers from '../../supabase/functions/_shared/price-parsers.ts';
import * as providers from '../../supabase/functions/_shared/price-providers.ts';

const root = process.cwd();
const agentDir = resolve(root, 'supabase/functions/agent');
const YAHOO_HOST = /(^|[^a-z0-9-])([a-z0-9-]+\.)*yahoo\.com\b/i;
const code = new Set(['.ts', '.js', '.mjs', '.mts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'scripts' || name === 'node_modules' ? [] : sourceFiles(path);
    return code.has(extname(path)) && !path.endsWith('.d.ts') ? [path] : [];
  });
}

// String, template and regex literals only: a host named in a comment cannot be fetched.
function literals(path: string): { imports: string[]; texts: string[] } {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [], texts: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      // A computed dynamic import would hide part of the graph from this check.
      imports.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '<computed>');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      imports.push(node.argument.literal.text);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node)) texts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, texts };
}

function agentGraph() {
  const seen = new Set<string>(), external = new Set<string>(), queue = sourceFiles(agentDir);
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!code.has(extname(path))) continue;
    for (const spec of literals(path).imports) {
      if (!spec.startsWith('.')) { external.add(spec); continue; }
      const target = resolve(dirname(path), spec);
      if (!existsSync(target)) throw new Error(`Unresolved import ${spec} in ${relative(root, path)}`);
      queue.push(target);
    }
  }
  return { files: [...seen].map(p => relative(root, p).replace(/\\/g, '/')).sort(), external: [...external].sort() };
}

describe('agent Edge import graph', () => {
  it('contains no module that references a Yahoo host', () => {
    const { files, external } = agentGraph();
    expect(files).toContain('supabase/functions/agent/live/market.ts');
    expect(files).toContain('supabase/functions/_shared/price-parsers.ts');
    expect(files).not.toContain('supabase/functions/_shared/price-providers.ts');
    expect(external.every(spec => /^(npm|jsr):/.test(spec))).toBe(true);
    // Yahoo pages may be cited and linked as news sources (link allowlist and publisher names), but the
    // Edge function must never call a Yahoo host: only those two link/name tables may mention one.
    const LINK_ONLY = new Set(['supabase/functions/agent/core/guards.ts', 'supabase/functions/agent/core/articleText.ts']);
    const offenders = files.filter(f => !LINK_ONLY.has(f) && (f.endsWith('.json') ? YAHOO_HOST.test(readFileSync(resolve(root, f), 'utf8'))
      : literals(resolve(root, f)).texts.some(t => YAHOO_HOST.test(t))));
    expect(offenders).toEqual([]);
    // Walks the whole Edge import graph: allowed to be slow under a full parallel run.
  }, 60_000);

  it('never lets the market fetcher call a Yahoo host (the network guard behind the rule above)', () => {
    const src = readFileSync(resolve(root, 'supabase/functions/agent/live/marketFetch.ts'), 'utf8');
    expect(YAHOO_HOST.test(src)).toBe(false);
  });

  it('detects a Yahoo host where one exists (control for the check above)', () => {
    const path = resolve(root, 'supabase/functions/_shared/price-providers.ts');
    expect(literals(path).texts.some(t => YAHOO_HOST.test(t))).toBe(true);
    expect(YAHOO_HOST.test('BTC-USD')).toBe(false);
    expect(YAHOO_HOST.test('yahoo_symbol')).toBe(false);
  });

  it('re-exports the identical parser functions from price-providers', () => {
    for (const name of ['parseFinnhubQuote', 'parseTwelveData', 'parseBinance', 'parseCoinGecko'] as const) {
      expect(providers[name]).toBe(parsers[name]);
    }
  });
});
