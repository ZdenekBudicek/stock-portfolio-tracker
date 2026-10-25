// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import type { Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { keywordIntent, routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, rateLimited, routeReply, TECHNICAL } from '../test/agentLlmFixture';

// With no model available, a small deterministic keyword router picks the tools, so the verified
// template answers the question actually asked instead of a generic portfolio summary.

const plain = (text: string) => text.replace(/\u00a0|\u202f/g, ' ');
async function noModel(question: string, user: 'A' | 'B' = 'A') {
  const model = fakeModel(() => rateLimited());
  const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx({ user }), llm: llmDeps(model.fetchImpl) });
  return { text: plain(result.answer?.text ?? ''), traces: (result.answer?.trace ?? []).map(t => t.label), outcome: result.outcome };
}

describe('keywordIntent', () => {
  it.each([
    ['Kolik jsem letos nakoupil a prodal?', 'transactions'], ['Jaké transakce jsem letos udělal?', 'transactions'],
    ['Koľko som tento rok nakúpil a predal?', 'transactions'], ['How much did I buy and sell this year?', 'transactions'],
    ['What did I sell in 2025?', 'transactions'], ['Which stocks have I bought and sold?', 'transactions'],
    ['Kolik letos zaplatím daň?', 'tax'], ['Aké mám dane za tento rok?', 'tax'], ['What is my tax for 2025?', 'tax'],
    ['Kolik jsem dostal na dividendách?', 'dividends'], ['Koľko mi prišlo dividend?', 'dividends'], ['How much in dividends did I get?', 'dividends'],
    ['Jaká je cena SYNA?', 'quote'], ['Aká je cena SYNA?', 'quote'], ['What is the SYNA price?', 'quote'], ['SYNA quote', 'quote'],
    ['Jaká je cena?', undefined],
    ['Vyplatí se koupit SYNA?', 'buy'], ['Oplatí sa kúpiť SYNA?', 'buy'], ['Is SYNA worth buying?', 'buy'],
    ['Vyplatí se to?', undefined],
  ] as [string, string | undefined][])('%s → %s', (question, intent) => {
    expect(keywordIntent(question)).toBe(intent);
  });

  it('a tax question about dividends is a tax question; a price question about a buy is a buy analysis', () => {
    expect(keywordIntent('Jaká daň z dividend mě letos čeká?')).toBe('tax');
    expect(keywordIntent('Jaká je cena SYNA, vyplatí se koupit?')).toBe('buy');
  });

  it('is used when the router model is unavailable, with the inferred period', async () => {
    const model = fakeModel(() => rateLimited());
    const route = await routeQuestion('Kolik jsem loni nakoupil a prodal?', [], chatCtx(), llmDeps(model.fetchImpl));
    expect(route).toMatchObject({ intent: 'transactions', group: 'portfolio', period: { from: '2025-01-01', to: '2025-12-31' } });
  });

  it('a buy word without an instrument is not a buy analysis', async () => {
    const model = fakeModel(() => rateLimited());
    const route = await routeQuestion('How much is my portfolio worth?', [], chatCtx(), llmDeps(model.fetchImpl));
    expect(route).toMatchObject({ analysis: false });
    expect(route.group).not.toBe('valuace');
    const { text } = await noModel('How much is my portfolio worth?', 'B');
    expect(text).toMatch(/Your portfolio is worth USD 1,200/);
  });

  it('binds an explicit question to its intent even when the model suggests a different group', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'trh', lang: 'cs', tickers: ['SYNA'] }) : llmResponse({ content: '{}' }));
    const route = await routeQuestion('Kolik jsem letos nakoupil a prodal?', [], chatCtx(), llmDeps(model.fetchImpl));
    expect(route.group).toBe('portfolio');
    expect(route.intent).toBe('transactions');
    expect(route.tickers).toEqual([]);
    expect(route.analysis).toBe(false);
  });
});

describe('verified template with no model answers the actual question', () => {
  it.each([
    ['Kolik jsem letos nakoupil a prodal?', 'A', 'Obchody', [/celkem 1 obchod\b/, /prodal 2 kusy za [\d ]+(,\d+)? USD/, /nic nenakoupil/], /hodnota portfolia/],
    ['Koľko som tento rok nakúpil a predal?', 'B', 'Obchody', [/si neurobil žiadny obchod\./], /hodnota portfólia/],
    ['How much did I buy and sell this year?', 'A', 'Trades', [/1 trade in total\b/, /sold 2 units for USD [\d,]+(\.\d+)?/], /portfolio value/],
  ] as [string, 'A' | 'B', string, RegExp[], RegExp][])('transactions: %s', async (question, user, trace, expected, generic) => {
    const { text, traces, outcome } = await noModel(question, user);
    expect(traces).toContain(trace);
    for (const re of expected) expect(text).toMatch(re);
    expect(text).not.toMatch(generic);
    expect(text).not.toMatch(TECHNICAL);
    expect(outcome).toBe('fallback');
  });

  it('narrows the trades to the one ticker the question names', async () => {
    const { text } = await noModel('Kolik kusů SYNA jsem letos prodal?');
    expect(text).toMatch(/^Letos \(1\. 1\. 2026 – 23\. 10\. 2026\) jsi u SYNA nic nenakoupil a prodal 2 kusy za 300,00 USD, celkem 1 obchod\.\n/);
  });

  it.each([
    ['Kolik letos zaplatím daň?', 'A', /Odhad daně za rok 2026 je/],
    ['Aké mám dane za tento rok?', 'B', /Odhad dane za rok 2026 je/],
    ['What is my tax for this year?', 'A', /estimated tax/],
  ] as [string, 'A' | 'B', RegExp][])('tax: %s', async (question, user, expected) => {
    const { text, traces } = await noModel(question, user);
    expect(traces.some(t => /Daně|Dane|Taxes/.test(t))).toBe(true);
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/hodnota portf|portfolio value/);
  });

  it.each([
    ['Kolik jsem letos dostal na dividendách?', /ti přišly dividendy \d/],
    ['Koľko mi tento rok prišlo dividend?', /ti prišli dividendy \d/],
    ['How much in dividends did I get this year?', /you received dividends of USD/],
  ] as [string, RegExp][])('dividends: %s', async (question, expected) => {
    const { text, traces } = await noModel(question);
    expect(traces.some(t => /Dividendy|Dividends/.test(t))).toBe(true);
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/hodnota portf|portfolio value/);
  });

  it.each([
    ['Jaká je cena SYNA?', /Cena SYNA je \d/], ['Aká je cena SYNA?', /Cena SYNA je \d/], ['What is the SYNA price?', /The SYNA price is USD/],
  ] as [string, RegExp][])('quote: %s', async (question, expected) => {
    const { text, traces } = await noModel(question);
    expect(traces.some(t => /Cena|Price/.test(t))).toBe(true);
    expect(text).toMatch(expected);
  });

  it.each([
    ['Vyplatí se koupit SYNA?', 'cs', ['Analytici', 'Ocenění', 'Můj názor']],
    ['Oplatí sa kúpiť SYNA?', 'sk', ['Analytici', 'Ocenenie', 'Môj názor']],
    ['Is SYNA worth buying?', 'en', ['Analysts', 'Valuation', 'My view']],
  ] as [string, Lang, string[]][])('buy analysis: %s', async (question, _lang, headings) => {
    const { text } = await noModel(question);
    for (const heading of headings) expect(text.split('\n')).toContain(heading);
  });
});
