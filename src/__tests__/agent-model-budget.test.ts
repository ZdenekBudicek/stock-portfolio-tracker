// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { complete, createTokenBudget, estimateInputTokens } from '../../supabase/functions/agent/core/llm.ts';
import { sanitizeReasons } from '../../supabase/functions/agent/core/guards.ts';
import { budgetFor, chatCtx, chatRequest, fakeModel, isRouter, llmDeps, routeReply } from '../test/agentLlmFixture';

const messages = [{ role: 'user' as const, content: 'synthetic question' }];
const response = (finish = 'stop', usage: unknown = { prompt_tokens: 80, completion_tokens: 100 }, content = '{}') =>
  new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }], usage }));
const buyDraft = JSON.stringify({ lang: 'cs', blocks: ['analysts', 'valuation', 'context', 'risks', 'verdict'].map(kind =>
  ({ kind, text: '', claims: {}, sourceIds: [] })), verdict: 'attractive', confidence: 'low', wouldChange: 'evidence' });

describe('I3 accounting and audit', () => {
  it('bounds even byte-sized tokens, including schemas and non-Latin text', () => {
    const content = ' x9!\u0001漢🙂'.repeat(30);
    expect(estimateInputTokens([{ role: 'user', content }], [])).toBeGreaterThanOrEqual(new TextEncoder().encode(content).length);
  });

  it('includes unknown failed calls in the same counters as the question budget', async () => {
    const model = fakeModel(() => { throw new Error('private account text'); });
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() }).catch(() => {});
    expect(deps.tokens.input + deps.tokens.output).toBe(deps.tokens.spent);
    expect(deps.tokens.attempts).toHaveLength(2);
    expect(deps.tokens.attempts.every(a => a.usageSource === 'reserved' && a.outcome === 'network')).toBe(true);
    expect(JSON.stringify(deps.tokens.attempts)).not.toContain('private');
  });

  it('counts reasoning once as a subset of completion tokens', async () => {
    const model = fakeModel(() => response('stop', { prompt_tokens: 80, completion_tokens: 400, total_tokens: 480,
      completion_tokens_details: { reasoning_tokens: 300 } }));
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() });
    expect(deps.tokens.spent).toBe(480);
    expect(deps.tokens.attempts[0]).toMatchObject({ reasoningTokens: 300, chargedInput: 80, chargedOutput: 400 });
  });

  it.each([
    { prompt_tokens: -1, completion_tokens: 10 },
    { prompt_tokens: 0.5, completion_tokens: 10 },
    { prompt_tokens: 80, completion_tokens: 100, total_tokens: 50 },
    { prompt_tokens: 80, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 101 } },
  ])('charges the reservation for invalid usage %j', async usage => {
    const model = fakeModel(() => response('stop', usage));
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() });
    expect(deps.tokens.input + deps.tokens.output).toBe(deps.tokens.spent);
    expect(deps.tokens.attempts[0].usageSource).toBe('reserved');
    expect(deps.tokens.spent).toBe(estimateInputTokens(messages, []) + 500);
  });

  it('retains a larger reported total instead of dropping additional output', async () => {
    const model = fakeModel(() => response('stop', { prompt_tokens: 80, completion_tokens: 100, total_tokens: 300 }));
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() });
    expect(deps.tokens.spent).toBe(300);
  });

  it('preserves a future call reservation across provider failures', async () => {
    const model = fakeModel(() => new Response('busy', { status: 500 }));
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500, keepTokens: 7500, minOutput: 500 },
      { ...deps, budget: budgetFor() }).catch(() => {});
    expect(model.bodies).toHaveLength(0);
  });

  it('stops after a provider violates the reserved total, retaining the observed usage', async () => {
    const model = fakeModel(() => response('stop', { prompt_tokens: 2900, completion_tokens: 900 }));
    const deps = llmDeps(model.fetchImpl);
    await expect(complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() }))
      .rejects.toMatchObject({ code: 'budget' });
    expect(model.bodies).toHaveLength(1);
    expect(deps.tokens.spent).toBe(3800);
    expect(deps.tokens.available()).toBe(0);
  });

  it('rejects malformed reservations instead of poisoning the ledger', () => {
    const tokens = createTokenBudget();
    expect(() => tokens.reserve(-5, 10)).toThrow();
    expect(() => tokens.reserve(Infinity, 0)).toThrow();
  });

  it('records rejection codes even when truncation produces no visible content', async () => {
    const model = fakeModel(() => response('length', undefined, ''));
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() }).catch(() => {});
    expect(deps.tokens.attempts).toHaveLength(2);
    expect(deps.tokens.attempts.every(a => a.finishReason === 'length' && a.rejectionReasons.includes('truncated'))).toBe(true);
  });

  it('accounts for reported usage on a failed HTTP call', async () => {
    const model = fakeModel(() => new Response(JSON.stringify({ error: 'private error', usage: { prompt_tokens: 80, completion_tokens: 100 } }), { status: 503 }));
    const deps = llmDeps(model.fetchImpl);
    await complete([deps.policy.main[0]], { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() }).catch(() => {});
    expect(deps.tokens.spent).toBe(180);
    expect(deps.tokens.attempts[0]).toMatchObject({ outcome: 'http', usageSource: 'reported', rejectionReasons: ['http', 'http_503'] });
  });

  it('never saves arbitrary text that merely looks like a rejection code', () => {
    expect(sanitizeReasons(['unknown_fact:private-account', 'private_account', 'value:secret', 'private_account:secret']))
      .toEqual(['unknown_fact', 'invalid', 'value']);
  });

  it('learns and audits an input-bound discrepancy even on a failed attempt', async () => {
    const model = fakeModel((_body, call) => call === 0
      ? new Response(JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 10 } }), { status: 503 })
      : response());
    const deps = llmDeps(model.fetchImpl);
    await complete(deps.policy.main, { messages, tools: [], maxOutput: 500 }, { ...deps, budget: budgetFor() });
    expect(deps.tokens.attempts[0].rejectionReasons).toContain('input_bound_exceeded');
    expect(deps.tokens.attempts[1].inputUpperBound).toBeGreaterThanOrEqual(200);
  });
});

describe('I3 answer capacity and rejection evidence', () => {
  it('gives buy analysis and its repair 1500 output tokens without tool schemas', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ analysis: true, tickers: ['SYNA'] }) : response('stop', undefined, '{}'));
    const result = await answerQuestion({ request: chatRequest('Vyplatí se koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    const writers = model.bodies.filter(b => !isRouter(b));
    expect(writers).toHaveLength(2);
    expect(writers.every(b => !b.tools && b.max_completion_tokens >= 1500)).toBe(true);
    expect(result.metrics.attempts?.filter(a => a.phase !== 'router').map(a => a.rejectionReasons)).toEqual([['lang'], ['lang']]);
    expect(result.metrics.tokensIn + result.metrics.tokensOut).toBeLessThanOrEqual(8000);
  });

  it.each(['length', 'content_filter', 'private_account_name'])('never accepts a complete-looking draft with finish reason %s', async finish => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ analysis: true, tickers: ['SYNA'] }) : response(finish, undefined, buyDraft));
    const result = await answerQuestion({ request: chatRequest('Vyplatí se koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(result.outcome).toBe('fallback');
    const attempts = result.metrics.attempts?.filter(a => a.phase !== 'router');
    expect(attempts).toHaveLength(2);
    expect(attempts?.every(a => a.rejectionReasons.includes(finish === 'length' ? 'truncated' : 'finish_reason'))).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain('private_account_name');
  });

  it('records an unusable router completion before using the deterministic route', async () => {
    const model = fakeModel(body => isRouter(body) ? response('length', undefined,
      JSON.stringify({ group: 'mimo_temu', lang: 'cs' })) : response('stop', undefined, '{}'));
    const result = await answerQuestion({ request: chatRequest('Vyplatí se koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(result.metrics.attempts?.[0]).toMatchObject({ phase: 'router', outcome: 'invalid', rejectionReasons: ['truncated'] });
    expect(result.answer?.text).toContain('Můj názor');
  });

  it('keeps trusted fact lines outside a news wrapper when fitting evidence', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ analysis: true, tickers: ['SYNA'] }) : response('stop', undefined, '{}'));
    await answerQuestion({ request: chatRequest('Vyplatí se koupit SYNA?'), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    for (const body of model.bodies.filter(b => !isRouter(b))) for (const message of body.messages) {
      for (const block of (message.content ?? '').matchAll(/<untrusted_news>([\s\S]*?)<\/untrusted_news>/g)) {
        expect(block[1]).not.toMatch(/\[(?:analysts|fair_value|valuation|quote|holding|calc):/);
      }
    }
  });

  it.each(['Vyplatí se koupit SYNA?', 'Oplatí sa kúpiť SYNA?', 'Is SYNA worth buying?'])(
    'preserves the repair even when no attempt reports usage: %s', async question => {
      const model = fakeModel(() => response('stop', null, '{}'));
      const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
      const attempts = result.metrics.attempts!;
      expect(attempts.map(a => a.phase)).toEqual(['router', 'answer', 'repair']);
      expect(attempts.every(a => a.usageSource === 'reserved' && a.chargedInput + a.chargedOutput <= 3000)).toBe(true);
      expect(attempts.slice(1).map(a => a.outputLimit)).toEqual([1500, 1500]);
      expect(attempts.reduce((sum, a) => sum + a.chargedInput + a.chargedOutput, 0)).toBe(result.metrics.tokensIn + result.metrics.tokensOut);
      expect(result.metrics.tokensIn + result.metrics.tokensOut).toBeLessThanOrEqual(8000);
      expect(result.answer).not.toBeNull();
    });
});
