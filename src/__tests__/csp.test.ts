// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The production CSP (vercel.json) must allow every origin the app really loads from, or a page breaks only in
// production. Images and fetches with a literal https:// origin in src/ are checked against img-src / connect-src.
const csp = (JSON.parse(readFileSync('vercel.json', 'utf8')).headers as { headers: { key: string; value: string }[] }[])
  .flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy')!.value;
const directive = (name: string) => (csp.split(';').map(d => d.trim().split(/\s+/)).find(d => d[0] === name) ?? []).slice(1);
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === '__tests__' || f === 'test' ? [] : files(p)) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const sources = files('src').map(f => readFileSync(f, 'utf8'));
const origins = (re: RegExp) => [...new Set(sources.flatMap(s => [...s.matchAll(re)].map(m => new URL(m[1]).origin)))];

describe('production Content-Security-Policy', () => {
  it('blocks framing, plugins, foreign scripts and base tags', () => {
    expect(directive('default-src')).toEqual(["'self'"]);
    expect(directive('script-src')).toEqual(["'self'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
  });
  it('allows every image origin written in src/', () => {
    const images = origins(/['`"](https:\/\/[a-z0-9.-]+)\/[^'`"]*\.(?:png|svg|jpe?g|webp)/g)
      .concat(origins(/['`"](https:\/\/assets\.parqet\.com)\//g));
    expect(images.length).toBeGreaterThan(1);
    for (const o of images) expect(directive('img-src'), o).toContain(o);
  });
  it('allows every fetch origin written in src/ and the project Supabase (HTTP and realtime)', () => {
    for (const o of origins(/fetch\(\s*['`"](https:\/\/[a-z0-9.-]+)/g)) expect(directive('connect-src'), o).toContain(o);
    const ref = /project_id\s*=\s*"([a-z0-9-]+)"/.exec(readFileSync('supabase/config.toml', 'utf8'))![1];
    expect(directive('connect-src')).toEqual(expect.arrayContaining([`https://${ref}.supabase.co`, `wss://${ref}.supabase.co`]));
  });
  it('allows the Google font stylesheet and font files the CSS imports', () => {
    expect(readFileSync('src/index.css', 'utf8')).toContain('https://fonts.googleapis.com');
    expect(directive('style-src')).toContain('https://fonts.googleapis.com');
    expect(directive('font-src')).toContain('https://fonts.gstatic.com');
  });
});
