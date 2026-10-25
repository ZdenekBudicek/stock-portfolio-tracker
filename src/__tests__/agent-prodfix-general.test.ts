// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { fixtureMarket } from '../../supabase/functions/agent/core/fixture.ts';
import { estimateInputTokens } from '../../supabase/functions/agent/core/llm.ts';
import type { NewsItem } from '../../supabase/functions/agent/core/marketTypes.ts';
import type { MarketSource } from '../../supabase/functions/agent/core/ports.ts';
import { explainPrompt, MAIN_PROMPT_TOKENS, ROUTER_PROMPT, ROUTER_PROMPT_TOKENS } from '../../supabase/functions/agent/core/prompts.ts';
import type { Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { isFinanceQuestion, keywordIntent, routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import { allText, chatCtx, chatRequest, fakeModel, isRouter, lastUser, llmDeps, llmResponse, rateLimited, routeReply, shownFactIds,
  TECHNICAL } from '../test/agentLlmFixture';

// Production fix (2026-10-24): "Co se dnes děje s mými akciemi?" was answered with the off-topic text. The router may no
// longer refuse a question with finance vocabulary; "today" questions get their own intent (portfolio change, biggest
// movers, headlines as context); general investing questions get an explanation whose numbers are still facts.

const OFF_TOPIC = /Pomáhám jen|Pomáham len|I can only help/;
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

async function ask(question: string, opts: { lang?: Lang; route?: Record<string, unknown> | 'limited'; writer?: (body: Parameters<Parameters<typeof fakeModel>[0]>[0], n: number) => Response;
  market?: MarketSource; user?: 'A' | 'B' } = {}) {
  const lang = opts.lang ?? 'cs';
  let writes = 0;
  const model = fakeModel(body => {
    if (isRouter(body)) return opts.route === 'limited' ? rateLimited() : routeReply({ lang, ...(opts.route ?? { group: 'mimo_temu' }) });
    return opts.writer ? opts.writer(body, writes++) : llmResponse({ content: '{}' });
  });
  const ctx = chatCtx({ lang, ...(opts.market ? { market: opts.market } : {}), ...(opts.user ? { user: opts.user } : {}) });
  const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) });
  return { ...result, text: plain(result.answer?.text ?? ''), bodies: model.bodies, ctx };
}

describe('router: mimo_temu only for clearly non-financial questions', () => {
  it('the router prompt describes every group with cs/sk/en examples and limits mimo_temu to non-financial topics', () => {
    for (const group of ['portfolio', 'dane', 'trh', 'valuace', 'obecne', 'mimo_temu']) expect(ROUTER_PROMPT).toContain(group);
    expect(ROUTER_PROMPT).toMatch(/Co se dnes děje s mými akciemi/);
    expect(ROUTER_PROMPT).toMatch(/Čo je staking/);
    expect(ROUTER_PROMPT).toMatch(/How are my stocks doing today/);
    expect(ROUTER_PROMPT).toMatch(/ONLY .*non-financial/);
    expect(ROUTER_PROMPT).toMatch(/recipes/);
    expect(estimateInputTokens([{ role: 'system', content: ROUTER_PROMPT }], [])).toBeLessThanOrEqual(ROUTER_PROMPT_TOKENS);

    for (const lang of ['cs', 'sk', 'en'] as const) expect(estimateInputTokens([{ role: 'system', content: explainPrompt(lang) }], [])).toBeLessThanOrEqual(MAIN_PROMPT_TOKENS);
  });

  it('the finance lexicon reuses the keyword router and knows crypto, ETFs and markets', () => {
    for (const q of ['Co se dnes děje s mými akciemi?', 'Jak si dnes vede moje portfolio?', 'Co je ETF?', 'Jak funguje staking u kryptoměn?',
      'Je teď dobrá doba investovat?', 'Kolik stojí bitcoin?', 'Čo je dividenda?', 'What is an index fund?', 'Should I buy SYNA?',
      'Jakou daň zaplatím z prodeje?', 'How does dollar cost averaging work?']) expect(isFinanceQuestion(q), q).toBe(true);
    for (const q of ['Jaký je recept na svíčkovou?', 'Jaké bude zítra počasí?', 'Write me a Python script', 'Kdo vyhrál včera hokej?'])
      expect(isFinanceQuestion(q), q).toBe(false);
  });

  it.each([
    ['cs', 'Co se dnes děje s mými akciemi?'], ['cs', 'Jak si dnes vede moje portfolio?'], ['cs', 'Co je ETF?'],
    ['cs', 'Jak funguje staking u kryptoměn?'], ['cs', 'Je teď dobrá doba investovat?'], ['cs', 'Kolik stojí bitcoin?'],
    ['sk', 'Čo sa dnes deje s mojimi akciami?'], ['sk', 'Čo je staking?'], ['en', 'What is an index fund?'], ['en', 'Is now a good time to invest?'],
  ] as const)('%s "%s": a mimo_temu router answer is overridden and never refused', async (lang, question) => {
    const model = fakeModel(b => isRouter(b) ? routeReply({ group: 'mimo_temu', lang }) : llmResponse({ content: '{}' }));
    const route = await routeQuestion(question, [], chatCtx({ lang }), llmDeps(model.fetchImpl));
    expect(route.group).not.toBe('mimo_temu');
    const r = await ask(question, { lang });
    expect(r.answer).not.toBeNull();
    expect(r.text).not.toMatch(OFF_TOPIC);
    expect(r.text).not.toMatch(TECHNICAL);
  });

  it('a recipe is still off topic, without tools or a writer call', async () => {
    const r = await ask('Jaký je recept na svíčkovou?');
    expect(r.text).toMatch(/Pomáhám jen/);
    expect(r.bodies.filter(b => !isRouter(b))).toHaveLength(0);
  });

  it('an overridden mimo_temu takes the keyword group (portfolio), else obecne', async () => {
    const model = fakeModel(b => isRouter(b) ? routeReply({ group: 'mimo_temu' }) : llmResponse({ content: '{}' }));
    expect((await routeQuestion('Jaký mám zisk z dividend?', [], chatCtx(), llmDeps(model.fetchImpl))).group).toBe('portfolio');
    expect((await routeQuestion('Co je ETF?', [], chatCtx(), llmDeps(model.fetchImpl))).group).toBe('obecne');
  });
});

/* ----------------------------- today's movers ----------------------------- */

const headline = (ticker: string, n: string, day: string): NewsItem => ({ title: `${ticker} ${n} headline about the company`, summary: null,
  publisher: 'Reuters', url: `https://www.reuters.com/markets/${ticker.toLowerCase()}-${n}`, published: `2026-10-${day}T08:00:00.000Z`, lang: 'original' });
function newsMarket(over: Partial<MarketSource> = {}) {
  const base = fixtureMarket();
  const items: Record<string, NewsItem[]> = {
    SYNA: [headline('SYNA', 'first', '22'), headline('SYNA', 'second', '21'), headline('SYNA', 'third', '20'), { ...headline('SYNA', 'fourth', '19'), title: 'SYNA jumps 12% on record results' }],
    SYNB: [headline('SYNB', 'first', '22')],
  };
  const news = vi.fn(async (ticker: string | null, period: { from: string; to: string }, lang: Lang, ctx: Parameters<MarketSource['news']>[3]) => {
    const own = ticker ? items[ticker] : undefined;
    return own ? { data: own, source: 'stock_news', asOf: own[0].published, fetchedAt: '2026-10-23T12:00:00.000Z', freshness: 'fresh' as const, warnings: ['untrusted_external_text'] }
      : base.news(ticker, period, lang, ctx);
  });
  return { market: { ...base, news, ...over } as MarketSource, news };
}
const moversWriter = (body: Parameters<Parameters<typeof fakeModel>[0]>[0]) =>
  llmResponse({ content: JSON.stringify({ lang: /Slovak/.test(body.messages[0].content ?? '') ? 'sk' : /English/.test(body.messages[0].content ?? '') ? 'en' : 'cs',
    blocks: [{ kind: 'facts', factIds: shownFactIds(body) }] }) });

describe('today: what is happening with my stocks / portfolio', () => {
  it.each([
    ['Co se dnes děje s mými akciemi?'], ['Jak si dnes vede moje portfolio?'], ['Co dneska dělají moje akcie?'], ['Jak se dnes hýbe moje portfolio?'],
    ['Čo sa dnes deje s mojimi akciami?'], ['Ako sa dnes darí môjmu portfóliu?'],
    ["What's happening with my stocks today?"], ['How is my portfolio doing today?'], ['How are my holdings moving today?'],
  ])('"%s" is the movers intent', question => {
    expect(keywordIntent(question)).toBe('movers');
  });

  it.each([['Kolik mám v portfoliu?', 'summary'], ['What is my portfolio worth today?', 'summary'], ['Co jsem dnes koupil?', 'transactions'],
    ['Jaká je dnes cena SYNA?', 'quote']])('"%s" keeps its own intent', (question, intent) => {
    expect(keywordIntent(question)).toBe(intent);
  });

  for (const path of ['accepted', 'fallback'] as const) {
    it(`lists today's change, the top movers by absolute change and their headlines (${path})`, async () => {
      const { market, news } = newsMarket();
      const r = await ask('Co se dnes děje s mými akciemi?', { market, writer: path === 'accepted' ? moversWriter : undefined });
      expect(r.outcome).toBe(path === 'accepted' ? 'ok' : 'fallback');
      expect(r.metrics.toolsUsed).toEqual(expect.arrayContaining(['get_holdings', 'get_stock_news']));
      // The portfolio model leaves out user A's BTC dust: SYNA +20 USD, SYNB +5 USD; total +25 USD on a 3 025 USD start.
      expect(news.mock.calls.map(c => c[0])).toEqual(['SYNA', 'SYNB']);
      expect(r.text).toMatch(/Dnes se hodnota tvého portfolia změnila o \+25,01 USD \(\+0,8 %\)\./);
      const lines = r.text.split('\n');
      const at = (t: string) => lines.findIndex(l => l.startsWith(`• ${t}`));
      expect(at('SYNA')).toBeGreaterThan(-1);
      expect(at('SYNA')).toBeLessThan(at('SYNB'));
      expect(lines[at('SYNA')]).toMatch(/^• SYNA: změna \+1,4 % \(\+20,00 USD\)\./);
      expect(lines[at('SYNB')]).toMatch(/^• SYNB: změna \+0,5 % \(\+5,00 USD\)\./);
      // At most two headlines per mover; a headline stating its own figure is linked, never quoted.
      expect(r.text).toContain('„SYNA first headline about the company“');
      expect(r.text).toContain('„SYNA second headline about the company“');
      expect(r.text).not.toContain('SYNA third headline');
      expect(r.text).not.toMatch(/12%|12 %/);
      expect(r.text).toContain('„SYNB first headline about the company“');
      expect(r.text).toMatch(/Titulky jsou jen kontext a nedokazují, proč se ceny pohnuly\./);
      expect(r.answer!.links.map(l => l.url)).toEqual(expect.arrayContaining(['https://www.reuters.com/markets/syna-first', 'https://www.reuters.com/markets/synb-first']));
      expect(r.text).not.toMatch(TECHNICAL);
      expect(r.text).not.toMatch(OFF_TOPIC);
      expect(r.metrics.maxCallTokens).toBeLessThanOrEqual(3000);
      expect(r.metrics.tokensIn + r.metrics.tokensOut).toBeLessThanOrEqual(8000);
    });
  }

  it('ranks by absolute value change: a falling position comes first and is shown with its minus sign', async () => {
    const base = fixtureMarket();
    const { market } = newsMarket({ quote: async (ticker, ctx) => {
      const q = await base.quote(ticker, ctx);
      return ticker.toUpperCase() === 'SYNB' && q.data ? { ...q, data: { ...q.data, price: 200, previousClose: 220, changePct: -9.090909090909092 } } : q;
    } });
    const r = await ask('How is my portfolio doing today?', { lang: 'en', market });
    const lines = r.text.split('\n');
    const first = lines.findIndex(l => l.startsWith('• '));
    expect(lines[first]).toMatch(/^• SYNB: change -9\.1% \(-USD 100\.00\)\./);
    expect(lines[first + 1]).toMatch(/^• SYNA:/);
    // The tiny BTC holding now counts in the total too (audit B10), so -80 USD of positions is -79.99 in all.
    expect(r.text).toMatch(/Today your portfolio value changed by -USD (?:80\.0|79\.9)\d/);
    expect(r.text).toMatch(/Headlines are context only and do not prove why prices moved\./);
  });

  it('Slovak wording and the synthetic fixture (headlines with figures are not quoted)', async () => {
    const r = await ask('Čo sa dnes deje s mojimi akciami?', { lang: 'sk' });
    expect(r.text).toMatch(/Dnes sa hodnota tvojho portfólia zmenila o \+25,01 USD/);
    expect(r.text).toMatch(/• SYNA: zmena \+1,4 % \(\+20,00 USD\)/);
    expect(r.text).not.toMatch(/headline \d/);
    // The fixture's links are not on an allowed publisher host: the answer must not claim they are linked.
    expect(r.answer!.links).toEqual([]);
    expect(r.text).not.toMatch(/v odkazoch/);
    expect(r.text).toMatch(/K SYNA sú nedávne titulky, ich znenie tu necitujem\./);
    expect(r.text).toMatch(/Titulky sú len kontext/);
    expect(r.text).not.toMatch(TECHNICAL);
  });

  it('an empty account says it holds nothing', async () => {
    const { fixtureRepo } = await import('../../supabase/functions/agent/core/fixture.ts');
    const model = fakeModel(b => isRouter(b) ? routeReply({ group: 'portfolio' }) : llmResponse({ content: '{}' }));
    const result = await answerQuestion({ request: chatRequest('Co se dnes děje s mými akciemi?'), history: [] },
      { ctx: chatCtx({ repo: fixtureRepo('E') }), llm: llmDeps(model.fetchImpl) });
    expect(plain(result.answer!.text)).toMatch(/Zatím nic nedržíš/);
    expect(result.answer!.text).not.toMatch(/nejsou dostupné/);
  });
});

/* ----------------------------- general investing knowledge ----------------------------- */

const prose = (text: string, claims: Record<string, unknown> = {}, lang: Lang = 'cs') =>
  llmResponse({ content: JSON.stringify({ lang, blocks: [{ kind: 'context', text, claims }] }) });

describe('obecne: the model explains concepts; numbers are still facts', () => {
  it('a concept question with no numbers is answered by the model, in plain prose, with tykání', async () => {
    const r = await ask('Jak funguje staking u kryptoměn?', { route: { group: 'obecne' },
      writer: () => prose('Staking znamená, že své kryptoměny uzamkneš v síti a pomáháš ji zabezpečit. Za to dostáváš odměny. Počítej ale s rizikem poklesu ceny i s uzamčením prostředků.') });
    expect(r.outcome).toBe('ok');
    expect(r.text).toMatch(/^Staking znamená, že své kryptoměny uzamkneš/);
    expect(r.text).toMatch(/obecné vysvětlení, ne o investiční doporučení/);
    expect(r.text).not.toMatch(TECHNICAL);
    // The writer was told to explain (not to select facts only) and to keep numbers out of free text.
    const writer = r.bodies.find(b => !isRouter(b) && !b.tools?.length)!;
    expect(writer.messages[0].content).toMatch(/explain/i);
    expect(writer.messages[0].content).toMatch(/no digits/i);
  });

  it('works when the router is down (keyword route obecne) and in Slovak and English', async () => {
    const sk = await ask('Čo je staking?', { lang: 'sk', route: 'limited', writer: () => prose('Staking je uzamknutie kryptomien v sieti, za ktoré dostávaš odmeny.', {}, 'sk') });
    expect(sk.outcome).toBe('ok');
    expect(sk.text).toMatch(/^Staking je uzamknutie/);
    const en = await ask('What is an ETF?', { lang: 'en', route: 'limited', writer: () => prose('An ETF is a fund traded on an exchange like a stock; it usually tracks an index.', {}, 'en') });
    expect(en.outcome).toBe('ok');
    expect(en.text).toMatch(/^An ETF is a fund/);
  });

  it('an unbacked number is rejected and repaired; the repaired text has no number', async () => {
    const r = await ask('Vyplatí se dlouhodobě indexové investování?', { route: { group: 'obecne' }, writer: (_b, n) => n === 0
      ? prose('Index S&P 500 historicky vynáší 10 % ročně, takže se to vyplatí.')
      : prose('Indexové investování rozkládá riziko mezi mnoho firem. Výnos ale není zaručený a trh může i dlouho klesat.') });
    expect(r.outcome).toBe('ok');
    expect(r.text).not.toMatch(/10 %|10%/);
    expect(r.text).toMatch(/^Indexové investování rozkládá riziko/);
    const writers = r.bodies.filter(b => !isRouter(b) && !b.tools?.length);
    expect(writers).toHaveLength(2);
    expect(lastUser(writers[1])).toMatch(/unslotted_number/);
    expect(allText(writers[1])).not.toMatch(/10 %/);
    expect(r.metrics.attempts?.find(a => a.phase === 'answer')?.rejectionReasons).toEqual(expect.arrayContaining(['unslotted_number']));
  });

  it.each([
    ['technical label', 'Podle get_quote je to dobrá investice.'], ['number word', 'Trh roste zhruba deset procent ročně.'],
    ['link', 'Více najdeš na www.investopedia.com.'], ['price without a fact', 'Bitcoin teď stojí přes 60 000 USD.'],
  ])('%s in prose is rejected twice → short honest general answer, never the off-topic text', async (_name, text) => {
    const r = await ask('Co je ETF?', { route: { group: 'obecne' }, writer: () => prose(text) });
    expect(r.outcome).toBe('fallback');
    expect(r.text).toMatch(/ETF/);
    expect(r.text).not.toContain(text);
    expect(r.text).not.toMatch(OFF_TOPIC);
    expect(r.text).not.toMatch(TECHNICAL);
    expect(r.text).not.toMatch(/\d/);
  });

  it('without a glossary entry the fallback is a short honest general answer', async () => {
    const r = await ask('Jak se dívat na kolísání trhu?', { route: { group: 'obecne' } });
    expect(r.outcome).toBe('fallback');
    expect(r.text).toMatch(/obecnou otázku/);
    expect(r.text).not.toMatch(OFF_TOPIC);
    // A general question does not load the portfolio as a stand-in answer.
    expect(r.metrics.toolsUsed).not.toContain('get_portfolio_summary');
  });

  it('a number in the explanation is allowed only as a fact of this request (a live quote for a named ticker)', async () => {
    const r = await ask('Proč lidé investují do bitcoinu?', { route: { group: 'obecne', tickers: ['BTC'] },
      writer: body => {
        expect(lastUser(body)).toMatch(/\[quote:BTC:price\]/);
        return prose('Bitcoin je nejznámější kryptoměna s omezenou nabídkou. Teď stojí {{p}}. Jeho cena ale silně kolísá.', { p: { factId: 'quote:BTC:price' } });
      } });
    expect(r.outcome).toBe('ok');
    expect(r.text).toMatch(/Teď stojí 60 000 USD \(cena BTC\)\./);
    expect(r.text).not.toMatch(TECHNICAL);
  });

  it('a verdict or advice field in a general answer is not accepted', async () => {
    const r = await ask('Co je ETF?', { route: { group: 'obecne' }, writer: () => llmResponse({ content: JSON.stringify({ lang: 'cs',
      blocks: [{ kind: 'context', text: 'ETF je fond obchodovaný na burze.', claims: {} }], verdict: 'attractive', confidence: 'high', wouldChange: 'evidence' }) }) });
    expect(r.outcome).toBe('fallback');
    expect(r.text).not.toMatch(/Závěr|Verdikt|Můj názor/);
  });
});

describe('obecne explanations stay away from personal data', () => {
  it('a personal or follow-up question keeps the fact-selection path (no free prose around own numbers)', async () => {
    const { history } = await import('../test/agentLlmFixture');
    for (const [question, turns] of [['A koľko z toho je hotovosť?', [['Koľko mám v portfóliu?', 'Tvoje portfólio má hodnotu 1 200 USD.']]],
      ['Kolik mám hotovosti?', []], ['What is my cash?', []]] as [string, [string, string][]][]) {
      const model = fakeModel(b => isRouter(b) ? rateLimited() : llmResponse({ content: '{}' }));
      const result = await answerQuestion({ request: chatRequest(question), history: history(turns) }, { ctx: chatCtx({ user: 'B' }), llm: llmDeps(model.fetchImpl) });
      expect(model.bodies.some(b => /explain a general investing question/.test(b.messages[0].content ?? '')), question).toBe(false);
      expect(result.metrics.toolsUsed, question).toContain('get_portfolio_summary');
      expect(plain(result.answer!.text), question).toMatch(/100,00 USD|USD 100\.00/);
    }
  });

  it('a figure in an explanation is shown with its own label', async () => {
    const r = await ask('Proč lidé investují do bitcoinu?', { route: { group: 'obecne', tickers: ['BTC'] },
      writer: () => prose('Bitcoin klesl o {{p}}.', { p: { factId: 'quote:BTC:price' } }) });
    expect(r.text).toMatch(/^Bitcoin klesl o 60 000 USD \(cena BTC\)\./);
  });

  it('Slovak "Ako … pri …" is detected as Slovak', async () => {
    const { detectLang } = await import('../../supabase/functions/agent/core/router.ts');
    expect(detectLang('Ako funguje staking pri kryptomenách?')).toBe('sk');
  });
});
