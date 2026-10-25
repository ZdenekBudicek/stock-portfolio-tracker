// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { complete, rejectCompletion } from '../../supabase/functions/agent/core/llm.ts';
import { expandDraft, validateAnswer } from '../../supabase/functions/agent/core/grounding.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { fixtureRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import { mainPrompt } from '../../supabase/functions/agent/core/prompts.ts';
import { modelToolSchemas } from '../../supabase/functions/agent/core/guards.ts';
import { allText, budgetFor, chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, routeReply, shownFactIds } from '../test/agentLlmFixture';

const harmony = (json: string) => `<|start|>assistant<|channel|>analysis<|message|>Consider {private reasoning} first.<|end|><|start|>assistant<|channel|>final<|message|>${json}<|return|>`;
const selected = (ids: string[], lang = 'cs') => JSON.stringify({ lang, blocks: [{ kind: 'facts', factIds: ids }] });
const response = (content: string, finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish,
  message: { role: 'assistant', content, reasoning: 'Private reasoning never rendered.' } }],
  usage: { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 120 } } }));

describe('Běh 21b provider replay and sanitized audit', () => {
  it('accepts standard nullable tool_calls beside a final content JSON', async () => {
    const model = fakeModel(() => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      role: 'assistant', content: '{"group":"portfolio"}', tool_calls: null, reasoning: 'synthetic reasoning',
    } }], usage: { prompt_tokens: 100, completion_tokens: 200 } })));
    const deps = llmDeps(model.fetchImpl);
    const result = await complete([deps.policy.main[0]], { messages: [{ role: 'user', content: 'Synthetic' }], tools: [], maxOutput: 500 },
      { ...deps, budget: budgetFor() });
    expect(result.message.content).toBe('{"group":"portfolio"}');
    expect(deps.tokens.attempts[0].outcome).toBe('ok');
  });

  it('preserves route priority when selecting the schema prefix that fits the call', () => {
    expect(modelToolSchemas(['get_tax_report', 'get_realized_pnl']).map(t => t.name)).toEqual(['get_tax_report', 'get_realized_pnl']);
  });

  it.each(['en', 'sk', 'cs'] as const)('accepts a realistic compact analysis in %s without repair', async lang => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ analysis: true, tickers: ['SYNA'], lang })
      : response(harmony(JSON.stringify({ lang, blocks: ['analysts', 'valuation', 'context', 'risks', 'verdict'].map(kind => ({ kind,
        factIds: kind === 'valuation' ? shownFactIds(body).filter(id => /^(quote|fair_value):/.test(id)).slice(0, 2) : [] })),
        verdict: 'attractive', confidence: 'low', wouldChange: 'evidence' }))));
    const question = { en: 'Is SYNA worth buying?', sk: 'Oplatí sa kúpiť SYNA?', cs: 'Vyplatí se koupit SYNA?' }[lang];
    const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx({ lang }), llm: llmDeps(model.fetchImpl) });
    expect(result.outcome).toBe('ok');
    expect(result.metrics.attempts?.map(a => a.phase)).toEqual(['router', 'answer']);
    expect(result.answer?.text).not.toMatch(/private|<\||factIds/);
  });

  it('keeps HTTP status and allowlisted provider type/code, excluding message and failed_generation', async () => {
    const model = fakeModel(() => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'tool_use_failed',
      message: 'private account 987654', failed_generation: '<|channel|>analysis secret' } }), { status: 400 }));
    const deps = llmDeps(model.fetchImpl);
    await complete([deps.policy.main[0]], { messages: [{ role: 'user', content: 'Synthetic' }], tools: [], maxOutput: 500 },
      { ...deps, budget: budgetFor() }).catch(() => {});
    expect(deps.tokens.attempts[0].rejectionReasons).toEqual(expect.arrayContaining(['http_400', 'invalid_request_error', 'tool_use_failed']));
    expect(JSON.stringify(deps.tokens.attempts)).not.toMatch(/secret|private|987654|failed_generation/);
  });

  it('sanitizes rejection reasons at the audit boundary, even for an untrusted caller', async () => {
    const model = fakeModel(() => response('{}'));
    const deps = llmDeps(model.fetchImpl);
    const done = await complete([deps.policy.main[0]], { messages: [{ role: 'user', content: 'Synthetic' }], tools: [], maxOutput: 500 },
      { ...deps, budget: budgetFor() });
    rejectCompletion(deps.tokens, done, ['unknown_fact:private-987654', 'private-987654']);
    expect(deps.tokens.attempts[0].rejectionReasons).toEqual(['unknown_fact', 'invalid']);
  });

  it('gives router reasoning room, JSON mode and a concrete boolean example; extracts only Harmony final', async () => {
    const model = fakeModel(body => body.max_completion_tokens < 600 ? response('', 'length') : response(harmony(JSON.stringify({
      group: 'trh', lang: 'en', tickers: [], analysis: false, clarify: false,
    }))));
    const deps = llmDeps(model.fetchImpl);
    const route = await routeQuestion('Tell me about markets', [], chatCtx({ lang: 'en' }), deps);
    expect(route.group).toBe('trh');
    expect(deps.tokens.attempts[0].outcome).toBe('ok');
    expect(model.bodies[0]).toMatchObject({ response_format: { type: 'json_schema', json_schema: { name: 'route', strict: true,
      schema: { additionalProperties: false, required: ['group', 'lang', 'tickers', 'analysis', 'clarify'] } } }, include_reasoning: false });
    expect(allText(model.bodies[0])).toContain('"analysis":false');
  });

  it('uses tool instructions without JSON-only mode, then a separate compact writer contract', async () => {
    const model = fakeModel(body => {
      if (isRouter(body)) return routeReply({ group: 'trh', tickers: ['SYNA'] });
      if (body.tools?.length) {
        if (body.messages[0].content?.includes('JSON only')) return new Response(JSON.stringify({ error: {
          type: 'invalid_request_error', code: 'tool_use_failed', message: 'synthetic conflicting instructions',
        } }), { status: 400 });
        return llmResponse({ toolCalls: [{ name: 'get_quote', arguments: { ticker: 'SYNA' } }] });
      }
      return response(selected(shownFactIds(body).slice(0, 1)));
    });
    const result = await answerQuestion({ request: chatRequest('Novinky SYNA'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(result.outcome).toBe('ok');
    const toolBody = model.bodies.find(b => b.tools)!;
    expect(toolBody).toBeDefined();
    expect(toolBody).not.toHaveProperty('response_format');
    expect(toolBody.messages[0].content).toContain('tools');
    expect(model.bodies.at(-1)).toMatchObject({ response_format: { type: 'json_object' } });
    expect(model.bodies.at(-1)?.tools).toBeUndefined();
  });

  it('audits raw Harmony tool text as tool_call_format without executing it', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'trh', tickers: ['SYNA'] })
      : response('<|start|>assistant to=functions.get_quote<|channel|>commentary<|message|>{"ticker":"SYNA"}<|call|>', 'tool_calls'));
    const result = await answerQuestion({ request: chatRequest('Novinky SYNA'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(result.metrics.attempts?.some(a => a.rejectionReasons.includes('tool_call_format'))).toBe(true);
    expect(result.answer?.text).not.toContain('<|');
  });
});

describe('Běh 21b compact selection contract', () => {
  it('advertises an executable compact example', () => {
    expect(mainPrompt('cs', false)).toContain('"factIds":["ID"]');
  });

  it('shows the whole analysis shape including its top-level decision fields', () => {
    const prompt = mainPrompt('en', true);
    const sample = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.indexOf('}.') + 1));
    expect(sample.blocks.map((b: { kind: string }) => b.kind)).toEqual(['analysts', 'valuation', 'context', 'risks', 'verdict']);
    expect(sample).toMatchObject({ verdict: 'attractive', confidence: 'low', wouldChange: 'evidence' });
  });

  it('expands only fact identity while retaining all Běh 14 meaning checks', async () => {
    const ctx = chatCtx();
    const result = await executeTool('get_quote', { ticker: 'SYNA' }, ctx);
    if (!result.ok) throw new Error('fixture');
    const id = result.facts[0].id;
    expect(validateAnswer(expandDraft(JSON.parse(selected([id])), ctx.facts), ctx.facts, []).ok).toBe(true);
    for (const extra of [{ text: 'Your tax bill is {{p}}' }, { claims: { p: { factId: id, meaning: 'loss' } } }]) {
      const raw = { lang: 'cs', blocks: [{ kind: 'facts', factIds: [id], ...extra }] };
      expect(validateAnswer(expandDraft(raw, ctx.facts), ctx.facts, []).ok).toBe(false);
    }
  });

  it.each([
    ['unknown_fact', selected(['quote:INVENTED:price'])],
    ['block_invalid', JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', factIds: 'wrong shape' }] })],
    ['missing_claim', JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', text: '{{p}}', claims: {} }] })],
    ['technical', JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', text: 'get_quote', claims: {} }] })],
    ['not_object', 'not JSON'],
  ])('repairs %s once, with codes only, to a realistic accepted draft', async (reason, invalid) => {
    let writes = 0;
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio' })
      : response(++writes === 1 ? invalid : harmony(selected(shownFactIds(body)))));
    const result = await answerQuestion({ request: chatRequest('Jaké transakce jsem letos provedl?'), history: [] },
      { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(result.outcome).toBe('ok');
    expect(result.metrics.attempts?.find(a => a.phase === 'answer')?.rejectionReasons).toContain(reason);
    expect(result.metrics.attempts?.find(a => a.phase === 'repair')?.outcome).toBe('ok');
    expect(result.metrics.tokensIn + result.metrics.tokensOut).toBeLessThanOrEqual(8000);
  });

  it.each([
    ['How much did I get in dividends this year?', 'en', 'A', 'get_dividends', /dividends/i],
    ['Čo držím v portfóliu?', 'sk', 'E', 'get_portfolio_summary', /Zatiaľ nič nedržíš/],
  ] as const)('loads required evidence before the writer: %s', async (question, lang, user, tool, text) => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio', lang })
      : response(selected(shownFactIds(body), lang)));
    const result = await answerQuestion({ request: chatRequest(question, lang), history: [] },
      { ctx: chatCtx({ repo: fixtureRepo(user), lang }), llm: llmDeps(model.fetchImpl) });
    expect(result.outcome).toBe('ok');
    expect(result.metrics.toolsUsed).toContain(tool);
    expect(result.answer?.text).toMatch(text);
    expect(result.answer?.text).not.toMatch(/nepodarilo|nedostupn|cannot answer/i);
  });

  it('keeps an explicitly forecast dividend question separate from received payments', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio', lang: 'en' })
      : response(selected(shownFactIds(body), 'en')));
    const ctx = chatCtx({ lang: 'en' });
    const result = await answerQuestion({ request: chatRequest('What is my dividend forecast?'), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) });
    expect(result.outcome).toBe('ok');
    expect([...ctx.facts.keys()]).toContain('dividends:forecast_annual');
    expect([...ctx.facts.keys()]).not.toContain('dividends:received');
    expect(result.answer?.text).toMatch(/forecast|estimate/i);
  });
});
