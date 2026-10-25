// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { heuristicRoute, keywordIntent } from '../../supabase/functions/agent/core/router.ts';
import { fixtureRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { recordRun } from '../../supabase/functions/agent/core/context.ts';
import { generalAnswer } from '../../supabase/functions/agent/core/generalAnswer.ts';
import { buildVerifiedTemplate, renderSelectedFacts } from '../../supabase/functions/agent/core/answerTemplate.ts';
import { expandDraft, validateAnswer } from '../../supabase/functions/agent/core/grounding.ts';
import type { Lang } from '../../supabase/functions/agent/core/protocol.ts';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, rateLimited } from '../test/agentLlmFixture';

describe('Běh 20b keyword regressions', () => {
  it.each([
    ['Kolik jsem letos prodělal na SYNA?', 'realized'], ['Kolik jsem prodělala na SYNA?', 'realized'],
    ['Koľko som tento rok prerobil na SYNA?', 'realized'], ['Koľko som prerobila na SYNA?', 'realized'],
    ['How much did I lose on SYNA this year?', 'realized'], ['Did I not lose money on SYNA?', 'realized'],
    ['Neprodělala jsem na SYNA?', 'realized'], ['Neprerobil som na SYNA?', 'realized'],
    ['Jaký mám letos výnos portfolia?', 'performance'], ['Akú má moje portfólio výkonnosť?', 'performance'],
    ['How did my portfolio perform this year?', 'performance'],
    ['Jak mám rozložené portfolio podle sektorů?', 'allocation'], ['Aká je alokácia portfólia?', 'allocation'],
    ['What is my sector allocation?', 'allocation'],
    ['Nechci výkonnost, ukaž alokaci.', 'allocation'], ['Nechcem alokáciu, ukáž výkonnosť.', 'performance'],
    ["I don't want allocation; show performance.", 'performance'],
    ['Nechci vědět, kolik jsem prodělal na SYNA; ukaž alokaci.', 'allocation'],
    ['Nechcem vedieť, koľko som prerobil na SYNA; ukáž alokáciu.', 'allocation'],
    ["I don't want to know how much I lost on SYNA; show allocation.", 'allocation'],
    ['Nechci cenu bitcoinu, ukaž výkonnost.', 'performance'],
    ['Nechcem cenu bitcoinu, ukáž alokáciu.', 'allocation'],
    ["Don't show the bitcoin price; show performance.", 'performance'],
  ])('%s', (question, intent) => expect(keywordIntent(question)).toBe(intent));

  it.each(['Kolik teď stojí bitcoin?', 'Koľko teraz stojí bitcoin?', 'How much is one bitcoin worth right now?',
    'Není cena bitcoinu nižší?', 'Nie je cena bitcoinu nižšia?', "Isn't the bitcoin price lower?"])(
    'crypto quote: %s', question => {
      expect(heuristicRoute(question, [], chatCtx(), 'en')).toMatchObject({ intent: 'quote', group: 'trh', tickers: ['BTC'], analysis: false });
    });

  it.each([
    ['Kolik jsem letos prodělal na SYNA?', 'get_realized_pnl', /jsi na SYNA realizoval zisk \d/, /cena SYNA/],
    ['Jaký mám letos výnos portfolia?', 'get_performance', /má tvoje portfolio výnos \d+,\d\s%/, /hodnota portfolia/],
    ['Jak mám rozložené portfolio podle sektorů?', 'get_allocation', /technology/i, /hodnota portfolia/],
    ['How much is one bitcoin worth right now?', 'get_quote', /BTC price/, /portfolio value/],
  ] as const)('answers the requested evidence: %s', async (question, tool, wanted, unwanted) => {
    const result = await answerQuestion({ request: chatRequest(question), history: [] },
      { ctx: chatCtx(), llm: llmDeps(fakeModel(() => rateLimited()).fetchImpl) });
    expect(result.answer?.trace.some(t => t.state === 'ok')).toBe(true);
    expect(result.answer?.text).toMatch(wanted);
    expect(result.answer?.text).not.toMatch(unwanted);
    expect(result.metrics.toolsUsed).toContain(tool);
  });
});

describe('OTHER residence qualification', () => {
  it('cannot skip the residence check when the model requests only neutral realized data', async () => {
    const model = fakeModel(body => isRouter(body) ? rateLimited() : llmResponse({ toolCalls: [{ name: 'get_realized_pnl',
      arguments: { from: '2026-01-01', to: '2026-10-23', currency: 'CZK' } }] }));
    const result = await answerQuestion({ request: chatRequest('Kolik letos zaplatím daň?'), history: [] },
      { ctx: chatCtx({ repo: fixtureRepo('C') }), llm: llmDeps(model.fetchImpl) });
    expect(result.metrics.toolsUsed).toContain('get_tax_report');
    expect(result.answer?.text).toMatch(/nemá daňový model/);
  });
  it.each(['cs', 'sk', 'en'] as Lang[])('qualifies both selected and fallback facts in %s', async lang => {
    const ctx = chatCtx({ repo: fixtureRepo('C'), lang });
    const tax = await executeTool('get_tax_report', { year: 2026 }, ctx);
    recordRun(ctx, { name: 'get_tax_report', args: { year: 2026 }, result: tax });
    const result = await executeTool('get_realized_pnl', { from: '2026-01-01', to: '2026-10-23', currency: 'CZK' }, ctx);
    if (!result.ok) throw new Error('Fixture failed');
    const draft = expandDraft({ lang, blocks: [{ kind: 'facts', text: '{{v}}', claims: { v: { factId: result.facts[0].id } }, sourceIds: [] }] }, ctx.facts);
    const checked = validateAnswer(draft, ctx.facts, ctx.calculations, { lang });
    if (!checked.ok) throw new Error('Draft failed');
    const route = heuristicRoute('What is my tax?', [], ctx, lang);
    for (const answer of [buildVerifiedTemplate(ctx, route), renderSelectedFacts(ctx, checked.draft, [])]) {
      expect(answer.text).toMatch(lang === 'en' ? /no tax model.*residence/i : /nemá.*daňový model.*rezidenc/i);
      expect(answer.text).toMatch(lang === 'en' ? /realized gains and losses/i : /realizovan[éý].*(zisk|výsled)/i);
      expect(answer.text).not.toMatch(/odhad daně|odhad dane|estimated tax/i);
    }
  });
});

describe('general answers without portfolio access', () => {
  it.each([
    ['cs', 'Jak Trackora počítá férovou hodnotu akcie?', /férov.*hodnot/i],
    ['sk', 'Ako Trackora počíta férovú hodnotu akcie?', /férov.*hodnot/i],
    ['en', 'How does Trackora calculate fair value?', /fair value/i],
    ['cs', 'Co je diverzifikace?', /diverzifikac/i],
    ['sk', 'Čo je diverzifikácia?', /diverzifikác/i],
    ['en', 'What is diversification?', /diversification/i],
    ['cs', 'Jak Trackora počítá výnos portfolia?', /výnos/i],
    ['sk', 'Ako Trackora počíta výnos portfólia?', /výnos/i],
    ['en', 'How does Trackora calculate portfolio returns?', /return/i],
  ] as const)('%s: %s', async (lang, question, expected) => {
    const repo = fixtureRepo('A');
    const load = vi.fn(async () => { throw new Error('Portfolio unavailable'); });
    const model = fakeModel(() => rateLimited());
    const result = await answerQuestion({ request: chatRequest(question, lang), history: [] },
      { ctx: chatCtx({ repo: { ...repo, load }, lang }), llm: llmDeps(model.fetchImpl) });
    expect(result.answer?.text).toMatch(expected);
    expect(result.outcome).toBe('ok');
    expect(load).not.toHaveBeenCalled();
    expect(model.fetchImpl).not.toHaveBeenCalled();
    expect(result.metrics.toolCalls).toBe(0);
  });

  it.each(['What is the fair value of SYNA?', 'What is my allocation?', 'Jaká je férová hodnota SYNA?',
    'Aká je férová hodnota SYNA?', 'What is my realized profit?', 'What is my sector allocation?'])(
    'does not substitute a definition for a requested value: %s', question => {
      expect(generalAnswer(question, 'en')).toBeNull();
    });
});

it('documents executable Node 24 runner commands and package script', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.scripts['agent:local']).toContain('node --experimental-transform-types scripts/agent-local.ts');
  const readme = readFileSync('evals/README.md', 'utf8');
  expect(readme).not.toMatch(/(?<!transform-types )node scripts\/agent-local\.ts/);
  expect(readme).toContain('node --experimental-transform-types scripts/agent-local.ts --fixture-auth --fake-llm');
});
