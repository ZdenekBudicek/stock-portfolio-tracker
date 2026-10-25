// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAnalysisEvidence, runChat } from '../../supabase/functions/agent/core/agent.ts';
import { fixtureMarket } from '../../supabase/functions/agent/core/fixture.ts';
import { createTokenBudget } from '../../supabase/functions/agent/core/llm.ts';
import { MAIN_PROMPT_TOKENS, mainPrompt, ROUTER_PROMPT, ROUTER_PROMPT_TOKENS } from '../../supabase/functions/agent/core/prompts.ts';
import type { AgentEvent, Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { estimateInputTokens } from '../../supabase/functions/agent/core/llm.ts';
import { budgetFor, chatCtx, chatRequest, collect, fakeModel, hangingFetch, history, isRouter, lastUser, llmDeps, llmResponse,
  rateLimited, routeReply, type SentBody, shownFactIds, TECHNICAL } from '../test/agentLlmFixture';

type Answer = Extract<AgentEvent, { type: 'answer' }>;
const answerOf = (events: AgentEvent[]) => events.find((e): e is Answer => e.type === 'answer');
const doneOf = (events: AgentEvent[]) => events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
const plain = (text: string) => text.replace(/\u00a0|\u202f/g, ' ');
afterEach(() => vi.useRealTimers());

function spyMarket() {
  const base = fixtureMarket();
  const calls: string[] = [];
  const wrap = <K extends keyof typeof base>(name: K) => vi.fn((...args: Parameters<(typeof base)[K]>) => {
    calls.push(`${name}:${String(args[0])}`);
    return (base[name] as (...a: unknown[]) => unknown)(...args);
  }) as unknown as (typeof base)[K];
  const market = { ...base, quote: wrap('quote'), analysts: wrap('analysts'), fundamentals: wrap('fundamentals'), history: wrap('history'),
    news: wrap('news'), earnings: wrap('earnings') };
  return { market, calls };
}

const lazyDraft = JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', text: 'Nemohu doporučit nákup ani prodej.', claims: {}, sourceIds: [] }] });
/** A model that answers immediately without looking at anything. */
const lazyModel = (lang: Lang = 'cs', group = 'valuace') => fakeModel(body => isRouter(body)
  ? routeReply({ group, lang, tickers: ['SYNA'], analysis: true })
  : llmResponse({ content: lazyDraft.replace('"cs"', `"${lang}"`) }));

function goodAnalysis(body: SentBody) {
  const ids = shownFactIds(body);
  const find = (prefix: string) => ids.find(id => id === prefix || id.startsWith(`${prefix}#`))!;
  const c = (prefix: string, meaning = 'value') => ({ factId: find(prefix), meaning });
  return JSON.stringify({ lang: 'cs', blocks: [
    { kind: 'analysts', ticker: 'SYNA', text: '{{a}}', claims: { a: c('analysts:SYNA:target_mean') }, sourceIds: [] },
    { kind: 'valuation', ticker: 'SYNA', text: '{{f}} {{p}}', claims: { f: c('fair_value:SYNA:value'), p: c('quote:SYNA:price') }, sourceIds: [] },
    { kind: 'context', text: '', claims: {}, sourceIds: [] },
    { kind: 'risks', ticker: 'SYNA', text: '{{w}}', claims: { w: c('holding:SYNA:allocation') }, sourceIds: [] },
    { kind: 'verdict', text: '', claims: {}, sourceIds: [] },
  ], verdict: 'attractive', confidence: 'medium', wouldChange: 'evidence' });
}

describe('prompts', () => {
  it('stay within their token limits', () => {
    // Production fix 2026-10-24: the router prompt describes every group with cs/sk/en examples (was a one-liner).
    expect(ROUTER_PROMPT_TOKENS).toBe(900);
    expect(MAIN_PROMPT_TOKENS).toBe(800);
    expect(estimateInputTokens([{ role: 'system', content: ROUTER_PROMPT }], [])).toBeLessThanOrEqual(900);
    for (const lang of ['cs', 'sk', 'en'] as const) for (const analysis of [false, true]) {
      expect(estimateInputTokens([{ role: 'system', content: mainPrompt(lang, analysis) }], [])).toBeLessThanOrEqual(800);
    }
  });
  it('tell the model the binding product rules', () => {
    const prompt = mainPrompt('cs', true);
    expect(prompt).toMatch(/Czech/);
    expect(prompt).toMatch(/\{\{/);
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/analysts.*valuation.*context.*risks.*verdict/s);
    expect(prompt).toMatch(/never refuse/i);
    expect(prompt).toMatch(/decision is the user's/i);
  });
});

describe('buy analysis', () => {
  it('collects every mandatory piece of evidence itself, even when the model answers at once', async () => {
    const { market, calls } = spyMarket();
    const model = lazyModel();
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx({ market }), llm: llmDeps(model.fetchImpl) }));
    for (const call of ['quote:SYNA', 'analysts:SYNA', 'fundamentals:SYNA', 'history:SYNA', 'news:SYNA', 'earnings:SYNA']) expect(calls).toContain(call);
    const answer = answerOf(events)!;
    const text = plain(answer.text);
    // The lazy refusal failed validation: the verified template answers instead, in the fixed order.
    const order = ['Analytici', 'Ocenění', 'Kontext', 'Rizika', 'Můj názor'].map(h => text.indexOf(h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/spíš atraktivní/);
    expect(text).toMatch(/Jistota: (nízká|střední|vysoká)/);
    expect(text).toMatch(/Co by závěr změnilo/);
    expect(text).toMatch(/rozhodnutí je na tobě/i);
    expect(text).toContain('176,02 USD');
    expect(text).toContain('150,00 USD');
    expect(text).not.toMatch(/Nemohu doporučit/);
    expect(text).not.toMatch(TECHNICAL);
    expect(doneOf(events)).toMatchObject({ type: 'done', outcome: 'fallback', persisted: false });
  });

  it('a complete model draft is rendered with verified numbers in the analysis order', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ tickers: ['SYNA'], analysis: true }) : llmResponse({ content: goodAnalysis(body) }));
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    const text = plain(answerOf(events)!.text);
    expect(text).toContain('Průměrná cílová cena analytiků je 150,00 USD.');
    expect(text).toContain('176,02 USD');
    expect(text).toMatch(/Pozice už tvoří 49,2 % tvého portfolia/);
    expect(text).toMatch(/Jistota: střední/);
    expect(text).toMatch(/rozhodnutí je na tobě/i);
    expect(text).not.toMatch(TECHNICAL);
    expect(doneOf(events).outcome).toBe('ok');
    // The writer saw the concentration and the verdict ratio, computed through calculate.
    const writer = model.bodies.find(b => !isRouter(b))!;
    expect(shownFactIds(writer)).toEqual(expect.arrayContaining(['holding:SYNA:allocation', 'fair_value:SYNA:value', 'quote:SYNA:price']));
    expect(shownFactIds(writer).some(id => id.startsWith('calc:'))).toBe(true);
  });

  it('one unavailable branch does not erase the others', async () => {
    const base = fixtureMarket();
    const market = { ...base, analysts: vi.fn(async () => { throw new Error('provider down'); }) };
    const ctx = chatCtx({ market });
    const evidence = await collectAnalysisEvidence('SYNA', ctx);
    expect(evidence.analysts.ok).toBe(false);
    for (const key of ['quote', 'fundamentals', 'valuationHistory', 'fairValue', 'news', 'earnings', 'holdings', 'allocation'] as const) expect(evidence[key].ok).toBe(true);
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx({ market }), llm: llmDeps(lazyModel().fetchImpl) }));
    const text = plain(answerOf(events)!.text);
    expect(text).toMatch(/Analytici/);
    expect(text).toMatch(/nejsou k dispozici/);
    expect(text).toMatch(/spíš atraktivní/);
  });

  it('without a fair value gives only a conditional low-confidence view from the labelled analyst opinion', async () => {
    const base = fixtureMarket();
    const market = { ...base, fundamentals: vi.fn(async () => ({ data: null, source: 'company_fundamentals', asOf: null, fetchedAt: null, freshness: 'missing' as const, warnings: ['fundamentals_missing'] })) };
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx({ market }), llm: llmDeps(lazyModel().fetchImpl) }));
    const text = plain(answerOf(events)!.text);
    expect(text).toMatch(/názor analytiků/i);
    // Without its own valuation the view says it leans on the analysts only and is not firm.
    expect(text).toMatch(/opírám jen o analytiky/);
    expect(text).toMatch(/zhruba férová/);
    expect(text).toMatch(/Jistota: nízká/);
  });

  it('with no usable price or valuation says the data are insufficient and what is missing — never a refusal', async () => {
    const base = fixtureMarket();
    const none = (warning: string) => vi.fn(async () => ({ data: null, source: 'none', asOf: null, fetchedAt: null, freshness: 'missing' as const, warnings: [warning] }));
    const market = { ...base, quote: none('quote_missing'), fundamentals: none('fundamentals_missing'), analysts: none('analysts_missing') };
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx({ market }), llm: llmDeps(lazyModel().fetchImpl) }));
    const text = plain(answerOf(events)!.text);
    expect(text).toMatch(/nedostatek dat/i);
    expect(text).toMatch(/cena/);
    expect(text).toMatch(/rozhodnutí je na tobě/i);
    expect(text).not.toMatch(/spíš atraktivní|spíš drahá/);
  });

  it.each([
    ['en', 'Is it worth buying SYNA now?', /rather attractive/, ['Analysts', 'Valuation', 'Context', 'Risks', 'My view'], /the decision is yours/i],
    ['sk', 'Oplatí sa teraz kúpiť SYNA?', /skôr atraktívna/, ['Analytici', 'Ocenenie', 'Kontext', 'Riziká', 'Môj názor'], /rozhodnutie je na tebe/i],
  ] as const)('answers in the language of the question (%s)', async (lang, question, verdict, headings, decision) => {
    // The router guesses Czech; the question's own language wins.
    const model = fakeModel(body => isRouter(body) ? routeReply({ lang: 'cs', tickers: ['SYNA'], analysis: true }) : llmResponse({ content: lazyDraft }));
    const events = await collect(runChat({ request: chatRequest(question, 'cs'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    const text = plain(answerOf(events)!.text);
    expect(text).toMatch(verdict);
    // Every block of the verified template survives validation in this language too.
    for (const heading of headings) expect(text.split('\n')).toContain(heading);
    expect(text).toMatch(lang === 'en' ? /USD 176\.02/ : /176,02 USD/);
    expect(text).toMatch(decision);
    expect(text).not.toMatch(TECHNICAL);
    const writer = model.bodies.find(b => !isRouter(b))!;
    expect(writer.messages[0].content).toMatch(lang === 'en' ? /English/ : /Slovak/);
  });

  it('takes the ticker of a follow-up from the last turn and reloads its numbers', async () => {
    const { market, calls } = spyMarket();
    const model = fakeModel(body => isRouter(body) ? routeReply({ tickers: [], analysis: true }) : llmResponse({ content: lazyDraft }));
    const past = history([['Vyplatí se teď koupit SYNA?', 'Verdikt: spíš atraktivní.']]);
    const events = await collect(runChat({ request: chatRequest('A co rizika?'), history: past }, { ctx: chatCtx({ market }), llm: llmDeps(model.fetchImpl) }));
    expect(calls).toContain('quote:SYNA');
    expect(plain(answerOf(events)!.text)).toMatch(/Rizika/);
  });

  it('asks one short question for an unknown instrument', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ tickers: ['XYZQ'], analysis: true }) : llmResponse({ content: lazyDraft }));
    const events = await collect(runChat({ request: chatRequest('Vyplatí se koupit XYZQ?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    const text = answerOf(events)!.text;
    expect(text.split('?').length - 1).toBe(1);
    expect(text).not.toMatch(TECHNICAL);
  });
});

describe('portfolio questions and the tool loop', () => {
  it('runs model-requested tools and renders the cited fact', async () => {
    const model = fakeModel(body => {
      if (isRouter(body)) return routeReply({ group: 'portfolio', tickers: [] });
      if (!body.messages.some(m => m.role === 'tool')) return llmResponse({ toolCalls: [{ name: 'get_portfolio_summary', arguments: {} }] });
      return llmResponse({ content: JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', text: '{{v}}',
        claims: { v: { factId: 'portfolio:total_value', meaning: 'value' } }, sourceIds: ['portfolio:total_value'] }] }) });
    });
    const events = await collect(runChat({ request: chatRequest('Jak na tom je moje portfolio?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    expect(plain(answerOf(events)!.text)).toContain('Tvoje portfolio má hodnotu 3 050,74 USD');
    expect(doneOf(events).outcome).toBe('ok');
    const trace = events.filter(e => e.type === 'trace').flatMap(e => (e as Extract<AgentEvent, { type: 'trace' }>).items);
    expect(trace.length).toBeGreaterThan(0);
    expect(JSON.stringify(trace)).not.toMatch(/get_|portfolio_model/);
    expect(events.filter(e => e.type === 'status').length).toBeGreaterThan(0);
  });

  it('caps tool calls at 4 per round, refuses forbidden ones and stops offering tools after 2 rounds', async () => {
    const answer = llmResponse({ content: JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', text: '{{p}}', claims: { p: { factId: 'quote:SYNA:price', meaning: 'value' } }, sourceIds: [] }] }) });
    const wide = fakeModel(body => {
      if (isRouter(body)) return routeReply({ group: 'trh', tickers: ['SYNA'] });
      if (!body.tools?.length) return answer.clone();
      return llmResponse({ toolCalls: [...['SYNA', 'SYNB', 'SYNC', 'SYNW', 'BTC', 'bitcoin'].map(ticker => ({ name: 'get_quote', arguments: { ticker } })),
        { name: 'get_broker_key', arguments: {} }] });
    });
    const events = await collect(runChat({ request: chatRequest('Co nového u SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(wide.fetchImpl) }));
    const afterFirst = wide.bodies.filter(b => !isRouter(b))[1];
    const replies = afterFirst.messages.filter(m => m.role === 'tool').map(m => m.content ?? '');
    expect(replies).toHaveLength(7);
    expect(replies.filter(r => !/not run|refused/i.test(r))).toHaveLength(4);
    expect(replies[0]).toMatch(/^\[quote:SYNA:price\]/);
    expect(replies.filter(r => /not run/i.test(r))).toHaveLength(2);
    expect(replies.filter(r => /refused/i.test(r))).toHaveLength(1);
    expect(plain(answerOf(events)!.text)).toContain('Cena SYNA je 150,00 USD');
    // A model that keeps asking gets tools in at most two rounds, then must answer.
    const persistent = fakeModel(body => {
      if (isRouter(body)) return routeReply({ group: 'trh', tickers: ['SYNA'] });
      if (!body.tools?.length) return answer.clone();
      return llmResponse({ toolCalls: [{ name: 'get_quote', arguments: { ticker: 'SYNA' } }] });
    });
    await collect(runChat({ request: chatRequest('Co nového u SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(persistent.fetchImpl) }));
    const main = persistent.bodies.filter(b => !isRouter(b));
    expect(main.filter(b => b.tools?.length)).toHaveLength(2);
    expect(main.at(-1)!.tools ?? []).toEqual([]);
  });

  it('declines an off-topic question politely without tools', async () => {
    const { market, calls } = spyMarket();
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'mimo_temu', tickers: [] }) : llmResponse({ content: lazyDraft }));
    const events = await collect(runChat({ request: chatRequest('Jaké bude zítra počasí?'), history: [] }, { ctx: chatCtx({ market }), llm: llmDeps(model.fetchImpl) }));
    expect(calls).toEqual([]);
    expect(answerOf(events)!.text).toMatch(/portfoli|investic/i);
    expect(model.bodies.filter(b => !isRouter(b))).toHaveLength(0);
  });

  it('answers from verified facts when every model is rate-limited', async () => {
    const model = fakeModel(() => rateLimited());
    const events = await collect(runChat({ request: chatRequest('Kolik mám v portfoliu?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    expect(plain(answerOf(events)!.text)).toMatch(/3 050,74 USD/);
    expect(doneOf(events).outcome).toBe('fallback');
    expect(model.urls.every(u => new URL(u).hostname === 'api.groq.com')).toBe(true);
  });

  it('waits out a short main-model rate limit through the injected sleep and retries the same model', async () => {
    let limited = false;
    const model = fakeModel(body => {
      // The router chain (20b → 120b) is rate-limited without a reset; only the main loop sees the short limit.
      if (body.messages[0].content === ROUTER_PROMPT) return rateLimited();
      if (!limited) { limited = true; return rateLimited({ 'retry-after': '2' }); }
      return llmResponse({ content: lazyDraft });
    });
    const sleep = vi.fn(async () => {});
    const events = await collect(runChat({ request: chatRequest('Kolik mám v portfoliu?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl, { sleep }) }));
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown[])[0]).toBeGreaterThan(1900);
    expect(model.bodies.filter(b => b.messages[0].content !== ROUTER_PROMPT).slice(0, 2).map(b => b.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    expect(answerOf(events)).toBeDefined();
  });

  it('sends only the last 4 history messages, without a generated summary', async () => {
    const model = lazyModel('cs', 'portfolio');
    const turns = Array.from({ length: 10 }, (_, i) => [`otázka ${i}`, `odpověď ${i}`] as [string, string]);
    await collect(runChat({ request: chatRequest('Kolik mám v portfoliu?'), history: history(turns) }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    for (const body of model.bodies) {
      const text = body.messages.map(m => m.content ?? '').join('\n');
      expect(text).toContain('otázka 9');
      expect(text).toContain('odpověď 8');
      expect(text).not.toContain('otázka 7');
    }
  });
});

describe('budgets and deadlines', () => {
  it('keeps every call within 3,000 tokens and the whole question within 8,000, then still answers', async () => {
    const tokens = createTokenBudget();
    const model = fakeModel(body => {
      // Worst case: the model uses its whole output allowance every time.
      const usage = { input: Math.ceil(JSON.stringify(body.messages).length / 2), output: body.max_completion_tokens };
      if (isRouter(body)) return llmResponse({ content: JSON.stringify({ group: 'valuace', lang: 'cs', tickers: ['SYNA'], analysis: true, clarify: false }), usage });
      return llmResponse({ content: lazyDraft, usage });
    });
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl, { tokens }) }));
    expect(tokens.spent).toBeLessThanOrEqual(8000);
    for (const body of model.bodies) {
      expect(estimateInputTokens(body.messages.map(m => ({ role: m.role as 'user', content: m.content })), []) + body.max_completion_tokens).toBeLessThanOrEqual(3000 + 200);
    }
    expect(answerOf(events)).toBeDefined();
    expect(doneOf(events).type).toBe('done');
  });

  it('counts time spent before the context (auth, DB) against the 45 s deadline and still ends with an answer', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-23T12:00:00Z'));
    const budget = budgetFor(45_000, new AbortController().signal, Date.now);
    vi.advanceTimersByTime(30_000);
    const hang = hangingFetch();
    const started = Date.now();
    let finished = 0;
    const pending = collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx({ budget }), llm: llmDeps(hang.fetchImpl) }))
      .then(events => { finished = Date.now(); return events; });
    await vi.advanceTimersByTimeAsync(15_000);
    const events = await pending;
    // 15 s were left; models and tools stop 3 s before the deadline so the answer can still be stored.
    expect(finished - started).toBeLessThanOrEqual(12_000);
    expect(hang.signals.every(s => s.aborted)).toBe(true);
    expect(plain(answerOf(events)!.text)).toMatch(/Můj názor/);
    expect(doneOf(events).type).toBe('done');
  });

  it('a cancelled request aborts every in-flight fetch and ends as cancelled', async () => {
    const controller = new AbortController();
    const hang = hangingFetch();
    const pending = collect(runChat({ request: chatRequest('Kolik mám v portfoliu?'), history: [] },
      { ctx: chatCtx({ budget: budgetFor(45_000, controller.signal) }), llm: llmDeps(hang.fetchImpl) }));
    await new Promise(r => setTimeout(r, 20));
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    const events = await pending;
    expect(hang.signals.length).toBeGreaterThan(0);
    expect(hang.signals.every(s => s.aborted)).toBe(true);
    expect(doneOf(events)).toMatchObject({ type: 'done', outcome: 'cancelled' });
    expect(answerOf(events)).toBeUndefined();
  });

  it('never streams raw model text: the only answer event is the verified final one', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ tickers: ['SYNA'], analysis: true }) : llmResponse({ content: goodAnalysis(body) }));
    const events = await collect(runChat({ request: chatRequest('Vyplatí se teď koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    expect(events.filter(e => e.type === 'answer')).toHaveLength(1);
    expect(JSON.stringify(events.filter(e => e.type !== 'answer'))).not.toMatch(/factId|\{\{/);
    expect(lastUser(model.bodies.find(b => !isRouter(b))!)).toContain('Vyplatí se teď koupit SYNA?');
  });
});
