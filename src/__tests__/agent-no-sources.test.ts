import { describe, expect, it } from 'vitest';
import { withoutAttribution } from '../../supabase/functions/agent/core/answerTemplate.ts';

// Owner's call (2026-10-24): answers show claims, not outlets. The analyst still attributes every figure and the
// validator checks it against the cited page; only the shown text drops who published it.
const outlets = ['Yahoo Finance', 'Seeking Alpha', 'Reuters', 'CNBC', "Barron's"];
describe('answers without sources', () => {
  it.each([
    ['Cílové ceny (např. $3 000 od Bernsteina) jsou výrazně nad současnou cenou, podle n4 (podle Yahoo Finance) a n3 (podle Seeking Alpha).',
      'Cílové ceny (např. $3 000 od Bernsteina) jsou výrazně nad současnou cenou.'],
    ['Podle Reuters nižší sazby obvykle zvedají ocenění akcií. Trh už podle Reuters počítal se snížením.',
      'Nižší sazby obvykle zvedají ocenění akcií. Trh už počítal se snížením.'],
    ["Barron's píše o shortařovi, který tvrdí, že firma staví na dluh.", 'Tisk píše o shortařovi, který tvrdí, že firma staví na dluh.'],
    ['CNBC uvádí, že poptávka zůstává silná.', 'Poptávka zůstává silná.'],
    ["Tržby vzrostly o 40 % (Barron's) a marže se zlepšila.", 'Tržby vzrostly o 40 % a marže se zlepšila.'],
    ['Výsledky překonaly odhady (Zdroje: Yahoo Finance, 5. 8. 2026; Yahoo Finance, 30. 6. 2026).', 'Výsledky překonaly odhady.'],
    ['According to Reuters, demand is strong.', 'Demand is strong.'],
  ])('%s', (text, shown) => {
    expect(withoutAttribution(text, outlets)).toBe(shown);
  });
  it('keeps analyst firms and other names that are not outlets', () => {
    expect(withoutAttribution('Mizuho potvrdila doporučení Outperform s cílem 900 USD.', outlets)).toBe('Mizuho potvrdila doporučení Outperform s cílem 900 USD.');
  });
});
