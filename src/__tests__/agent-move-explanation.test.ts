// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { fixtureMarket } from '../../supabase/functions/agent/core/fixture.ts';
import type { MarketSource } from '../../supabase/functions/agent/core/ports.ts';
import type { Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { MOVE_NEWS_MAX, movePeriodDays, tradingDaysBack } from '../../supabase/functions/agent/core/moveExplanation.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { keywordIntent, routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import { createMarketSource, resetMarketCaches } from '../../supabase/functions/agent/live/market.ts';
import { marketFetch } from '../../supabase/functions/agent/live/marketFetch.ts';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, routeReply, type SentBody, TECHNICAL } from '../test/agentLlmFixture';
import { fakeCaller } from '../test/agentDbFake';
import { marketContext, marketNow } from '../test/agentMarketFixture';
import { ok, toolCtx } from '../test/agentToolsFixture';

// "Co se děje poslední dny s NBIS?" was answered with today's quote and five raw links. A move question now gets an
// analyst-style answer: the period move against the S&P 500 and peers (server facts), likely drivers from the articles
// (the news analyst contract is tested in agent-news-analyst.test.ts), what to watch, and a one-line summary first.

const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ').replace(/\u2212/g, '-');
type Writer = (body: SentBody, n: number) => Response;

async function ask(question: string, opts: { lang?: Lang; writer?: Writer; market?: MarketSource; user?: 'A' | 'B'; route?: Record<string, unknown> } = {}) {
  const lang = opts.lang ?? 'cs';
  let writes = 0;
  const model = fakeModel(body => {
    if (isRouter(body)) return routeReply({ lang, group: 'obecne', ...(opts.route ?? {}) });
    return opts.writer ? opts.writer(body, writes++) : llmResponse({ content: '{}' });
  });
  const ctx = chatCtx({ lang, ...(opts.market ? { market: opts.market } : {}), ...(opts.user ? { user: opts.user } : {}) });
  const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) });
  return { ...result, text: plain(result.answer?.text ?? ''), bodies: model.bodies, writers: model.bodies.filter(b => !isRouter(b)), ctx };
}

afterEach(() => { vi.useRealTimers(); resetMarketCaches(); });

/* ----------------------------- routing ----------------------------- */

describe('move_explanation routing (cs/sk/en)', () => {
  it.each([
    'Co se děje poslední dny s NBIS?', 'Proč NBIS spadla?', 'Proč klesá SYNN?', 'Co se děje s NBIS tento týden?', 'Proč NBIS tak vyletěla?',
    'Jak si vedla NBIS za poslední měsíc?', 'Co je s NBIS za poslední dva týdny?', 'Proč bitcoin poslední dny padá?',
    'Prečo SYNN tento týždeň klesá?', 'Čo sa deje s NBIS posledné dni?', 'Prečo NBIS rastie?',
    'Why is NBIS down?', "What's going on with NBIS this week?", 'Why did NBIS lose so much this week?', 'What happened to NBIS over the past month?',
    'Why did bitcoin drop this week?', 'Co se dnes stalo s NU?', 'Co se dnes děje s NBIS?', 'What is happening with NBIS today?', 'Čo sa dnes stalo s NBIS?',
  ])('"%s" is move_explanation', question => {
    expect(keywordIntent(question)).toBe('move_explanation');
  });

  it.each([
    ['Jak se dnes hýbe NBIS?', 'quote'], ['Jaká je cena SYNA?', 'quote'], ['Co se dnes děje s mými akciemi?', 'movers'],
    ['Kolik jsem prodělal na SYNA?', 'realized'], ['Mám koupit NBIS?', 'buy'], ['Kolik jsem minulý týden koupil SYNA?', 'transactions'],
    ['How is NBIS moving today?', 'quote'],
  ])('"%s" keeps %s', (question, intent) => {
    expect(keywordIntent(question)).toBe(intent);
  });

  it('a move word without an instrument is not a move question', () => {
    expect(keywordIntent('Proč trh poslední dny padá?')).not.toBe('move_explanation');
  });

  it.each([
    ['Co se děje poslední dny s NBIS?', 5], ['Proč NBIS spadla tento týden?', 5], ['Co je s NBIS za poslední 2 týdny?', 10],
    ['Co je s NBIS za poslední dva týdny?', 10], ['Why is NBIS down over the past two weeks?', 10], ['Jak si vedla NBIS za poslední měsíc?', 21],
    ['Ako sa darilo NBIS za posledný mesiac?', 21], ['What happened to NBIS this month?', 21], ['Proč NBIS spadla?', 5],
    ['Co je s NBIS za posledních 7 dní?', 7],
  ])('"%s" covers %i trading days', (question, days) => {
    expect(movePeriodDays(question)).toBe(days);
  });

  it('counts trading days back from today (weekends skipped)', () => {
    expect(tradingDaysBack('2026-10-23', 5)).toBe('2026-10-16');
    expect(tradingDaysBack('2026-10-23', 10)).toBe('2026-10-09');
    expect(tradingDaysBack('2026-10-23', 21)).toBe('2026-09-24');
    expect(tradingDaysBack('2026-10-25', 5)).toBe('2026-10-16');
  });

  it('a successful router model cannot erase the bound intent', async () => {
    for (const group of ['obecne', 'portfolio', 'trh', 'mimo_temu']) {
      const model = fakeModel(b => isRouter(b) ? routeReply({ group }) : llmResponse({ content: '{}' }));
      const route = await routeQuestion('Co se děje poslední dny s SYNN?', [], chatCtx(), llmDeps(model.fetchImpl));
      expect(route).toMatchObject({ intent: 'move_explanation', tickers: ['SYNN'], group: 'trh' });
    }
  });
});

/* ----------------------------- evidence ----------------------------- */

function spyMarket() {
  const base = fixtureMarket();
  const calls: { method: string; ticker: string | null; period?: { from: string; to: string }; articles?: boolean }[] = [];
  const market = { ...base,
    history: vi.fn(async (t: string, p: { from: string; to: string }, c: Parameters<MarketSource['history']>[2]) => { calls.push({ method: 'history', ticker: t, period: p }); return base.history(t, p, c); }),
    news: vi.fn(async (t: string | null, p: { from: string; to: string }, l: Lang, c: Parameters<MarketSource['news']>[3], o?: Parameters<MarketSource['news']>[4]) => {
      calls.push({ method: 'news', ticker: t, period: p, articles: !!o?.articles }); return base.news(t, p, l, c, o); }),
    peers: vi.fn(async (t: string, c: Parameters<MarketSource['peers']>[1]) => { calls.push({ method: 'peers', ticker: t }); return base.peers(t, c); }),
  } as MarketSource;
  return { market, calls };
}

describe('move_explanation evidence: period move, S&P 500, peers, news, analysts, earnings', () => {
  it('runs every mandatory call before the analyst, with the period read from the question', async () => {
    const { market, calls } = spyMarket();
    const r = await ask('Co se děje poslední dny s SYNN?', { market });
    expect(r.metrics.toolsUsed).toEqual(expect.arrayContaining(['get_price_history', 'get_peers', 'get_stock_news', 'get_analyst_view',
      'get_earnings_calendar', 'get_quote']));
    const period = { from: '2026-10-16', to: '2026-10-23' };
    expect(calls.filter(c => c.method === 'history').map(c => [c.ticker, c.period])).toEqual(expect.arrayContaining([['SYNN', period],
      ['SYNP', period], ['SYNQ', period], ['SYNR', period], ['SYNS', period]]));
    expect(calls.filter(c => c.method === 'peers').map(c => c.ticker)).toEqual(['SYNN']);
    // News for the ticker and its top two peers over the same days.
    expect(calls.filter(c => c.method === 'news').map(c => c.ticker).sort()).toEqual(['SYNN', 'SYNP', 'SYNQ']);
    expect(calls.filter(c => c.method === 'news').every(c => c.period?.from === '2026-10-16' && c.period?.to === '2026-10-23')).toBe(true);
    // News with article text, asked after the peers are known.
    expect(calls.filter(c => c.method === 'news').every(c => c.articles)).toBe(true);
    expect(calls.findIndex(c => c.method === 'news')).toBeGreaterThan(calls.findIndex(c => c.method === 'peers'));
    // The analyst runs after all of them, without tools (a rejected first answer gets one repair).
    expect(r.writers.length).toBeGreaterThanOrEqual(1);
    expect(r.writers.length).toBeLessThanOrEqual(3);
    expect(r.writers.every(w => (w.tools ?? []).length === 0)).toBe(true);
  });

  it('registers period change, drawdown, S&P 500 and peer changes as facts, and each news item as a text source', async () => {
    const r = await ask('Co se děje poslední dny s SYNN?');
    const fact = (id: string) => r.ctx.facts.get(id);
    expect(fact('history:SYNN:change_pct')).toMatchObject({ unit: 'percent', ticker: 'SYNN', period: { from: '2026-10-16', to: '2026-10-22' } });
    expect(fact('history:SYNN:change_pct')!.value as number).toBeCloseTo((98.5 / 120 - 1) * 100, 6);
    expect(fact('history:SYNN:first_close')).toMatchObject({ value: 120, unit: 'money', currency: 'USD' });
    expect(fact('history:SYNN:last_close')).toMatchObject({ value: 98.5, unit: 'money', currency: 'USD' });
    expect(fact('history:SYNN:max_drawdown_pct')!.value as number).toBeCloseTo((98.5 / 124 - 1) * 100, 6);
    expect(fact('history:SPX:change_pct')!.value as number).toBeCloseTo((5380 / 5328 - 1) * 100, 6);
    expect(fact('history:SYNP:change_pct')!.value as number).toBeCloseTo(-12, 6);
    expect(fact('history:SYNQ:change_pct')!.value as number).toBeCloseTo(-8, 6);
    expect(fact('history:SYNR:change_pct')!.value as number).toBeCloseTo(-2, 6);
    const news = [...r.ctx.facts.values()].filter(f => /^news:[A-Z]+:n\d+$/.test(f.id));
    // 4 verified SYNN articles in the period + 1 SYNP (the shared Reuters story counted once) + 1 SYNQ; the older item is out
    // of the period and the item from a host without verified links is not read at all.
    expect(news).toHaveLength(6);
    expect(news.length).toBeLessThanOrEqual(MOVE_NEWS_MAX);
    expect(news.every(f => f.unit === 'text' && typeof f.value === 'string')).toBe(true);
    expect(news.map(f => f.value as string).join('\n')).toContain('Barron\'s | 2026-10-20 | Short seller targets Synthetic Neocloud');
    expect(news.map(f => f.value as string).join('\n')).not.toContain('new data center');
    // The text fact carries the article excerpt, not only the title.
    expect(news.map(f => f.value as string).join('\n')).toContain('relies on borrowed money to build its data centers');
    expect(news.map(f => f.value as string).join('\n')).not.toMatch(/Ignore previous|Unknown Blog|hidden prompt/);
  });

  it('peer tickers resolve only after the peers tool named them in this request', async () => {
    const ctx = toolCtx('A');
    const period = { from: '2026-10-16', to: '2026-10-23' };
    expect(await executeTool('get_price_history', { ticker: 'SYNP', period }, ctx)).toMatchObject({ ok: false, error: { code: 'clarify' } });
    const peers = ok(await executeTool('get_peers', { ticker: 'SYNN' }, ctx));
    expect(peers.data).toMatchObject({ ticker: 'SYNN', peers: ['SYNP', 'SYNQ', 'SYNR', 'SYNS'], basis: 'provider' });
    expect(ok(await executeTool('get_price_history', { ticker: 'SYNP', period }, ctx)).facts.map(f => f.id)).toContain('history:SYNP:change_pct');
    expect(await executeTool('get_price_history', { ticker: 'SYNP', period }, toolCtx('A'))).toMatchObject({ ok: false });
  });
});

/* ----------------------------- fallback and edge cases ----------------------------- */

describe('move_explanation without an accepted analysis', () => {
  it.each([
    ['sk', 'Prečo SYNN tento týždeň klesá?', /^\*\*Zhrnutie:\*\* .*\n\nČo sa stalo\n/, /sa cena SYNN zmenila o -17,9 %/, /Index S&P 500 sa za rovnaké obdobie zmenil o \+1,0 %/, /Čo píšu správy/],
    ['en', 'Why is SYNN down this week?', /^\*\*Summary:\*\* .*\n\nWhat happened\n/, /the SYNN price changed by -17\.9% \(from USD 120\.00 to USD 98\.50\)/, /The S&P 500 changed by \+1\.0% over the same period/, /What the news says/],
  ] as const)('%s fallback', async (lang, question, heading, move, spx, headlines) => {
    const r = await ask(question, { lang, user: lang === 'sk' ? 'B' : 'A' });
    expect(r.outcome).toBe('fallback');
    for (const re of [heading, move, spx, headlines]) expect(r.text).toMatch(re);
    expect(r.text).not.toMatch(TECHNICAL);
  });

  it('says when news is thin and still explains the move against the market and peers', async () => {
    const base = fixtureMarket();
    const market = { ...base, news: async () => ({ data: null, source: 'stock_news', asOf: null, fetchedAt: null, freshness: 'missing' as const, warnings: ['news_missing'] }) } as MarketSource;
    const r = await ask('Co se děje poslední dny s SYNN?', { market });
    expect(r.text).toMatch(/se cena SYNN změnila o -17,9 %/);
    expect(r.text).toMatch(/K tomuto období jsem nenašel zprávy, které by pohyb vysvětlovaly/);
  });

  it('quotes no headline without a verified publisher link, and says so', async () => {
    const base = fixtureMarket();
    const market = { ...base, news: async (...args: Parameters<MarketSource['news']>) => {
      const value = await base.news(...args);
      return value.data ? { ...value, data: value.data.map(item => ({ ...item, url: item.url.replace(/^https:\/\/[^/]+/, 'https://news.example.com') })) } : value;
    } } as MarketSource;
    const r = await ask('Co se děje poslední dny s SYNN?', { market });
    expect(r.outcome).toBe('fallback');
    expect(r.text).toMatch(/nemají odkaz od ověřeného vydavatele/);
    expect(r.text).not.toMatch(/Co píšou zprávy|Neocloud stocks slide/);
    expect(r.answer!.links).toEqual([]);
  });

  it('"Co se dnes děje s SYNA?" gives both: the price move (today first, then the last days) and the news behind it', async () => {
    const r = await ask('Co se dnes děje s SYNA?');
    expect(r.metrics.toolsUsed).toEqual(expect.arrayContaining(['get_quote', 'get_price_history', 'get_peers', 'get_stock_news']));
    expect(r.text).toMatch(/^\*\*Shrnutí:\*\* Dnešní změna ceny SYNA je /m);
    expect(r.text).toMatch(/Aktuální cena SYNA je 150,00 USD, dnešní změna \+1,4 %\.\nOd 16\. 10\. 2026 do 22\. 10\. 2026 se cena SYNA změnila o \+4,2 %/);
  });
});

/* ----------------------------- live market source ----------------------------- */

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function live(tables: Record<string, Record<string, unknown>[]> = {}, fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({}))) {
  return { fetchImpl, source: createMarketSource(fakeCaller(tables).client, { fetchImpl, now: Date.now,
    keys: { FINNHUB_API_KEY: 'synthetic', TWELVE_DATA_KEY: 'synthetic' } }) };
}
describe('live peers and recent history', () => {
  const clock = () => { vi.useFakeTimers(); vi.setSystemTime(marketNow); };
  it('reads Finnhub peers on the pinned path, drops itself and invalid symbols, and caches them', async () => {
    clock();
    const { source, fetchImpl } = live({}, vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(['NBIS', 'CRWV', 'ORCL', 'crwv', 'BAD TICKER', 'NBIS', 'MSFT', 'AMZN', 'GOOGL'])));
    const first = await source.peers('NBIS', marketContext());
    expect(first).toMatchObject({ source: 'Finnhub', freshness: 'fresh', data: { peers: ['CRWV', 'ORCL', 'MSFT', 'AMZN'], basis: 'provider' } });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect([url.hostname, url.pathname, url.search]).toEqual(['finnhub.io', '/api/v1/stock/peers', '?symbol=NBIS&token=synthetic']);
    await source.peers('NBIS', marketContext());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('falls back to instruments of the same stored industry', async () => {
    clock();
    const industry = 'Software - Infrastructure';
    const { source } = live({ ticker_profiles: [{ ticker: 'NBIS', industry_raw: industry }, { ticker: 'CRWV', industry_raw: industry },
      { ticker: 'MSFT', industry_raw: industry }, { ticker: 'AAPL', industry_raw: 'Consumer Electronics' }] }, vi.fn(async () => json({}, 500)));
    expect(await source.peers('NBIS', marketContext())).toMatchObject({ source: 'ticker_profiles', data: { peers: ['CRWV', 'MSFT'], basis: 'industry' } });
    expect((await source.peers('ZZZZ', marketContext())).data).toBeNull();
  });
  it('names major coins as crypto peers without a provider call', async () => {
    clock(); const { source, fetchImpl } = live();
    const result = await source.peers('BTC', marketContext());
    expect(result.data?.basis).toBe('crypto');
    expect(result.data?.peers).toContain('ETH');
    expect(result.data?.peers).not.toContain('BTC');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reads recent closes from Twelve Data only when stored history is missing, in USD only', async () => {
    clock();
    const period = { from: '2026-10-16', to: '2026-10-23' };
    const td = live({}, vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ meta: { symbol: 'CRWV', currency: 'USD' }, status: 'ok',
      values: [{ datetime: '2026-10-22', close: '70.4' }, { datetime: '2026-10-16', close: '80' }, { datetime: '2026-10-01', close: '1' }] })));
    const result = await td.source.recentHistory('CRWV', period, marketContext());
    expect(result).toMatchObject({ source: 'Twelve Data', freshness: 'fresh', data: [{ date: '2026-10-16', close: 80 }, { date: '2026-10-22', close: 70.4 }] });
    const url = new URL(String(td.fetchImpl.mock.calls[0][0]));
    expect([url.hostname, url.pathname, url.searchParams.get('symbol'), url.searchParams.get('interval')]).toEqual(['api.twelvedata.com', '/time_series', 'CRWV', '1day']);
    const eur = live({}, vi.fn(async () => json({ meta: { currency: 'EUR' }, status: 'ok', values: [{ datetime: '2026-10-22', close: '1' }] })));
    expect((await eur.source.recentHistory('SAPX', period, marketContext())).data).toBeNull();
    const stored = live({ price_history: [{ symbol: 'NBIS', date: '2026-10-16', close: 100 }, { symbol: 'NBIS', date: '2026-10-22', close: 90 }] });
    expect((await stored.source.recentHistory('NBIS', period, marketContext())).source).toBe('price_history');
    expect(stored.fetchImpl).not.toHaveBeenCalled();
  });
  it('pins the new provider paths and still rejects anything else', async () => {
    clock(); const fetchImpl = vi.fn(async () => json([]));
    await marketFetch('https://finnhub.io/api/v1/stock/peers?symbol=NBIS', { fetchImpl, now: Date.now }, marketContext());
    await marketFetch('https://api.twelvedata.com/time_series?symbol=NBIS', { fetchImpl, now: Date.now }, marketContext());
    await expect(marketFetch('https://finnhub.io/api/v1/stock/profile2?symbol=NBIS', { fetchImpl, now: Date.now }, marketContext())).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("today's drop asked with a request for a detailed analysis (NU, 26. 10. 2026)", () => {
  const Q = 'Proč je dneska tak obrovksej propad na SYNN? Co se změnilo okolo tak skvělé firmy? Udělej podrobnou analýzu';
  it('is a move question: explained from the news of the move, not as a three-year outlook', async () => {
    expect(keywordIntent(Q)).toBe('move_explanation');
    const { market, calls } = spyMarket();
    const r = await ask(Q, { market });
    expect(calls.some(c => c.method === 'news')).toBe(true);
    expect(r.metrics.toolsUsed).not.toContain('get_fair_value');
    expect(r.metrics.toolsUsed).not.toContain('get_company_research');
    expect(r.text).not.toMatch(/Ocenění a kde může být cena/);
  });
  it("leads with today's change and tells the analyst the question is about today's move", async () => {
    const r = await ask(Q, { market: spyMarket().market });
    expect(r.text).toMatch(/^\*\*Shrnutí:\*\* Dnešní změna ceny SYNN je [+-]?\d/m);
    const sent = JSON.stringify(r.writers[0]?.messages ?? []);
    expect(sent).toMatch(/SYNN today \(live quote\)/);
    expect(sent).toMatch(/why SYNN moved today/);
  });
});

describe('questions typed without diacritics, with the English layout or as a follow-up (26. 10. 2026)', () => {
  it.each([
    'Proc NU dneska tak spadla?', 'co se dnes stalo s NU', 'Zkus znova zjistit co se s NU stalo analyzuj', 'Preco NU klesa?',
  ])('"%s" is move_explanation', question => {
    expect(keywordIntent(question)).toBe('move_explanation');
  });
  it('reads a question typed with the English layout on a Czech keyboard', async () => {
    const { repairLayout } = await import('../../supabase/functions/agent/core/router.ts');
    expect(repairLayout('Ykus to ynova t5eba u6 yjist93 co se dnes stalo s NU')).toBe('Zkus to znova třeba už zjistíš co se dnes stalo s NU');
    // Ordinary text, tickers and figures stay as written.
    for (const q of ['Kolik mám v NVDA za Q3 2026?', 'Co dělá S&P 500 a 3M?', 'Why is NBIS down 12%?']) expect(repairLayout(q)).toBe(q);
  });
  it('a follow-up judgement without a symbol is the company analysis of the instrument the conversation is about', () => {
    expect(keywordIntent('Takze s akcii neni nic spatne jde jen o nejistotu byznys to furt je skvelej.')).toBe('move_explanation');
    expect(keywordIntent('Takže s akcií není nic špatně, jde jen o nejistotu, byznys je furt skvělej?')).toBe('move_explanation');
  });
  it('"what happened" is explained from the news of the move even when an analysis is asked for too', async () => {
    const { isWhyMoveQuestion } = await import('../../supabase/functions/agent/core/router.ts');
    expect(isWhyMoveQuestion('Zkus znova zjistit co se s NU stalo analyzuj')).toBe(true);
    expect(isWhyMoveQuestion('Udělej analýzu NU')).toBe(false);
  });
  it('folding never makes an English "me" a personal question', async () => {
    const { isPersonalQuestion } = await import('../../supabase/functions/agent/core/router.ts');
    expect(isPersonalQuestion('Tell me what happened to NBIS')).toBe(false);
    expect(isPersonalQuestion('kolik mam v portfoliu')).toBe(true);
  });
});

describe('a move question about several instruments (SOFI and NBIS, 27. 10. 2026)', () => {
  const Q = 'CO dneska způsobilo tka obrovský růst na SYNN a na SYNA?';
  it('reads "co způsobilo … růst" as a why of the move, and capitals CO as a word, not a symbol', async () => {
    const { tickersIn, isWhyMoveQuestion } = await import('../../supabase/functions/agent/core/router.ts');
    expect(keywordIntent(Q)).toBe('move_explanation');
    expect(tickersIn(Q)).toEqual(['SYNN', 'SYNA']);
    expect(isWhyMoveQuestion('What caused the jump in NBIS?')).toBe(true);
    expect(isWhyMoveQuestion('Co způsobilo propad NU?')).toBe(true);
    expect(keywordIntent('Jaký je růst tržeb NVDA?')).not.toBe('move_explanation');
  });
  it('explains each instrument under its own symbol in one answer', async () => {
    const { market, calls } = spyMarket();
    const r = await ask(Q, { market });
    expect(calls.filter(c => c.method === 'news').map(c => c.ticker)).toEqual(expect.arrayContaining(['SYNN', 'SYNA']));
    expect(r.text).toMatch(/^\*\*SYNN\*\*\n/);
    expect(r.text).toMatch(/\n\n\*\*SYNA\*\*\n/);
    expect(r.text.match(/Co se stalo/g)?.length).toBe(2);
    // No repair round with two instruments: at most one analyst call (and its model fallbacks) each.
    expect(r.writers.length).toBeLessThanOrEqual(2);
  });
  it('one instrument keeps the single answer, without a symbol heading', async () => {
    const r = await ask('Co dneska způsobilo tak obrovský růst na SYNN?', { market: spyMarket().market });
    expect(r.text).not.toMatch(/^\*\*SYNN\*\*\n/);
    expect(r.text).toMatch(/Co se stalo/);
  });
});

describe('a move told outright or asked "how come" (RKLB and NBIS, 27. 10. 2026)', () => {
  it.each([
    'Jak to že dneska tak prudce roste SYNN a SYNA po těch propadech?', 'Jak to, že SYNN tak roste?', 'jak to ze dneska tak roste SYNN',
    'Jak je možné, že SYNN padá?', 'Čím to je, že SYNN klesá?', 'Co tomu růstu SYNN dneska pomohlo?', 'Co táhne SYNN nahoru?',
    'Dneska prudce roste SYNN, co se děje?', 'SYNN dnes tolik padá', 'Z jakého důvodu SYNN vyletěla?', 'How come SYNN is up so much?',
    'What pushed SYNN up today?', 'Ako to, že SYNN rastie?', 'Co říkáš na to, jak SYNN roste?',
  ])('"%s" is move_explanation', question => {
    expect(keywordIntent(question)).toBe('move_explanation');
  });
  it.each([
    ['Jaká je dnes cena SYNN?', 'quote'], ['Jak se dnes hýbe SYNN?', 'quote'], ['Kolik dnes stojí SYNN?', 'quote'],
  ])('"%s" keeps %s', (question, intent) => {
    expect(keywordIntent(question)).toBe(intent);
  });
  it('explains both instruments, not only their quotes', async () => {
    const { market, calls } = spyMarket();
    const r = await ask('Jak to že dneska tak prudce roste SYNN a SYNA po těch propadech?', { market });
    expect(calls.filter(c => c.method === 'news').map(c => c.ticker)).toEqual(expect.arrayContaining(['SYNN', 'SYNA']));
    expect(r.text.match(/Co se stalo/g)?.length).toBe(2);
  });
});
