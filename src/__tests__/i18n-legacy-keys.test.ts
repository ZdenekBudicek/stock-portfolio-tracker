import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import cs from '@/i18n/locales/cs/legacy';
import en from '@/i18n/locales/en/legacy';

const pluralSuffix = /_(one|few|many|other)$/;
const flatten = (value: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof entry === 'string' ? [[path, entry]] : Object.entries(flatten(entry as Record<string, unknown>, path));
  }));
const baseKeys = (value: Record<string, string>) => [...new Set(Object.keys(value).map(key => key.replace(pluralSuffix, '')))].sort();
const placeholders = (value: string) => [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)].map(match => match[1]).sort();
const csKeys = flatten(cs);
const enKeys = flatten(en);

// All legacy components use literal keys, so this also catches typos and missing entries.
const sources = import.meta.glob(['../components/*.tsx', '../pages/*.tsx'], { eager: true, query: '?raw', import: 'default' });
const usedKeys = [...new Set(Object.values(sources).flatMap(source =>
  [...String(source).matchAll(/\bt\(['"]legacy\.([^'"]+)['"]/g)].map(match => match[1])))];

describe('legacy translations', () => {
  it('has the same Czech and English keys, ignoring plural suffixes', () => {
    expect(baseKeys(csKeys)).toEqual(baseKeys(enKeys));
  });

  it('resolves every key used by the components in both languages', async () => {
    const i18n = createInstance();
    await i18n.init({ resources: { cs: { translation: { legacy: cs } }, en: { translation: { legacy: en } } }, fallbackLng: false });
    for (const lng of ['cs', 'en']) {
      for (const key of usedKeys) {
        for (const count of [0, 1, 2, 5, 1.5]) {
          expect(i18n.exists(`legacy.${key}`, { lng, count }), `${lng}: ${key}, count=${count}`).toBe(true);
        }
      }
    }
  });

  it('keeps interpolation parameters and all required plural forms', () => {
    for (const [key, value] of Object.entries(csKeys)) {
      const englishKey = key.replace(/_(few|many)$/, '_other');
      expect(placeholders(value), key).toEqual(placeholders(enKeys[englishKey]));
      if (pluralSuffix.test(key)) {
        const base = key.replace(pluralSuffix, '');
        for (const suffix of ['one', 'few', 'many', 'other']) expect(csKeys).toHaveProperty(`${base}_${suffix}`);
        for (const suffix of ['one', 'other']) expect(enKeys).toHaveProperty(`${base}_${suffix}`);
      }
    }
  });

  it('selects Czech and English plurals without changing the original Czech wording', async () => {
    const i18n = createInstance();
    await i18n.init({ resources: { cs: { translation: { legacy: cs } }, en: { translation: { legacy: en } } }, fallbackLng: false });
    expect(i18n.t('legacy.taxReport.years', { lng: 'cs', count: 1 })).toBe('1 rok');
    expect(i18n.t('legacy.taxReport.years', { lng: 'cs', count: 3 })).toBe('3 roky');
    expect(i18n.t('legacy.taxReport.years', { lng: 'cs', count: 5 })).toBe('5 let');
    expect(i18n.t('legacy.dividendTracker.dividendCount', { lng: 'cs', count: 1 })).toBe('1 dividenda');
    expect(i18n.t('legacy.dividendTracker.dividendCount', { lng: 'en', count: 1 })).toBe('1 dividend');
    expect(i18n.t('legacy.dividendTracker.dividendCount', { lng: 'en', count: 2 })).toBe('2 dividends');
  });
});
