// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASPECTS, type Aspect, keywordAspects, mergeAspects, parseAspects } from '../../supabase/functions/agent/core/aspects.ts';
import { asksFrom, researchTopics } from '../../supabase/functions/agent/core/moveExplanation.ts';

// Běh 31: what a question about one company asks for. The question set (evals/aspects/questions.json) is shared with the
// live model eval (scripts/agent-aspect-eval.ts); here the keyword reading alone — the fallback when no model answers —
// has to pass most of it, and every case checks what must be found, what must not be added and the horizon.

type Case = { q: string; must: Aspect[]; not?: Aspect[]; years?: number; set?: string };
const CASES = (JSON.parse(readFileSync('evals/aspects/questions.json', 'utf8')) as { cases: Case[] }).cases;

export function scoreCase(c: Case, found: { aspects: Aspect[]; years: number }): string[] {
  const misses = c.must.filter(a => !found.aspects.includes(a)).map(a => `missing ${a}`);
  const extras = (c.not ?? []).filter(a => found.aspects.includes(a)).map(a => `extra ${a}`);
  const years = c.years !== undefined && found.years !== c.years ? [`years ${found.years}≠${c.years}`] : [];
  return [...misses, ...extras, ...years];
}

describe('Běh 31: aspect classification', () => {
  it('the question set is well formed: 50+ cases, known aspects only, cs/sk/en', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
    for (const c of CASES) for (const a of [...c.must, ...(c.not ?? [])]) expect(ASPECTS, `${a} in "${c.q}"`).toContain(a);
    expect(CASES.some(c => /[ěřů]/.test(c.q))).toBe(true);
    expect(CASES.some(c => /[ľôä]|Čo |Ako |Aké /.test(c.q))).toBe(true);
    expect(CASES.some(c => /^(?:What|Where|Who|Why|Is|Does|How|Give)\b/.test(c.q))).toBe(true);
  });

  it('the keyword reading (fallback without a model) passes at least 85 % of the tuning set (the held-out set is for the model eval)', () => {
    const tuning = CASES.filter(c => (c as { set?: string }).set !== 'heldout');
    const failures = tuning.map(c => ({ q: c.q, problems: scoreCase(c, keywordAspects(c.q)) })).filter(f => f.problems.length);
    const accuracy = 1 - failures.length / tuning.length;
    if (accuracy < 0.85) console.log(failures.map(f => `${f.q} → ${f.problems.join(', ')}`).join('\n'));
    expect(accuracy).toBeGreaterThanOrEqual(0.85);
  });

  it('the model\'s JSON is read strictly and merged with the keywords; the written horizon wins', () => {
    expect(parseAspects('{"aspects":["valuation","nonsense","valuation"],"years":4,"full":false}')).toEqual({ aspects: ['valuation'], years: 4, full: false });
    expect(parseAspects('{"aspects":"valuation","years":4,"full":false}')).toBeNull();
    expect(parseAspects('not json')).toBeNull();
    const q = 'Kde bude NVDA za deset let a co na to analytici?';
    const merged = mergeAspects({ aspects: ['scenarios'], years: 7, full: false }, keywordAspects(q));
    expect(merged.aspects).toEqual(expect.arrayContaining(['scenarios', 'analysts']));
    expect(merged.years).toBe(10);
    expect(merged.source).toBe('model');
    // A model's "full" analysis adds the full set.
    expect(mergeAspects({ aspects: [], years: 3, full: true }, keywordAspects('Co si myslíš o NET?')).aspects)
      .toEqual(expect.arrayContaining(['business', 'financials', 'valuation', 'analysts', 'risks']));
  });

  it('a dividend question about a named company is a company question; the own dividends stay personal', async () => {
    const { keywordIntent } = await import('../../supabase/functions/agent/core/router.ts');
    expect(keywordIntent('Vyplácí KO spolehlivou dividendu a kdo firmu vede?')).toBe('move_explanation');
    expect(keywordIntent('Kolik mi letos přišlo na dividendách?')).toBe('dividends');
    expect(keywordIntent('Jaké dividendy mi přišly od KO?')).toBe('dividends');
  });

  it('a person named in a role must be in a cited article', async () => {
    const { unbackedPerson } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const page = [{ key: 'n1', factId: 'f1', ticker: 'KO', title: 'Coca-Cola names new chief', summary: '', publisher: 'Reuters', date: '2026-10-20', url: 'https://www.reuters.com/x',
      excerpt: 'Coca-Cola said Henrique Braun will become chief executive officer, succeeding James Quincey.' }];
    expect(unbackedPerson('CEO je John D. Dorsey, který firmu vede dlouho.', page)).toBe(true);
    expect(unbackedPerson('Novým CEO bude Henrique Braun, oznámila firma.', page)).toBe(false);
    expect(unbackedPerson('Podle Reuters odchází šéf Quincey a nahradí ho Braun.', page)).toBe(false);
  });

  it('asked aspects pick the web research topics (at most four) and the sections', () => {
    expect(researchTopics(asksFrom(keywordAspects('Kdo vede firmu LUNR a prodávají insideři akcie?')))).toEqual(['management', 'analysts', 'business', 'industry']);
    expect(researchTopics(asksFrom(keywordAspects('Vyplácí TSM dividendu?')))[0]).toBe('dividends');
    expect(researchTopics(asksFrom(keywordAspects('Udělej mi podrobnou analýzu SOFI.'))).length).toBeLessThanOrEqual(4);
  });
});
