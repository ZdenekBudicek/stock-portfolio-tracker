// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { articleRelevance, cleanArticleText, isQuotePage } from '../../supabase/functions/agent/core/articleText.ts';
import { companyName, companyTicker, companyTickersIn } from '../../supabase/functions/agent/core/companyNames.ts';
import { resolveMarketTicker } from '../../supabase/functions/agent/core/marketIdentity.ts';
import { keywordIntent, tickersIn } from '../../supabase/functions/agent/core/router.ts';
import { createMarketSource, resetMarketCaches } from '../../supabase/functions/agent/live/market.ts';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, routeReply } from '../test/agentLlmFixture';
import { fakeCaller } from '../test/agentDbFake';
import { marketContext, marketNow, marketRegistry } from '../test/agentMarketFixture';

// Běh 24: any ticker (not only held ones), popular company names, and article relevance (no company profiles, no quote
// pages, news about the company first).

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const empty = { positions: [], aliases: [], profiles: [] };
afterEach(() => { vi.useRealTimers(); resetMarketCaches(); });

describe('popular company names', () => {
  it('maps names (with Czech/Slovak endings) to symbols, without false positives', () => {
    expect(companyTickersIn('Co se děje s CoreWeave?')).toEqual(['CRWV']);
    expect(companyTickersIn('Proč Nvidie spadla a co Teslou?')).toEqual(['NVDA', 'TSLA']);
    expect(companyTickersIn('Jak se daří Microsoftu, Googlu a Applu?')).toEqual(['AAPL', 'MSFT', 'GOOGL']);
    expect(companyTickersIn('Co Meta a Palantir?')).toEqual(['META', 'PLTR']);
    expect(companyTickersIn('metadata, metal, teslík, solanka, oraculum, nebiusový')).toEqual([]);
    expect(companyTicker('CoreWeave')).toBe('CRWV');
    expect(companyTicker('Nebius Group N.V.')).toBe('NBIS');
    expect(companyTicker('google')).toBe('GOOGL');
    expect(companyTicker('Broadcom Inc.')).toBe('AVGO');
    expect(companyTicker('Co se děje s CoreWeave')).toBeNull();
    expect(companyName('CRWV')).toBe('CoreWeave');
  });

  it('the keyword router reads names as tickers: a move question about CoreWeave is a move question', () => {
    expect(tickersIn('Co se děje s CoreWeave?')).toEqual(['CRWV']);
    expect(keywordIntent('Co se děje s CoreWeave?')).toBe('move_explanation');
    expect(keywordIntent('Proč Nvidie za poslední týden spadla?')).toBe('move_explanation');
    expect(keywordIntent('Co se děje s CRWV?')).toBe('move_explanation');
  });

  it('resolves a popular name without any registry entry', () => {
    expect(resolveMarketTicker('CoreWeave', empty)).toEqual({ status: 'resolved', ticker: 'CRWV', assetType: 'stock' });
    expect(resolveMarketTicker('Solana', empty)).toEqual({ status: 'resolved', ticker: 'SOL', assetType: 'crypto' });
    expect(resolveMarketTicker('nic', empty)).toEqual({ status: 'unknown', candidates: [] });
  });
});

describe('any ticker: verified by the market source, accepted with a warning when nothing can verify it', () => {
  const clock = () => { vi.useFakeTimers(); vi.setSystemTime(marketNow); };
  const source = (fetchImpl: ReturnType<typeof vi.fn>, keys: Record<string, string>) =>
    createMarketSource(fakeCaller({}).client, { fetchImpl: fetchImpl as unknown as typeof fetch, now: Date.now, keys });

  it('an unknown symbol is accepted when a provider quotes it, refused when none does', async () => {
    clock();
    const quoted = vi.fn(async (u: RequestInfo | URL) => new URL(String(u)).pathname === '/api/v1/quote' ? json({ c: 85.2, pc: 88, d: -2.8, dp: -3.2, t: 1792670400 }) : json({}));
    expect(await source(quoted, { FINNHUB_API_KEY: 'synthetic' }).resolveTicker('CRWX', empty, marketContext()))
      .toEqual({ status: 'resolved', ticker: 'CRWX', assetType: 'stock' });
    const missing = vi.fn(async () => json({ c: 0, pc: 0, d: null, dp: null, t: 0 }));
    expect(await source(missing, { FINNHUB_API_KEY: 'synthetic' }).resolveTicker('QQQQX', empty, marketContext()))
      .toEqual({ status: 'unknown', candidates: [] });
  });

  it('without provider keys a plain all-caps symbol is accepted as unverified (no question back)', async () => {
    clock();
    const fetchImpl = vi.fn(async () => json({}));
    const s = source(fetchImpl, {});
    expect(await s.resolveTicker('CRWX', empty, marketContext())).toEqual({ status: 'resolved', ticker: 'CRWX', assetType: 'stock', unverified: true });
    // A word that is not written as a symbol is still unknown.
    expect(await s.resolveTicker('nic', empty, marketContext())).toEqual({ status: 'unknown', candidates: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a company name outside the built-in map is found by the Finnhub symbol search (pinned path)', async () => {
    clock();
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      const url = new URL(String(u));
      if (url.pathname === '/api/v1/search') return json({ count: 2, result: [
        { description: 'ROCKET LAB CORP', displaySymbol: 'RKLB.MX', symbol: 'RKLB.MX', type: 'Common Stock' },
        { description: 'ROCKET LAB CORP', displaySymbol: 'RKLB', symbol: 'RKLB', type: 'Common Stock' }] });
      return json({});
    });
    expect(await source(fetchImpl, { FINNHUB_API_KEY: 'synthetic' }).resolveTicker('Rocket Lab', empty, marketContext()))
      .toEqual({ status: 'resolved', ticker: 'RKLB', assetType: 'stock' });
    const search = fetchImpl.mock.calls.map(c => new URL(String(c[0]))).find(u => u.pathname === '/api/v1/search')!;
    expect(search.hostname).toBe('finnhub.io');
    expect(search.searchParams.get('q')).toBe('Rocket Lab');
    // The registry still wins without any network call.
    const local = vi.fn(async () => json({}));
    expect(await source(local, { FINNHUB_API_KEY: 'synthetic' }).resolveTicker('Rocket Lab', marketRegistry, marketContext()))
      .toEqual({ status: 'resolved', ticker: 'RKLB', assetType: 'stock' });
    expect(local).not.toHaveBeenCalled();
  });

  it('"Co se děje s CoreWeave?" is answered for a ticker the user does not hold, not with "Kterou akcii myslíš?"', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ lang: 'cs', group: 'trh', tickers: ['CoreWeave'] }) : llmResponse({ content: '{}' }));
    const ctx = chatCtx({ lang: 'cs' });
    const result = await answerQuestion({ request: chatRequest('Co se děje s CoreWeave?'), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) });
    expect(result.answer?.text ?? '').not.toMatch(/Kterou akcii/);
    expect(result.answer?.text ?? '').toMatch(/CRWV/);
  });
});

describe('article relevance', () => {
  const keys = ['NBIS', 'Nebius Group', 'Nebius', 'CRWV'];

  it('drops company-profile sentences but keeps news that mentions what the company is', () => {
    const text = cleanArticleText([
      'Nebius Group N.V., a technology company, engages in building full-stack infrastructure to service the global AI industry in the United States.',
      'The company was founded in 2017 and is headquartered in Amsterdam, the Netherlands.',
      'Nebius provides cloud services, GPU clusters and developer tools to AI companies around the world.',
      'Shares of Nebius, a provider of AI cloud infrastructure, fell sharply on Tuesday after a short seller questioned its debt.',
    ].join('\n'));
    expect(text.join(' ')).not.toMatch(/engages in|headquartered|provides cloud services/);
    expect(text.join(' ')).toMatch(/fell sharply on Tuesday/);
  });

  it('recognises quote and profile pages by their links', () => {
    expect(isQuotePage('https://uk.finance.yahoo.com/quote/NBIS')).toBe(true);
    expect(isQuotePage('https://www.marketwatch.com/investing/stock/nbis')).toBe(true);
    expect(isQuotePage('https://www.cnbc.com/quotes/NBIS')).toBe(true);
    expect(isQuotePage('https://www.reuters.com/technology/nebius-slide-2026-10-21/')).toBe(false);
  });

  it('scores dated news about the company above undated, profile-only or unrelated text', () => {
    const to = '2026-10-23';
    const news = articleRelevance('Nebius shares slide as AI spending worries hit neoclouds', 'Shares of Nebius fell 9% on Tuesday as investors questioned AI capex.', keys, '2026-10-22T08:00:00Z', to);
    const older = articleRelevance('Nebius shares slide as AI spending worries hit neoclouds', 'Shares of Nebius fell 9% on Tuesday as investors questioned AI capex.', keys, '2026-10-16T08:00:00Z', to);
    const undated = articleRelevance('Nebius shares slide as AI spending worries hit neoclouds', 'Shares of Nebius fell 9% on Tuesday as investors questioned AI capex.', keys, null, to);
    const unrelated = articleRelevance('Five dividend stocks to buy now', 'These utilities pay steady dividends and rose this year.', keys, '2026-10-22T08:00:00Z', to);
    const profile = articleRelevance('Nebius Group N.V. (NBIS)', '', keys, '2026-10-22T08:00:00Z', to);
    expect(news).toBeGreaterThan(older);
    expect(older).toBeGreaterThan(undated);
    expect(unrelated).toBeLessThan(0);
    expect(profile).toBeLessThan(0);
  });

  it('the live source asks Tavily for 8 candidates and keeps the best 5 news articles about the company', async () => {
    vi.useFakeTimers(); vi.setSystemTime(marketNow);
    const article = (i: number, over: Record<string, unknown> = {}) => ({ title: `Nebius shares move as AI cloud demand shifts, report ${i}`,
      url: `https://www.reuters.com/technology/nebius-${i}/`, content: 'Nebius fell.', published_date: `2026-10-${String(15 + i).padStart(2, '0')}T08:00:00Z`,
      raw_content: `Shares of Nebius fell on day ${i} after investors questioned AI capex and the company's debt plans.`, ...over });
    const results = [
      article(1), article(2), article(3), article(4), article(5), article(6),
      article(7, { title: 'Nebius Group N.V. (NBIS) Stock Price, News, Quote', url: 'https://uk.finance.yahoo.com/quote/NBIS',
        raw_content: 'Nebius Group N.V., a technology company, engages in building full-stack infrastructure to service the global AI industry.' }),
      article(8, { title: 'Five dividend stocks to buy now', url: 'https://www.cnbc.com/2026/10/22/dividends.html', raw_content: 'These utilities pay steady dividends.' }),
    ];
    const fetchImpl = vi.fn(async (u: RequestInfo | URL, _init?: RequestInit) => new URL(String(u)).hostname === 'api.tavily.com' ? json({ results }) : json([]));
    const s = createMarketSource(fakeCaller({ ticker_profiles: [] }).client, { fetchImpl: fetchImpl as unknown as typeof fetch, now: Date.now,
      keys: { TAVILY_API_KEY: 'tvly-synthetic' } });
    const value = await s.news('NBIS', { from: '2026-10-16', to: '2026-10-23' }, 'cs', marketContext(), { articles: { related: ['CRWV'] } });
    const call = fetchImpl.mock.calls.find(c => new URL(String(c[0])).hostname === 'api.tavily.com')!;
    const body = JSON.parse(String(call[1]!.body));
    expect(body.max_results).toBe(8);
    // No stored profile: the built-in name still names the company in the query.
    expect(body.query).toBe('NBIS Nebius Group stock news this week');
    const urls = value.data!.map(i => i.url);
    expect(urls).toHaveLength(5);
    expect(urls.some(u => /quote|dividends/.test(u))).toBe(false);
    // The newest dated articles win among equally relevant ones.
    expect(urls).toEqual([6, 5, 4, 3, 2].map(i => `https://www.reuters.com/technology/nebius-${i}/`));
  });
});

describe('an unverified symbol is answered with a note, not a question back', () => {
  it('"Co se děje s CRWX?" without any provider able to verify it', async () => {
    const { fixtureMarket } = await import('../../supabase/functions/agent/core/fixture.ts');
    const base = fixtureMarket();
    const market = { ...base, resolveTicker: async (input: string, registry: Parameters<typeof base.resolveTicker>[1], ctx: Parameters<typeof base.resolveTicker>[2]) => {
      const local = await base.resolveTicker(input, registry, ctx);
      return local.status === 'unknown' && input === 'CRWX' ? { status: 'resolved' as const, ticker: 'CRWX', assetType: 'stock' as const, unverified: true as const } : local;
    } };
    const model = fakeModel(body => isRouter(body) ? routeReply({ lang: 'cs', group: 'trh', tickers: ['CRWX'] }) : llmResponse({ content: '{}' }));
    const result = await answerQuestion({ request: chatRequest('Co se děje s CRWX?'), history: [] }, { ctx: chatCtx({ lang: 'cs', market }), llm: llmDeps(model.fetchImpl) });
    const text = result.answer?.text ?? '';
    expect(text).not.toMatch(/Kterou akcii/);
    expect(text).toMatch(/Symbol jsem teď nemohl ověřit u zdroje dat/);
  });
});

describe('analyst attribution in Czech: a declined publisher name still names it', () => {
  it('accepts "podle Benzingy" for a Benzinga figure, refuses a figure without any publisher', async () => {
    const { analystValidator } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const articles = [
      { key: 'n1', factId: 'news:NBIS:n1', ticker: 'NBIS', title: 'Why Is Nebius Group Stock Falling Friday?', summary: '', publisher: 'Benzinga', date: '2026-10-16',
        url: 'https://www.benzinga.com/x', excerpt: 'Nebius Group stock is trading nearly 6% lower on Friday after a warning from Gartner about neocloud providers.' },
      { key: 'n2', factId: 'news:NBIS:n2', ticker: 'NBIS', title: 'Nebius secures a senior secured facility', summary: '', publisher: 'Yahoo Finance', date: '2026-10-22',
        url: 'https://finance.yahoo.com/y', excerpt: 'Nebius Group today announced that it has entered into a $3.5 billion senior secured facility provided by Citi.' },
    ];
    const check = analystValidator({ mode: 'move', lang: 'cs', subject: 'NBIS', facts: [], articles, tickers: ['NBIS'], keywords: ['NBIS', 'Nebius'] });
    const draft = (first: string) => ({ summary: 'Akcii tlačí dolů obavy o výdaje na AI a firma si zároveň půjčuje.', watch: ['Další zprávy o financování.'], themes: [
      { title: 'Obavy o výdaje na AI', scope: 'sector', sources: ['n1'], explanation: first },
      { title: 'Nový úvěr', scope: 'company', sources: ['n2'], explanation: 'Podle Yahoo Finance si firma zajistila úvěr ve výši 3,5 miliardy dolarů od Citi. Investoři sledují, jak ho použije.' }] });
    const ok = check(draft('Podle Benzingy akcie v pátek klesla zhruba o 6 % po varování Gartneru. Investoři se bojí o budoucnost neocloudů.'));
    expect(ok).toMatchObject({ ok: true });
    const bad = check(draft('Akcie v pátek klesla zhruba o 6 % po varování Gartneru. Investoři se bojí o budoucnost neocloudů.'));
    // Běh 25: the unattributed theme is left out (a thin analysis worth a repair), the other one still answers.
    expect(bad).toMatchObject({ ok: true, thin: true });
    expect((bad as { reasons: string[] }).reasons).toContain('unattributed_number:0');
    expect((bad as { analysis: { themes: { title: string }[] } }).analysis.themes.map(t => t.title)).toEqual(['Nový úvěr']);
  });
});

describe('page furniture inside paragraphs', () => {
  it('drops comment counters, image captions and "in this article" tickers; strips dated wire datelines', () => {
    const text = cleanArticleText([
      'Nebius Group rebound potential after weekly decline View all comments (0)0 Image 3: Nebius Group rebound potential after weekly decline. In this article: NBIS+0.07% Investing.com -- Nebius Group can rebound, but the chart is weak.',
      'Analysts said Nebius Group could recover if AI cloud demand holds up through the end of the year.',
      'AMSTERDAM, October 22, 2026--(BUSINESS WIRE)--Nebius Group N.V., the AI cloud company, today announced a senior secured facility provided by Citi.',
    ].join('\n')).join(' ');
    expect(text).not.toMatch(/View all comments|Image 3:|In this article|BUSINESS WIRE|AMSTERDAM/);
    expect(text).toMatch(/Analysts said Nebius Group could recover/);
    expect(text).toMatch(/^|\s(Nebius Group N\.V\., the AI cloud company, today announced)/);
    expect(text).toMatch(/today announced a senior secured facility/);
  });
});

describe('a summary with figures is replaced by the server, not a reason to reject the analysis', () => {
  it('drops the summary (the server writes its own), keeps the themes', async () => {
    const { analystValidator } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const articles = [
      { key: 'n1', factId: 'f1', ticker: 'NBIS', title: 'Why Is Nebius Group Stock Falling Friday?', summary: '', publisher: 'Benzinga', date: '2026-10-16',
        url: 'https://www.benzinga.com/x', excerpt: 'Nebius Group stock is trading nearly 6% lower on Friday after a warning from Gartner about neocloud providers.' },
      { key: 'n2', factId: 'f2', ticker: 'NBIS', title: 'Nebius secures a senior secured facility', summary: '', publisher: 'Yahoo Finance', date: '2026-10-22',
        url: 'https://finance.yahoo.com/y', excerpt: 'Nebius Group today announced that it has entered into a senior secured facility provided by Citi.' },
    ];
    const check = analystValidator({ mode: 'move', lang: 'cs', subject: 'NBIS', facts: [], articles, tickers: ['NBIS'], keywords: ['NBIS', 'Nebius'] });
    const themes = [
      { title: 'Obavy o výdaje na AI', scope: 'sector', sources: ['n1'], explanation: 'Podle Benzingy akcie v pátek klesla po varování Gartneru. Investoři se bojí o budoucnost neocloudů.' },
      { title: 'Nový úvěr od Citi', scope: 'company', sources: ['n2'], explanation: 'Podle Yahoo Finance si firma zajistila nový úvěr od Citi. Investoři sledují, jak ho použije.' }];
    const result = check({ summary: 'Akcie za týden spadla o 20 % kvůli obavám o AI.', themes, watch: ['Další zprávy o financování.'] });
    expect(result).toMatchObject({ ok: true, analysis: { summary: '' } });
    // Any other summary problem (a link, advice) still rejects it.
    expect(check({ summary: 'Kup to hned na https://evil.example.com.', themes, watch: [] })).toMatchObject({ ok: false });
  });
});

describe('watch items must say what to watch', () => {
  it('drops a bare symbol from the watch list', async () => {
    const { analystValidator } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const articles = [{ key: 'n1', factId: 'f1', ticker: 'NBIS', title: 'Nebius falls', summary: '', publisher: 'Benzinga', date: '2026-10-16', url: 'https://www.benzinga.com/x',
      excerpt: 'Nebius Group stock fell on Friday after a warning from Gartner about neocloud providers.' }];
    const check = analystValidator({ mode: 'move', lang: 'cs', subject: 'NBIS', facts: [], articles, tickers: ['NBIS'], keywords: ['NBIS', 'Nebius'] });
    const result = check({ summary: 'Akcii tlačí dolů obavy o neocloudy.', watch: ['NBIS', 'Jestli Gartner své varování zopakuje.'], themes: [
      { title: 'Varování Gartneru', scope: 'sector', sources: ['n1'], explanation: 'Podle Benzingy akcie v pátek klesla po varování Gartneru. Investoři se bojí o neocloudy.' }] });
    expect(result).toMatchObject({ ok: true, analysis: { watch: ['Jestli Gartner své varování zopakuje.'] } });
  });
});

describe('article figures: rounded or from another shown article of the named publisher', () => {
  it('accepts "o 20 %" for an article "20.08%", and a figure of another shown article whose publisher is named (added as a source)', async () => {
    const { analystValidator } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const articles = [
      { key: 'n1', factId: 'f1', ticker: 'NBIS', title: 'Nebius rebound potential', summary: '', publisher: 'Investing', date: '2026-10-16', url: 'https://www.investing.com/x',
        excerpt: 'NBIS is down 6.17% today and 20.08% over one week as investors worry about AI spending.' },
      { key: 'n2', factId: 'f2', ticker: 'NBIS', title: 'Why Is Nebius Group Stock Falling Friday?', summary: '', publisher: 'Benzinga', date: '2026-10-16', url: 'https://www.benzinga.com/y',
        excerpt: 'Nebius Group stock is trading nearly 9% lower on Friday after a warning from Gartner about neocloud providers.' },
    ];
    const check = analystValidator({ mode: 'move', lang: 'cs', subject: 'NBIS', facts: [], articles, tickers: ['NBIS'], keywords: ['NBIS', 'Nebius'] });
    const draft = (first: string) => ({ summary: 'Akcii tlačí dolů obavy o výdaje na AI.', watch: [], themes: [
      { title: 'Týdenní propad', scope: 'company', sources: ['n1'], explanation: first },
      { title: 'Varování Gartneru', scope: 'sector', sources: ['n2'], explanation: 'Podle Benzingy akcie v pátek klesla po varování Gartneru. Investoři se bojí o neocloudy.' }] });
    const rounded = check(draft('Podle Investingu akcie za týden ztratila asi 20 %. Investoři se bojí o výdaje na AI.'));
    expect(rounded).toMatchObject({ ok: true });
    const other = check(draft('Podle Investingu akcie za týden výrazně ztratila a podle Benzingy v pátek klesla o 9 %. Investoři se bojí o výdaje na AI.'));
    expect(other).toMatchObject({ ok: true });
    expect((other as { analysis: { themes: { sources: string[] }[] } }).analysis.themes[0].sources).toEqual(['n1', 'n2']);
    // Not a rounding of any article figure: that theme is still refused (left out of the analysis).
    const wrong = check(draft('Podle Investingu akcie za týden ztratila asi 25 %. Investoři se bojí o výdaje na AI.'));
    expect(wrong).toMatchObject({ ok: true, thin: true });
    expect((wrong as { reasons: string[] }).reasons).toContain('unbacked_number:0');
    expect((wrong as { analysis: { themes: { title: string }[] } }).analysis.themes.map(t => t.title)).toEqual(['Varování Gartneru']);
  });
});

describe('attribution to the original source named in the cited article', () => {
  it('"podle HSBC" for a figure of a Yahoo Finance article that cites HSBC; an invented source is refused', async () => {
    const { analystValidator } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const articles = [
      { key: 'n1', factId: 'f1', ticker: 'CRWV', title: 'CoreWeave stock tumbles premarket', summary: '', publisher: 'Yahoo Finance', date: '2026-10-20', url: 'https://finance.yahoo.com/a',
        excerpt: 'CoreWeave stock fell after HSBC warned that rising debt costs could weigh on growth, pointing to a 36.5% downside potential.' },
      { key: 'n2', factId: 'f2', ticker: 'CRWV', title: 'Goldman upgrades CoreWeave', summary: '', publisher: 'Yahoo Finance', date: '2026-10-20', url: 'https://finance.yahoo.com/b',
        excerpt: 'CoreWeave shares rose after Goldman Sachs upgraded the neocloud provider to Buy from Neutral.' },
    ];
    const check = analystValidator({ mode: 'move', lang: 'cs', subject: 'CRWV', facts: [], articles, tickers: ['CRWV'], keywords: ['CRWV', 'CoreWeave'] });
    const draft = (first: string) => ({ summary: 'Akcii tíží obavy z dluhu.', watch: [], themes: [
      { title: 'Varování HSBC', scope: 'company', sources: ['n1'], explanation: first },
      { title: 'Upgrade od Goldman Sachs', scope: 'company', sources: ['n2'], explanation: 'Goldman Sachs zvedl doporučení na nákup. Akcie po zprávě krátce rostla.' }] });
    expect(check(draft('Podle HSBC může akcie klesnout ještě o 36,5 %, protože rostou náklady na dluh. Banka zároveň zmiňuje silnou poptávku zákazníků.'))).toMatchObject({ ok: true });
    const invented = check(draft('Podle Morgan Stanley může akcie klesnout ještě o 36,5 %, protože rostou náklady na dluh. Banka zmiňuje silnou poptávku.'));
    expect((invented as { reasons: string[] }).reasons).toContain('unattributed_number:0');
  });
});

describe('article ids never reach the answer', () => {
  it('strips "(n1)" / "[n2]" from the analyst text; a bare id is a technical label', async () => {
    const { analystValidator } = await import('../../supabase/functions/agent/core/newsAnalyst.ts');
    const articles = [{ key: 'n1', factId: 'f1', ticker: 'NBIS', title: 'Nebius falls', summary: '', publisher: 'Benzinga', date: '2026-10-16', url: 'https://www.benzinga.com/x',
      excerpt: 'Nebius Group stock fell nearly 6% on Friday after a warning from Gartner about neocloud providers.' }];
    const check = analystValidator({ mode: 'move', lang: 'cs', subject: 'NBIS', facts: [], articles, tickers: ['NBIS'], keywords: ['NBIS', 'Nebius'] });
    const theme = (explanation: string) => ({ summary: 'Akcii tlačí dolů obavy o neocloudy [n1].', watch: [], themes: [{ title: 'Varování Gartneru (n1)', scope: 'sector', sources: ['n1'], explanation }] });
    const ok = check(theme('Podle Benzingy (n1) akcie v pátek klesla téměř o 6 % po varování Gartneru. Investoři se bojí o neocloudy.'));
    expect(ok).toMatchObject({ ok: true });
    expect(JSON.stringify(ok)).not.toMatch(/\(n1\)|\[n1\]/);
    const bare = check(theme('Podle Benzingy v článku n1 akcie v pátek klesla po varování Gartneru. Investoři se bojí o neocloudy.'));
    expect((bare as { reasons: string[] }).reasons).toContain('technical:0');
  });
});

describe('codex review of A1: the shared Tavily budget fails closed', () => {
  it.each([
    ['spent', async () => false],
    ['an error', async () => { throw new Error('PGRST202 function not found'); }],
  ])('a reservation that is %s means no Tavily request; the headlines still answer', async (_label, reserveSearch) => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => new URL(String(u)).hostname === 'api.tavily.com' ? json({ results: [] }) : json([]));
    const s = createMarketSource(fakeCaller({ ticker_profiles: [] }).client, { fetchImpl: fetchImpl as unknown as typeof fetch, now: Date.now,
      keys: { TAVILY_API_KEY: 'tvly-synthetic' }, reserveSearch });
    await s.news('NBIS', { from: '2026-10-16', to: '2026-10-23' }, 'cs', { signal: new AbortController().signal, deadline: Date.now() + 8000 }, { articles: { related: [] } });
    expect(fetchImpl.mock.calls.some(c => new URL(String(c[0])).hostname === 'api.tavily.com')).toBe(false);
  });
  it('a granted reservation searches', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => new URL(String(u)).hostname === 'api.tavily.com' ? json({ results: [] }) : json([]));
    const reserveSearch = vi.fn(async () => true);
    const s = createMarketSource(fakeCaller({ ticker_profiles: [] }).client, { fetchImpl: fetchImpl as unknown as typeof fetch, now: Date.now,
      keys: { TAVILY_API_KEY: 'tvly-synthetic' }, reserveSearch });
    await s.news('NBIS', { from: '2026-10-16', to: '2026-10-23' }, 'cs', { signal: new AbortController().signal, deadline: Date.now() + 8000 }, { articles: { related: [] } });
    expect(reserveSearch).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(c => new URL(String(c[0])).hostname === 'api.tavily.com')).toBe(true);
  });
});
