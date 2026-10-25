// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { fixtureRepo } from '../../supabase/functions/agent/core/fixture.ts';
import type { Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, routeReply, shownFactIds, TECHNICAL } from '../test/agentLlmFixture';

// Běh 21d: server-owned wording reads as short sentences in natural Czech/Slovak/English (tykání), states the period
// once and never shows a raw "label: value" list for a simple answer. Numbers stay the facts' own (Běh 14 checks).

const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');
const body = (text: string) => text.split('\n\n').filter(p => !/^(Zdroje|Sources|Omezení|Obmedzenia|Limitations):/.test(p)).join('\n\n');

/** The answer to one question: `accepted` = the model selects every shown fact, `fallback` = the model draft is unusable. */
async function ask(question: string, opts: { lang?: Lang; user?: Parameters<typeof fixtureRepo>[0]; path?: 'accepted' | 'fallback' } = {}) {
  const lang = opts.lang ?? 'cs';
  const model = fakeModel(b => {
    if (isRouter(b)) return routeReply({ group: 'trh', lang, analysis: false });
    if (opts.path === 'fallback') return llmResponse({ content: '{}' });
    return llmResponse({ content: JSON.stringify({ lang, blocks: [{ kind: 'facts', factIds: shownFactIds(b) }] }) });
  });
  const result = await answerQuestion({ request: chatRequest(question), history: [] },
    { ctx: chatCtx({ lang, ...(opts.user ? { repo: fixtureRepo(opts.user) } : {}) }), llm: llmDeps(model.fetchImpl) });
  const text = plain(result.answer?.text ?? '');
  return { text, main: body(text), outcome: result.outcome };
}

function natural(text: string) {
  expect(text).not.toMatch(TECHNICAL);
  // No raw list of "label: value" lines and no nested parentheses.
  expect(text).not.toMatch(/^(?:• )?[\p{Ll} ]+(?: [A-Z]{2,5})?: [-−\d]/mu);
  expect(text).not.toMatch(/\([^()]*\(/);
  expect(text).not.toMatch(/Z ověřených dat|Z overených údajov|Verified Trackora evidence/);
}

describe('Běh 21d natural wording', () => {
  it.each([
    ['cs', 'Kolik jsem letos nakoupil a prodal?', 'Letos (1. 1. 2026 – 23. 10. 2026) jsi nic nenakoupil a prodal 2 kusy za 300,00 USD, celkem 1 obchod.'],
    ['sk', 'Koľko som tento rok nakúpil a predal?', 'Tento rok (1. 1. 2026 – 23. 10. 2026) si nič nenakúpil a predal 2 kusy za 300,00 USD, spolu 1 obchod.'],
    ['en', 'How much did I buy and sell this year?', 'This year (Jan 1, 2026 – Oct 23, 2026), you did not buy anything and sold 2 units for USD 300.00, 1 trade in total.'],
  ] as const)('transactions (%s) state the period once in one sentence', async (lang, question, expected) => {
    for (const path of ['accepted', 'fallback'] as const) {
      const r = await ask(question, { lang, path });
      expect(r.main).toBe(expected);
      natural(r.text);
    }
  });

  it('a ticker question names the ticker once', async () => {
    const r = await ask('Kolik kusů SYNA jsem letos prodal?');
    expect(r.main).toBe('Letos (1. 1. 2026 – 23. 10. 2026) jsi u SYNA nic nenakoupil a prodal 2 kusy za 300,00 USD, celkem 1 obchod.');
  });

  it.each([
    ['cs', 'Jaký zisk jsem letos realizoval?', 'Letos (1. 1. 2026 – 23. 10. 2026) jsi realizoval zisk 1 506,95 Kč. Tržby z prodejů byly 6 221,10 Kč a žádné ztráty jsi neměl.'],
    ['sk', 'Aký zisk som tento rok realizoval?', 'Tento rok (1. 1. 2026 – 23. 10. 2026) si realizoval zisk 1 506,95 CZK. Tržby z predajov boli 6 221,10 CZK a žiadne straty si nemal.'],
    ['en', 'What gains have I realised this year?', 'This year (Jan 1, 2026 – Oct 23, 2026), you realized a gain of CZK 1,506.95. Sale proceeds were CZK 6,221.10 and you had no losses.'],
  ] as const)('realized result (%s) is a sentence with its sign word', async (lang, question, expected) => {
    const r = await ask(question, { lang });
    expect(r.main).toBe(expected);
    natural(r.text);
  });

  it('a year without sales says so instead of listing zeros', async () => {
    const r = await ask('Koľko som realizoval v roku 2025? Nie tento rok.', { lang: 'sk' });
    expect(r.main).toBe('V roku 2025 si nerealizoval žiadny zisk ani stratu, výsledok je 0,00 CZK. Nemal si žiadne tržby z predajov.');
  });

  it.each([
    ['cs', 'Kolik letos zaplatím daň z prodeje akcií?', 'Odhad daně za rok 2026 je 0,00 Kč, základ daně je 0,00 Kč. Příjmy z prodejů, které se počítají do limitu pro osvobození, jsou 6 221,10 Kč, takže jsi pod limitem.'],
    ['en', 'What is my estimated tax for 2026?', 'Your estimated tax for 2026 is CZK 0.00, with a tax base of CZK 0.00. Sale proceeds counted toward the exemption limit are CZK 6,221.10, so you are under the limit.'],
  ] as const)('tax (%s) reads as sentences', async (lang, question, expected) => {
    const r = await ask(question, { lang });
    expect(r.main.split('\n')[0]).toBe(expected);
    natural(r.text);
  });

  it('a shared qualification is said once per topic and "not under the limit" is not turned into "over it"', async () => {
    const r = await ask('What is my estimated tax for 2026?', { lang: 'en', user: 'D' });
    expect(r.main.split('\n')[0]).toBe('Your estimated tax for 2026 is CZK 0.00, with a tax base of CZK 0.00. Sale proceeds counted toward the '
      + 'exemption limit are CZK 4,926.48, so you are not under the limit. The evidence is incomplete.');
    expect(r.main).not.toMatch(/over the limit|\(incomplete evidence\)/);
  });

  it.each([
    ['en', 'How much did I get in dividends this year?', 'This year (Jan 1, 2026 – Oct 23, 2026), you received dividends of USD 12.00.'],
    ['cs', 'Kolik jsem letos dostal na dividendách?', 'Letos (1. 1. 2026 – 23. 10. 2026) ti přišly dividendy 12,00 USD.'],
  ] as const)('dividends (%s)', async (lang, question, expected) => {
    const r = await ask(question, { lang });
    expect(r.main).toBe(expected);
    natural(r.text);
  });

  it.each([
    ['cs', 'Jaká je cena SYNA?', 'Cena SYNA je 150,00 USD, předchozí zavírací cena byla 148,00 USD a dnešní změna je 1,4 %.'],
    ['sk', 'Aká je cena SYNA?', 'Cena SYNA je 150,00 USD, predchádzajúca záverečná cena bola 148,00 USD a dnešná zmena je 1,4 %.'],
    ['en', 'What is the price of SYNA?', 'The SYNA price is USD 150.00, the previous close was USD 148.00 and today\'s change is 1.4%.'],
  ] as const)('quote (%s)', async (lang, question, expected) => {
    for (const path of ['accepted', 'fallback'] as const) {
      const r = await ask(question, { lang, path });
      expect(r.main).toBe(expected);
      natural(r.text);
    }
  });

  it.each([
    ['sk', 'Čo držím v portfóliu?', 'Zatiaľ nič nedržíš, hodnota portfólia je 0,00 USD.'],
    ['cs', 'Co držím v portfoliu?', 'Zatím nic nedržíš, hodnota portfolia je 0,00 USD.'],
    ['en', 'What do I hold in my portfolio?', 'You do not hold anything yet, so your portfolio is worth USD 0.00.'],
  ] as const)('an empty portfolio (%s) is one sentence, not a repeated count', async (lang, question, expected) => {
    const r = await ask(question, { lang, user: 'E' });
    expect(r.main).toBe(expected);
    natural(r.text);
  });

  it.each([
    ['cs', 'Co držím v portfoliu?', 'Tvoje portfolio má hodnotu 3 050,74 USD. Držíš 10 kusů SYNA v hodnotě 1 500 USD a 5 kusů SYNB v hodnotě 1 050 USD. Hotovost má hodnotu 500,00 USD.'],
    ['en', 'What do I hold?', 'Your portfolio is worth USD 3,050.74. You hold 10 units of SYNA worth USD 1,500 and 5 units of SYNB worth USD 1,050. Your cash is worth USD 500.00.'],
  ] as const)('holdings (%s) are one sentence and cash is cash, not units', async (lang, question, expected) => {
    const r = await ask(question, { lang, path: 'fallback' });
    expect(r.main.replace(/\n/g, ' ')).toBe(expected);
    expect(r.main).not.toMatch(/CASH/);
  });

  it('portfolio value (en) keeps cash and profit meanings in sentences', async () => {
    const r = await ask('How much is my portfolio worth?', { lang: 'en', user: 'B', path: 'fallback' });
    expect(r.main).toBe('Your portfolio is worth USD 1,200, of which cash is USD 100.00. Your total profit is USD 199.00, of which USD 99.00 is unrealized.');
    natural(r.text);
  });

  it.each(['cs', 'sk', 'en'] as const)('buy analysis (%s) has no nested parentheses and keeps its structure', async lang => {
    const question = { cs: 'Vyplatí se teď koupit SYNA?', sk: 'Oplatí sa teraz kúpiť SYNA?', en: 'Is SYNA worth buying now?' }[lang];
    const model = fakeModel(b => isRouter(b) ? routeReply({ group: 'valuace', lang, tickers: ['SYNA'], analysis: true }) : llmResponse({ content: '{}' }));
    const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx({ lang }), llm: llmDeps(model.fetchImpl) });
    const text = plain(result.answer?.text ?? '');
    expect(text).not.toMatch(/\([^()]*\(/);
    expect(text).toMatch({ cs: /percentil 100,0 % \(19\. 6\. 2026 – 22\. 10\. 2026\)/, sk: /percentil 100,0 % \(19\. 6\. 2026 – 22\. 10\. 2026\)/,
      en: /percentile 100\.0% \(Jun 19, 2026 – Oct 22, 2026\)/ }[lang]);
    expect(text).toMatch({ cs: /Cena vůči ocenění: spíš atraktivní/, sk: /Cena voči oceneniu: skôr atraktívna/, en: /Price vs valuation: rather attractive/ }[lang]);
  });
});
