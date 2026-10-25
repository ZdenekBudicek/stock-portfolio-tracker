// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import { routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import { ROUTER_PROMPT } from '../../supabase/functions/agent/core/prompts.ts';
import { complete, estimateInputTokens } from '../../supabase/functions/agent/core/llm.ts';
import { budgetFor } from '../test/agentLlmFixture';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, routeReply, shownFactIds } from '../test/agentLlmFixture';

const routeFormat = { type: 'json_schema', json_schema: { name: 'route', strict: true, schema: {
  type: 'object', properties: { group: { type: 'string', enum: ['portfolio', 'dane', 'trh', 'valuace', 'obecne', 'mimo_temu'] },
    lang: { type: 'string', enum: ['cs', 'sk', 'en'] }, tickers: { type: 'array', items: { type: 'string' } },
    analysis: { type: 'boolean' }, clarify: { type: 'boolean' } },
  required: ['group', 'lang', 'tickers', 'analysis', 'clarify'], additionalProperties: false,
} } };

describe('Běh 21c router wire contract', () => {
  it.each(['openai/gpt-oss-20b', 'openai/gpt-oss-120b'])('sends the exact bounded strict router request for %s', async id => {
    const model = fakeModel(body => {
      const format = (body as unknown as { response_format: unknown }).response_format;
      return JSON.stringify(format) === JSON.stringify(routeFormat) ? routeReply({ group: 'trh', lang: 'en', analysis: false })
        : new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'json_validate_failed', param: 'response_format' } }), { status: 400 });
    });
    const deps = llmDeps(model.fetchImpl);
    deps.policy = { ...deps.policy, router: [{ provider: 'groq', id, reasoningEffort: 'low' }] };
    const question = 'Tell me about markets';
    const route = await routeQuestion(question, [], chatCtx({ lang: 'en' }), deps);
    expect(route.group).toBe('trh');
    expect(model.bodies).toEqual([{ model: id, messages: [{ role: 'system', content: ROUTER_PROMPT }, { role: 'user', content: question }],
      max_completion_tokens: 700, temperature: 0.2, stream: false, response_format: routeFormat, include_reasoning: false, reasoning_effort: 'low' }]);
    expect(deps.tokens.attempts[0].outcome).toBe('ok');
    expect(deps.tokens.attempts[0].inputUpperBound).toBe(estimateInputTokens(model.bodies[0].messages as never, [], 1, routeFormat));
    expect(deps.tokens.attempts[0].inputUpperBound).toBeGreaterThan(estimateInputTokens(model.bodies[0].messages as never, []));
  });

  it('retains only allowlisted provider parameters and JSON validation codes', async () => {
    const model = fakeModel(() => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'json_validate_failed',
      param: 'response_format', message: 'secret account 12345', failed_generation: 'private data' } }), { status: 400 }));
    const deps = llmDeps(model.fetchImpl);
    await complete([deps.policy.router[0]], { messages: [{ role: 'user', content: 'Synthetic' }], tools: [], maxOutput: 700, phase: 'router' },
      { ...deps, budget: budgetFor() }).catch(() => {});
    expect(deps.tokens.attempts[0].rejectionReasons).toEqual(expect.arrayContaining(['json_validate_failed', 'param_response_format']));
    expect(JSON.stringify(deps.tokens.attempts)).not.toMatch(/secret|12345|private data/);
  });
});

describe('Běh 21c required evidence', () => {
  it('B fixture can load its own portfolio summary', async () => {
    const result = await executeTool('get_portfolio_summary', {}, chatCtx({ user: 'B', lang: 'en' }));
    expect(result.ok).toBe(true);
    // Twenty SYNC shares at 55 USD plus 100 USD cash.
    if (result.ok) expect(result.facts.find(f => f.id === 'portfolio:total_value')?.value).toBe(1200);
  });

  it.each(['How much is my portfolio worth?', 'Kolik mám v portfoliu?', 'Koľko mám v portfóliu?'])('requires portfolio value despite an unrelated router/tool response: %s', async question => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'trh', lang: 'en', tickers: [] })
      : llmResponse({ content: '{}' }));
    const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx({ user: 'B', lang: 'en' }), llm: llmDeps(model.fetchImpl) });
    expect(result.metrics.toolsUsed).toContain('get_portfolio_summary');
    expect(result.answer?.text).toMatch(/1[\s,]200/);
    expect(result.answer?.text).not.toMatch(/SYNA|SYNB|3[ ,]050|could not load/);
  });

  it('requires annual tax even when the model chooses only realized gains', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'trh', tickers: ['SYNA'] })
      : body.tools ? llmResponse({ toolCalls: [{ name: 'get_realized_pnl', arguments: { from: '2026-01-01', to: '2026-10-23', currency: 'USD', ticker: 'SYNA' } }] })
      : llmResponse({ content: JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts', factIds: shownFactIds(body) }] }) }));
    const result = await answerQuestion({ request: chatRequest('SYNA stojí 150 USD. Je to tedy moje letošní daň?'), history: [] },
      { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(result.metrics.toolsUsed).toContain('get_tax_report');
    expect(result.answer?.text).toMatch(/Odhad daně za rok 2026 je/);
    expect(result.answer?.text).not.toMatch(/(?:daň|daně)[^\n.]{0,40}150/);
  });
});
