import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../supabase/functions/agent/core/protocol.ts';

// The demo must never reach the family Supabase project: importing its client fails this file.
vi.mock('@/integrations/supabase/client', () => { throw new Error('demo imported the family Supabase client'); });

const { createAssistantTransport, readAssistantConfig } = await import('@/lib/assistantTransport');
const { DEMO_QUESTIONS } = await import('@/demo/assistantReplay');
const questions = (lang: 'cs' | 'en') => DEMO_QUESTIONS.map(d => d.question[lang]);

const collect = async (events: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of events) out.push(e); return out; };
const ask = (question: string, lang: 'cs' | 'en' = 'cs') => ({ requestId: crypto.randomUUID(), question, lang });
afterEach(() => vi.restoreAllMocks());

describe('demo replay transport', () => {
  it('answers each demo question (one per capability) from synthetic replay data without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = createAssistantTransport('demo', { delayMs: 0 });
    expect(DEMO_QUESTIONS.map(d => d.key)).toEqual(['today', 'trades', 'realized', 'buy', 'move', 'scenarios', 'analysis', 'web']);
    for (const lang of ['cs', 'en'] as const) for (const question of questions(lang)) {
      const events = await collect(transport.stream(ask(question, lang), new AbortController().signal));
      expect(events[0].type).toBe('meta');
      const answer = events.find((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer');
      // Every prepared answer says it is a demo with invented figures and sources, and links nowhere.
      expect(answer?.text).toMatch(lang === 'cs' ? /Ukázková odpověď: data i zprávy jsou v demu smyšlené/ : /Demo answer: data and news are invented/);
      // No outlets in any answer (owner, 2026-10-24).
      expect(answer?.text).not.toMatch(/ukázkového zdroje|sample source|\(Zdroj|\(Source/);
      expect(answer?.text).not.toMatch(/NaN|undefined|Infinity/);
      expect(answer?.links).toEqual([]);
      expect(answer?.text).not.toMatch(/https?:|Reuters|Bloomberg|Yahoo|Benzinga|CNBC/);
      expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'ok' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('portfolio answers read the same demo data as the screens (today\'s top mover, NVDA price)', async () => {
    const { demoDb } = await import('@/demo/mockBackend');
    const db = demoDb();
    const held = (db.tables.positions as { ticker: string; shares: number }[]).filter(p => p.ticker !== 'CASH' && p.shares > 0 && db.prices[p.ticker]);
    const top = [...held].sort((a, b) => db.prices[b.ticker].changePct - db.prices[a.ticker].changePct)[0].ticker;
    const transport = createAssistantTransport('demo', { delayMs: 0 });
    const today = (await collect(transport.stream(ask(questions('cs')[0]), new AbortController().signal))).find(e => e.type === 'answer') as { text: string };
    expect(today.text).toContain(`Nejvíc roste ${top}`);
    const buy = (await collect(transport.stream(ask(questions('en')[3], 'en'), new AbortController().signal))).find(e => e.type === 'answer') as { text: string };
    const price = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(db.prices.NVDA.price);
    expect(buy.text).toContain(`against a price of ${price} USD`);
  });

  it('the outlook answer: the story first, every price once in one section', async () => {
    const transport = createAssistantTransport('demo', { delayMs: 0 });
    const events = await collect(transport.stream(ask(questions('cs')[5]), new AbortController().signal));
    const text = (events.find(e => e.type === 'answer') as { text: string }).text;
    const headings = ['O firmě', 'Co může táhnout růst', 'Slabiny a rizika', 'Ocenění a kde může být cena za 2 roky', 'Jak to vidím'];
    const at = headings.map(h => text.indexOf(`${h}\n`));
    expect(at.every(i => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text).toMatch(/Pesimistický:\*\* .*Základní:\*\* .*Optimistický:\*\* /s);
    expect(text.match(/průměrný cíl na 12 měsíců/g)).toHaveLength(1);
    // Written from its top: nothing is sent ahead of the answer.
    expect(events.some(e => e.type === 'section')).toBe(false);
  });

  it('explains the demo mode for an unknown question and keeps a local thread list', async () => {
    const transport = createAssistantTransport('demo', { delayMs: 0 });
    const events = await collect(transport.stream(ask('Kolik stojí pivo v Brně?'), new AbortController().signal));
    const answer = events.find((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.text).toMatch(/V demo verzi je chat vypnutý/);
    const english = await collect(transport.stream(ask('What is the weather?', 'en'), new AbortController().signal));
    expect((english.find(e => e.type === 'answer') as { text: string }).text).toMatch(/demo/i);
    const threads = await transport.threads(new AbortController().signal);
    expect(threads).toHaveLength(2);
    const history = await transport.history(threads[0].id, new AbortController().signal);
    expect(history.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    await transport.remove(threads[0].id, new AbortController().signal);
    expect(await transport.threads(new AbortController().signal)).toHaveLength(1);
  });

  it('stops a replay when cancelled', async () => {
    const transport = createAssistantTransport('demo', { delayMs: 50 });
    const controller = new AbortController();
    const iterator = transport.stream(ask(questions('cs')[0]), controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'meta' });
    expect((await iterator.next()).value).toMatchObject({ type: 'status' });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
});

describe('assistant UI flag', () => {
  it('is on unless VITE_ASSISTANT_ENABLED is exactly false (server AGENT_ENABLED is the kill switch); the fixture transport needs a dev build', () => {
    expect(readAssistantConfig({})).toEqual({ enabled: true, mode: 'live' });
    expect(readAssistantConfig({ VITE_ASSISTANT_ENABLED: 'false' }).enabled).toBe(false);
    expect(readAssistantConfig({ VITE_ASSISTANT_ENABLED: '1' }).enabled).toBe(true);
    expect(readAssistantConfig({ VITE_ASSISTANT_ENABLED: 'true', VITE_ASSISTANT_TRANSPORT: 'demo' })).toEqual({ enabled: true, mode: 'demo' });
    // The static public demo build (vite --mode demo) replays without any flag.
    expect(readAssistantConfig({ MODE: 'demo' })).toEqual({ enabled: true, mode: 'demo' });
    expect(readAssistantConfig({ VITE_ASSISTANT_ENABLED: 'true', VITE_ASSISTANT_TRANSPORT: 'fixture', DEV: false }).mode).toBe('live');
    expect(readAssistantConfig({ VITE_ASSISTANT_ENABLED: 'true', VITE_ASSISTANT_TRANSPORT: 'fixture', DEV: true }).mode).toBe('fixture');
  });

  it('the fixture transport talks only to a loopback runner', () => {
    expect(() => createAssistantTransport('fixture', { baseUrl: 'https://example.com/agent' })).toThrow();
    expect(() => createAssistantTransport('fixture', { baseUrl: 'http://127.0.0.1:8787' })).not.toThrow();
  });
});

describe('demo scenarios', () => {
  it('are ordered: bear below today\'s price, base and bull above it', async () => {
    const { createAssistantTransport: make } = await import('@/lib/assistantTransport');
    const transport = make('demo', { delayMs: 0 });
    const events = []; for await (const e of transport.stream({ requestId: crypto.randomUUID(), question: 'Analyse MSFT for me: what it does, how you see its future and where the price will be in 2 years.', lang: 'en' }, new AbortController().signal)) events.push(e);
    const text = (events.find(e => e.type === 'answer') as { text: string }).text;
    const yearly = [...text.matchAll(/USD, ([+−])[\d.,]+ % a year/g)].map(m => m[1]);
    expect(yearly).toEqual(['−', '+', '+']);
  });
});
