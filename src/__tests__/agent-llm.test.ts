// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllModelsFailed, CALL_TOKEN_LIMIT, complete, createTokenBudget, estimateInputTokens, QUESTION_TOKEN_LIMIT, QuotaError,
  type LlmMessage } from '../../supabase/functions/agent/core/llm.ts';
import { buildModelPolicy, DEFAULT_MODEL_POLICY, ModelPolicyError } from '../../supabase/functions/agent/core/modelPolicy.ts';
import { budgetFor, fakeModel, hangingFetch, llmResponse, rateLimited } from '../test/agentLlmFixture';

const messages: LlmMessage[] = [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Kolik mám v portfoliu?' }];
const input = { messages, tools: [], maxOutput: 500 };
const policy = buildModelPolicy(undefined);
const deps = (fetchImpl: typeof fetch, over: Partial<Parameters<typeof complete>[2]> = {}) =>
  ({ budget: budgetFor(), tokens: createTokenBudget(), policy, keys: { GROQ_API_KEY: 'synthetic' }, fetchImpl, ...over });
afterEach(() => vi.useRealTimers());

describe('model policy', () => {
  it('defaults to the Groq pool confirmed in phase 0 with OpenRouter off', () => {
    expect(DEFAULT_MODEL_POLICY.main.map(m => m.id)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(DEFAULT_MODEL_POLICY.router.map(m => m.id)).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    expect([...DEFAULT_MODEL_POLICY.main, ...DEFAULT_MODEL_POLICY.router].every(m => m.provider === 'groq')).toBe(true);
    expect(DEFAULT_MODEL_POLICY.openRouterEnabled).toBe(false);
    expect(policy).toEqual(DEFAULT_MODEL_POLICY);
  });

  it.each([
    ['an unknown (paid) Groq model', { main: [{ provider: 'groq', id: 'paid-model' }] }],
    ['the retired llama model', { main: [{ provider: 'groq', id: 'llama-3.3-70b-versatile' }] }],
    ['reasoning effort for a model without it', { main: [{ provider: 'groq', id: 'qwen/qwen3.8-27b', reasoningEffort: 'low' }] }],
    ['OpenRouter while disabled', { main: [{ provider: 'openrouter', id: 'vendor/model:free' }] }],
    ['an unverified :free model', { openRouter: { enabled: true, verified: {} }, main: [{ provider: 'openrouter', id: 'x:free' }] }],
    ['a verified model without privacy approval', { openRouter: { enabled: true, verified: { 'vendor/model:free': { verifiedAt: '2026-10-20', inputPrice: 0, outputPrice: 0, privacyApproved: false, tools: true } } },
      main: [{ provider: 'openrouter', id: 'vendor/model:free' }] }],
    ['a non-zero price', { openRouter: { enabled: true, verified: { 'vendor/model:free': { verifiedAt: '2026-10-20', inputPrice: 0.0001, outputPrice: 0, privacyApproved: true, tools: true } } },
      main: [{ provider: 'openrouter', id: 'vendor/model:free' }] }],
    ['a paid OpenRouter model even if listed', { openRouter: { enabled: true, verified: { 'vendor/paid': { verifiedAt: '2026-10-20', inputPrice: 0, outputPrice: 0, privacyApproved: true, tools: true } } },
      main: [{ provider: 'openrouter', id: 'vendor/paid' }] }],
    ['an unknown config key', { fallbackToPaid: true }],
  ])('rejects %s before any request', (_label, config) => {
    expect(() => buildModelPolicy(config)).toThrow(ModelPolicyError);
  });

  it('a verified :free OpenRouter model denies data collection, caps prices at zero and allows no fallback model', async () => {
    const verified = { verifiedAt: '2026-10-20', inputPrice: 0, outputPrice: 0, privacyApproved: true, tools: true };
    const openPolicy = buildModelPolicy({ openRouter: { enabled: true, verified: { 'vendor/model:free': verified } },
      main: [{ provider: 'openrouter', id: 'vendor/model:free' }] });
    const model = fakeModel(() => llmResponse({ content: 'ok' }));
    await complete(openPolicy.main, input, deps(model.fetchImpl, { policy: openPolicy, keys: { OPENROUTER_API_KEY: 'synthetic' } }));
    expect(new URL(model.urls[0]).hostname).toBe('openrouter.ai');
    expect(model.bodies[0]).toMatchObject({ model: 'vendor/model:free', provider: { data_collection: 'deny', allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } } });
    expect(model.bodies[0].models).toBeUndefined();
  });

  it('never sends a model outside the policy, even when the chain names one', async () => {
    const model = fakeModel(() => llmResponse({ content: 'ok' }));
    await expect(complete([{ provider: 'groq', id: 'paid-model' }], input, deps(model.fetchImpl))).rejects.toBeInstanceOf(AllModelsFailed);
    await expect(complete([{ provider: 'openrouter', id: 'vendor/model:free' }], input, deps(model.fetchImpl))).rejects.toBeInstanceOf(AllModelsFailed);
    expect(model.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('complete', () => {
  it('falls back from a 429 on the main model to the backup without waiting', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-23T12:00:00Z'));
    const model = fakeModel(body => body.model === 'openai/gpt-oss-120b' ? rateLimited({ 'retry-after': '30' }) : llmResponse({ content: 'Záloha odpověděla.' }));
    const started = Date.now();
    const result = await complete(policy.main, input, deps(model.fetchImpl, { now: Date.now }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ fellBack: true, model: { id: 'qwen/qwen3.8-27b' }, message: { role: 'assistant', content: 'Záloha odpověděla.' } });
    expect(model.bodies.map(b => b.model)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(model.urls.every(u => new URL(u).hostname === 'api.groq.com')).toBe(true);
  });

  it.each([
    ['an empty message', llmResponse({ content: '' })],
    ['HTTP 200 carrying an error', new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 200 })],
    ['a server error', new Response('busy', { status: 503 })],
    ['malformed JSON', new Response('{', { status: 200 })],
  ])('moves on after %s', async (_label, first) => {
    const model = fakeModel((_b, call) => call === 0 ? first : llmResponse({ content: 'ok' }));
    expect(await complete(policy.main, input, deps(model.fetchImpl))).toMatchObject({ fellBack: true, model: { id: 'qwen/qwen3.8-27b' } });
  });

  it('sends reasoning_effort only to models that support it', async () => {
    const model = fakeModel(body => body.model === 'openai/gpt-oss-120b' ? llmResponse({ content: '' }) : llmResponse({ content: 'ok' }));
    await complete(policy.main, input, deps(model.fetchImpl));
    expect(model.bodies[0].reasoning_effort).toBe('low');
    expect('reasoning_effort' in model.bodies[1]).toBe(false);
  });

  it('reports a quota error with the earliest truthful reset time, or null when no model says', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-23T12:00:00Z'));
    const timed = fakeModel(body => rateLimited(body.model === 'openai/gpt-oss-120b' ? { 'retry-after': '90' } : { 'x-ratelimit-reset-tokens': '1m2.5s' }));
    const error = await complete(policy.main, input, deps(timed.fetchImpl, { now: Date.now })).catch(e => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error.retryAt).toBe('2026-10-23T12:01:02.500Z');
    const untimed = fakeModel(() => rateLimited());
    const unknown = await complete(policy.main, input, deps(untimed.fetchImpl)).catch(e => e);
    expect(unknown).toBeInstanceOf(QuotaError);
    expect(unknown.retryAt).toBeNull();
  });

  it('reserves tokens before every attempt; a rate-limited attempt costs nothing, an unknown usage costs the whole reservation', async () => {
    const tokens = createTokenBudget();
    const model = fakeModel((_b, call) => call === 0 ? rateLimited() : call === 1 ? new Response('busy', { status: 500 }) : llmResponse({ content: 'ok', usage: { input: 200, output: 50 } }));
    const chain = [...policy.main, { provider: 'groq' as const, id: 'openai/gpt-oss-20b', reasoningEffort: 'low' as const }];
    const result = await complete(chain, input, deps(model.fetchImpl, { tokens }));
    expect(result.usage).toEqual({ input: 200, output: 50 });
    const estimate = estimateInputTokens(messages, []);
    // 429: zero; 500: whole reservation (estimate + max output); success: reported usage.
    expect(tokens.spent).toBe(estimate + model.bodies[1].max_completion_tokens + 250);
    expect(tokens.reserved).toBe(0);
    for (const body of model.bodies) expect(estimate + body.max_completion_tokens).toBeLessThanOrEqual(CALL_TOKEN_LIMIT);
  });

  it('refuses a call that cannot fit the per-call or per-question budget before any request', async () => {
    const tokens = createTokenBudget();
    tokens.settle(tokens.reserve(2900, 0), null);
    tokens.settle(tokens.reserve(2900, 0), null);
    tokens.settle(tokens.reserve(2150, 0), null);
    const model = fakeModel(() => llmResponse({ content: 'ok' }));
    await expect(complete(policy.main, input, deps(model.fetchImpl, { tokens }))).rejects.toMatchObject({ code: 'budget' });
    const huge: LlmMessage[] = [{ role: 'user', content: 'x'.repeat(8000) }];
    await expect(complete(policy.main, { ...input, messages: huge }, deps(model.fetchImpl))).rejects.toMatchObject({ code: 'budget' });
    expect(model.fetchImpl).not.toHaveBeenCalled();
  });

  it('times out a hanging model after 20 s, aborts its fetch and keeps the reservation', async () => {
    vi.useFakeTimers();
    const tokens = createTokenBudget();
    const hang = hangingFetch();
    const pending = complete([policy.main[0]], input, deps(hang.fetchImpl, { tokens })).catch(e => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await pending;
    expect(error).toBeInstanceOf(AllModelsFailed);
    expect(error.code).toBe('timeout');
    expect(hang.signals[0].aborted).toBe(true);
    expect(tokens.spent).toBeGreaterThan(0);
    expect(tokens.reserved).toBe(0);
  });

  it('a cancelled request aborts the in-flight call and tries no other model', async () => {
    const controller = new AbortController();
    const hang = hangingFetch();
    const pending = complete(policy.main, input, deps(hang.fetchImpl, { budget: budgetFor(45_000, controller.signal) })).catch(e => e);
    await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    const error = await pending;
    expect(error).not.toBeInstanceOf(AllModelsFailed);
    expect(hang.signals[0].aborted).toBe(true);
    expect(hang.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips a model without a configured key without a request', async () => {
    const model = fakeModel(() => llmResponse({ content: 'ok' }));
    await expect(complete(policy.main, input, deps(model.fetchImpl, { keys: {} }))).rejects.toMatchObject({ code: 'config' });
    expect(model.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns tool calls with their arguments as sent', async () => {
    const model = fakeModel(() => llmResponse({ toolCalls: [{ name: 'get_quote', arguments: { ticker: 'SYNA' } }] }));
    const result = await complete(policy.main, input, deps(model.fetchImpl));
    expect(result.message.toolCalls).toEqual([{ id: 'call_0', name: 'get_quote', arguments: '{"ticker":"SYNA"}' }]);
  });
});

describe('token budget', () => {
  it('allows at most 3,000 tokens per attempt and 8,000 per question', () => {
    const tokens = createTokenBudget();
    expect(QUESTION_TOKEN_LIMIT).toBe(8000);
    expect(() => tokens.reserve(2600, 401)).toThrow();
    const a = tokens.reserve(2000, 1000);
    expect(tokens.reserved).toBe(3000);
    tokens.settle(a, { input: 1800, output: 300 });
    expect(tokens).toMatchObject({ spent: 2100, reserved: 0 });
    tokens.settle(tokens.reserve(2000, 1000), null);
    expect(tokens.spent).toBe(5100);
    expect(() => tokens.reserve(2000, 1000)).toThrow();
    expect(() => tokens.reserve(2000, 900)).not.toThrow();
  });

  it('the input estimate covers the whole serialized request and is not a characters/4 guess', () => {
    const ascii = estimateInputTokens([{ role: 'user', content: 'a'.repeat(400) }], []);
    const czech = estimateInputTokens([{ role: 'user', content: 'ř'.repeat(400) }], []);
    expect(ascii).toBeGreaterThan(100);
    // Two UTF-8 bytes per Czech letter: the estimate grows with bytes, not characters.
    expect(czech - ascii).toBeGreaterThanOrEqual(400);
    expect(ascii).toBeGreaterThanOrEqual(400);
    expect(czech).toBeGreaterThanOrEqual(800);
    const withTools = estimateInputTokens([{ role: 'user', content: 'a'.repeat(400) }],
      [{ name: 'get_quote', description: 'Latest price', inputSchema: { type: 'object', properties: { ticker: { type: 'string' } } }, outputSchema: {}, group: 'trh' }]);
    expect(withTools).toBeGreaterThan(ascii + 20);
  });
});

describe('short rate-limit waits', () => {
  // A fake clock: `sleep` advances it, so the wait is visible in the request budget without real time passing.
  const clocked = (budgetMs = 45_000) => {
    const clock = { t: Date.parse('2026-10-23T12:00:00Z'), sleeps: [] as number[] };
    const now = () => clock.t;
    const sleep = vi.fn(async (ms: number) => { clock.sleeps.push(ms); clock.t += ms; });
    return { clock, now, sleep, budget: budgetFor(budgetMs, new AbortController().signal, now) };
  };

  it('waits a 3 s reset once and retries the same model, counting the wait in the budget', async () => {
    const c = clocked();
    const model = fakeModel((_b, call) => call === 0 ? rateLimited({ 'retry-after': '3' }) : llmResponse({ content: 'Po čekání.' }));
    const result = await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget }));
    expect(result).toMatchObject({ fellBack: false, model: { id: 'openai/gpt-oss-120b' }, message: { content: 'Po čekání.' } });
    expect(model.bodies.map(b => b.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    expect(c.clock.sleeps).toEqual([3000]);
    expect(c.budget.remainingMs()).toBe(42_000);
  });

  it.each([
    ['6.5s', 'x-ratelimit-reset-tokens', '2.5s', 2500],
    ['1m2.3s', 'x-ratelimit-reset-requests', '1.25s', 1250],
  ])('parses Groq durations (%s style) from the reset headers', async (_label, header, value, expected) => {
    const c = clocked();
    const model = fakeModel((_b, call) => call === 0 ? rateLimited({ [header]: value }) : llmResponse({ content: 'ok' }));
    await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget }));
    expect(c.clock.sleeps).toEqual([expected]);
  });

  it.each([
    ['retry-after 30 s', { 'retry-after': '30' }],
    ['a 6.5 s token reset', { 'x-ratelimit-reset-tokens': '6.5s' }],
    ['a 1m2.3s request reset', { 'x-ratelimit-reset-requests': '1m2.3s' }],
    ['no reset at all', {}],
  ])('fails over immediately on %s', async (_label, headers) => {
    const c = clocked();
    const model = fakeModel(body => body.model === 'openai/gpt-oss-120b' ? rateLimited(headers) : llmResponse({ content: 'Záloha.' }));
    const result = await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget }));
    expect(result).toMatchObject({ fellBack: true, model: { id: 'qwen/qwen3.8-27b' } });
    expect(model.bodies.map(b => b.model)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it('ignores the reset of a limit that is not exhausted', async () => {
    const c = clocked();
    const model = fakeModel((_b, call) => call === 0 ? rateLimited({ 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-remaining-requests': '14370',
      'x-ratelimit-reset-tokens': '4s', 'x-ratelimit-remaining-tokens': '0' }) : llmResponse({ content: 'ok' }));
    await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget }));
    expect(c.clock.sleeps).toEqual([4000]);
  });

  it('fails over immediately when the budget cannot hold the wait plus a full model call', async () => {
    const c = clocked(22_999); // 3 s wait + 20 s call > 22.999 s left
    const model = fakeModel(body => body.model === 'openai/gpt-oss-120b' ? rateLimited({ 'retry-after': '3' }) : llmResponse({ content: 'Záloha.' }));
    const result = await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget }));
    expect(result).toMatchObject({ fellBack: true, model: { id: 'qwen/qwen3.8-27b' } });
    expect(c.sleep).not.toHaveBeenCalled();
    const exact = clocked(23_000);
    const again = fakeModel((_b, call) => call === 0 ? rateLimited({ 'retry-after': '3' }) : llmResponse({ content: 'ok' }));
    expect(await complete(policy.main, input, deps(again.fetchImpl, { now: exact.now, sleep: exact.sleep, budget: exact.budget })))
      .toMatchObject({ fellBack: false });
  });

  it('never waits more than once per model per request', async () => {
    const c = clocked();
    const tokens = createTokenBudget();
    const model = fakeModel(() => rateLimited({ 'retry-after': '1' }));
    const first = await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget, tokens })).catch(e => e);
    expect(first).toBeInstanceOf(QuotaError);
    expect(model.bodies.map(b => b.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'qwen/qwen3.8-27b']);
    expect(c.clock.sleeps).toEqual([1000, 1000]);
    // A later call of the same request (repair, next round) shares the ledger: no further waits.
    const second = await complete(policy.main, input, deps(model.fetchImpl, { now: c.now, sleep: c.sleep, budget: c.budget, tokens })).catch(e => e);
    expect(second).toBeInstanceOf(QuotaError);
    expect(model.bodies).toHaveLength(6);
    expect(c.clock.sleeps).toEqual([1000, 1000]);
    expect(tokens.spent).toBe(0);
  });

  it('stops waiting when the request is cancelled', async () => {
    const controller = new AbortController();
    const model = fakeModel(() => rateLimited({ 'retry-after': '2' }));
    const pending = complete(policy.main, input, deps(model.fetchImpl, { budget: budgetFor(45_000, controller.signal) }));
    setTimeout(() => controller.abort(new DOMException('Cancelled', 'AbortError')), 20);
    const started = Date.now();
    const error = await pending.catch(e => e);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(model.bodies).toHaveLength(1);
  });
});
