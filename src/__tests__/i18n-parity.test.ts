import { describe, expect, it } from 'vitest';
import cs from '@/i18n/locales/cs';
import en from '@/i18n/locales/en';

// Plural forms differ by language (cs: one/few/many/other, en: one/other), so compare base keys.
const keys = (o: unknown, prefix = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k.replace(/_(zero|one|two|few|many|other)$/, '')}`]);
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
const values = (o: unknown, prefix = ''): [string, string][] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === 'object' ? values(v, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)] as [string, string]]);

describe('translations', () => {
  it('Czech and English have the same keys', () => {
    const c = new Set(keys(cs)); const e = new Set(keys(en));
    expect([...c].filter((k) => !e.has(k))).toEqual([]);
    expect([...e].filter((k) => !c.has(k))).toEqual([]);
  });

  it('every translation uses the same placeholders in both languages', () => {
    const enMap = new Map(values(en).map(([k, v]) => [k.replace(/_(zero|one|two|few|many|other)$/, ''), v]));
    const bad = values(cs)
      .map(([k, v]) => [k.replace(/_(zero|one|two|few|many|other)$/, ''), v] as const)
      .filter(([k, v]) => enMap.has(k) && placeholders(v).filter((p) => p !== 'count').join() !== placeholders(enMap.get(k)!).filter((p) => p !== 'count').join())
      .map(([k]) => k);
    expect([...new Set(bad)]).toEqual([]);
  });
});
