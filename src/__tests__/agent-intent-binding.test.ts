// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { runsOf } from '../../supabase/functions/agent/core/context.ts';
import type { Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { keywordIntent, routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import type { Intent } from '../../supabase/functions/agent/core/types.ts';
import { chatCtx, chatRequest, fakeModel, isRouter, lastUser, llmDeps, llmResponse, routeReply, shownFactIds, TECHNICAL } from '../test/agentLlmFixture';

// Production follow-up (2026-10-24): with the real router model answering, „Co se dnes děje s mými akciemi?“ ended in the
// generic portfolio tool loop (summary + holdings without dayChange, writer unknown_fact, generic template). A keyword intent
// must bind its mandatory evidence and answer facts whichever router answered and whatever plain tool call the main model makes.

const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');
type Case = { intent: Intent; question: string; lang?: Lang; calls: [string, Record<string, unknown>][]; text: RegExp[] };
const CASES: Case[] = [
  { intent: 'movers', question: 'Co se dnes děje s mými akciemi?', calls: [['get_holdings', { dayChange: true }], ['get_stock_news', { ticker: 'SYNA' }], ['get_stock_news', { ticker: 'SYNB' }]],
    text: [/Dnes se hodnota tvého portfolia změnila o \+25,01 USD \(\+0,8 %\)\./, /• SYNA: změna \+1,4 % \(\+20,00 USD\)\./, /• SYNB: změna \+0,5 % \(\+5,00 USD\)\./] },
  { intent: 'transactions', question: 'Jaké transakce jsem letos udělal?', calls: [['get_transactions', { from: '2026-01-01', to: '2026-10-23' }]],
    text: [/prodal 2 kusy za 300,00 USD/] },
  { intent: 'realized', question: 'Kolik jsem letos realizoval?', calls: [['get_realized_pnl', { from: '2026-01-01', currency: 'CZK' }]], text: [/realizoval zisk 1 506,95 Kč/] },
  { intent: 'tax', question: 'Jakou daň zaplatím za letošek?', calls: [['get_tax_report', { year: 2026 }], ['get_realized_pnl', { from: '2026-01-01', currency: 'CZK' }]],
    text: [/Odhad daně za rok 2026 je 0,00 Kč/] },
  { intent: 'dividends', question: 'Kolik jsem letos dostal na dividendách?', calls: [['get_dividends', { mode: 'received', from: '2026-01-01' }]], text: [/dividendy 12,00 USD/] },
  { intent: 'allocation', question: 'Jaká je moje alokace?', calls: [['get_allocation', {}]], text: [/Investovaná částka je 2 550 USD/] },
  { intent: 'performance', question: 'Jaká je výkonnost mého portfolia letos?', calls: [['get_performance', { from: '2026-01-01' }]], text: [/výnos 5,2 % a zisk 150,74 USD/] },
  { intent: 'holdings', question: 'Co držím?', calls: [['get_portfolio_summary', {}], ['get_holdings', {}]], text: [/3 050,74 USD/, /10 kusů SYNA/, /5 kusů SYNB/] },
  { intent: 'quote', question: 'Jaká je cena SYNA?', calls: [['get_quote', { ticker: 'SYNA' }]], text: [/SYNA/, /150,00 USD/] },
  { intent: 'buy', question: 'Mám koupit SYNA?', calls: [['get_quote', { ticker: 'SYNA' }], ['get_fair_value', { ticker: 'SYNA' }], ['get_analyst_view', { ticker: 'SYNA' }]],
    text: [/férovou hodnotu na 176,02 USD/, /150,00 USD/] },
  { intent: 'summary', question: 'Kolik mám v portfoliu?', calls: [['get_portfolio_summary', {}]], text: [/3 050,74 USD/] },
  { intent: 'movers', lang: 'sk', question: 'Čo sa dnes deje s mojimi akciami?', calls: [['get_holdings', { dayChange: true }]], text: [/\+25,01 USD/, /SYNA/] },
  { intent: 'movers', lang: 'en', question: "What's happening with my stocks today?", calls: [['get_holdings', { dayChange: true }]], text: [/\+USD 25\.01|USD \+25\.01/, /SYNA/] },
];

/** The real router model answers with a valid route; the main model makes a plain summary call whenever tools are offered. */
async function ask(question: string, route: Record<string, unknown>, lang: Lang = 'cs') {
  const model = fakeModel(body => {
    if (isRouter(body)) return routeReply(route);
    if (body.tools?.length) return llmResponse({ toolCalls: [{ name: 'get_portfolio_summary', arguments: {} }] });
    return llmResponse({ content: JSON.stringify({ lang, blocks: [{ kind: 'facts', factIds: shownFactIds(body) }] }) });
  });
  const ctx = chatCtx({ lang });
  const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) });
  return { ...result, text: plain(result.answer?.text ?? ''), bodies: model.bodies, runs: runsOf(ctx), ctx };
}

const ROUTES: Record<string, (lang: Lang) => Record<string, unknown>> = {
  portfolio: lang => ({ group: 'portfolio', lang, tickers: [], analysis: false, clarify: false }),
  obecne: lang => ({ group: 'obecne', lang, tickers: [], analysis: false, clarify: false }),
  trh: lang => ({ group: 'trh', lang, tickers: ['SYNA'], analysis: false, clarify: false }),
};

describe('keyword intents bind whichever router answered', () => {
  for (const c of CASES) for (const routeName of Object.keys(ROUTES)) {
    it(`${c.intent} (${c.lang ?? 'cs'}) "${c.question}" with a successful ${routeName} router`, async () => {
      const lang = c.lang ?? 'cs';
      expect(keywordIntent(c.question)).toBe(c.intent);
      const routed = await routeQuestion(c.question, [], chatCtx({ lang }), llmDeps(fakeModel(() => routeReply(ROUTES[routeName](lang))).fetchImpl));
      expect(routed.intent).toBe(c.intent);

      const r = await ask(c.question, ROUTES[routeName](lang), lang);
      // The router answered (no keyword fallback because of a failed router).
      expect(isRouter(r.bodies[0])).toBe(true);
      expect(r.metrics.attempts?.[0]).toMatchObject({ phase: 'router' });
      // Mandatory evidence ran with server arguments, before any writer call, and the main model was never offered tools.
      for (const [name, args] of c.calls) expect(r.runs.some(run => run.name === name && Object.entries(args)
        .every(([k, v]) => JSON.stringify((run.args as Record<string, unknown>)[k]) === JSON.stringify(v))), `${name} ${JSON.stringify(args)}`).toBe(true);
      const main = r.bodies.filter(b => !isRouter(b));
      expect(main.length).toBeGreaterThan(0);
      expect(main.every(b => !b.tools?.length)).toBe(true);
      if (c.intent !== 'holdings' && c.intent !== 'summary') expect(r.runs.map(run => run.name)).not.toContain('get_portfolio_summary');
      // The writer sees only the intent's facts (no tool transcript), so it cannot cite a fact this request did not make.
      if (c.intent !== 'buy') {
        const writer = main[0];
        expect(writer.messages.some(m => m.role === 'tool')).toBe(false);
        expect(lastUser(writer)).toMatch(/Required answer facts/);
        const shown = shownFactIds(writer);
        expect(shown.length).toBeGreaterThan(0);
        for (const id of shown) expect(r.ctx.facts.has(id), id).toBe(true);
        expect(r.metrics.attempts?.some(a => a.rejectionReasons.includes('unknown_fact'))).toBe(false);
      }
      expect(r.answer).not.toBeNull();
      for (const re of c.text) expect(r.text).toMatch(re);
      expect(r.text).not.toMatch(TECHNICAL);
    });
  }

  it('a question in decomposed Unicode (NFD) keeps its intent', async () => {
    const question = 'Co se dnes děje s mými akciemi?'.normalize('NFD');
    expect(keywordIntent(question)).toBe('movers');
    const r = await ask(question, ROUTES.portfolio('cs'));
    expect(r.runs.some(run => run.name === 'get_holdings' && (run.args as { dayChange?: boolean }).dayChange === true)).toBe(true);
    expect(r.text).toMatch(/Dnes se hodnota tvého portfolia změnila o \+25,01 USD/);
  });
});

describe('codex review of A5: an oversized history is a final, clear answer', () => {
  it('answers with the history-limit message (final, no "try again"), whatever the question', async () => {
    const { ToolInputError } = await import('../../supabase/functions/agent/core/types.ts');
    const { HISTORY_LIMIT_MESSAGE } = await import('../../supabase/functions/agent/core/workBudget.ts');
    const { fixtureRepo } = await import('../../supabase/functions/agent/core/fixture.ts');
    const base = fixtureRepo('A');
    const repo = { ...base, load: async () => { throw new ToolInputError('unavailable', HISTORY_LIMIT_MESSAGE); } };
    const ask2 = async (question: string, route: Record<string, unknown>) => {
      const model = fakeModel(body => isRouter(body) ? routeReply(route)
        : llmResponse({ content: JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', factIds: shownFactIds(body) }] }) }));
      return answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx({ repo }), llm: llmDeps(model.fetchImpl) });
    };
    for (const [question, route] of [['Jaká je cena SYNA?', { group: 'trh', lang: 'cs', tickers: ['SYNA'], analysis: false, clarify: false }],
      ['Kolik mám v portfoliu?', { group: 'portfolio', lang: 'cs', tickers: [], analysis: false, clarify: false }]] as const) {
      const r = await ask2(question, route);
      expect(r.error?.text).toBe(HISTORY_LIMIT_MESSAGE);
      expect(r.error?.text).not.toMatch(/znovu/);
    }
  });
});
