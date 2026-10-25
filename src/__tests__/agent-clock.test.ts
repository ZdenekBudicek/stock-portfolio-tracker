// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { fixtureRepo, fixtureMarket } from '../../supabase/functions/agent/core/fixture.ts';
import { makeHandler } from '../../supabase/functions/agent/handler.ts';
import { createChatService } from '../../supabase/functions/agent/service.ts';
import { readWithinDeadline } from '../../supabase/functions/agent/live/paging.ts';
import { marketOperation } from '../../supabase/functions/agent/live/marketFetch.ts';
import { createMemoryAgentStore } from '../test/agentMemoryDb';
import { chatRequest, fakeModel, isRouter, llmDeps, llmResponse, routeReply } from '../test/agentLlmFixture';

afterEach(() => vi.useRealTimers());

// The request budget and the DB/market read deadlines compare absolute times. They must use the
// same clock: performance.now() (process-relative) against Date.now() (epoch) made every live
// read time out at once – caught only by the real-DB HTTP integration run.
describe('agent clocks', () => {
  for (const file of ['supabase/functions/agent/index.ts', 'scripts/agent-local.ts', 'scripts/agent-test-edge.ts']) {
    it(`${file} drives the request budget with Date.now`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/now:\s*\(\)\s*=>\s*performance\.now\(\)/);
      expect(src).toMatch(/now:\s*(\(\)\s*=>\s*Date\.now\(\)|Date\.now)/);
    });
  }

  it('shares epoch deadlines through auth, router, market, DB and terminal persistence', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-23T12:00:00Z');
    vi.setSystemTime(start);
    const user = { id: 'synthetic-user', jwt: 'synthetic-jwt' };
    const inner = createMemoryAgentStore().forUser(user.id), repo = fixtureRepo('A'), market = fixtureMarket();
    const deadlines: Record<string, number[]> = {};
    const record = (name: string, deadline: number) => { (deadlines[name] ??= []).push(deadline); };
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio' }) : llmResponse({ content: '{}' }));
    const llm = llmDeps(model.fetchImpl), complete = llm.complete;
    llm.complete = (models, input, deps) => {
      record(models === llm.policy.router ? 'router' : 'writer', deps.budget.deadline);
      expect(deps.budget.remainingMs()).toBeGreaterThan(0);
      return complete(models, input, deps);
    };
    const service = createChatService({ lib, llm,
      db: { ...inner,
        begin: (input, ctx) => { record('begin', ctx.deadline); return readWithinDeadline(() => inner.begin(input, ctx), ctx); },
        complete: (input, ctx) => { record('persist', ctx.deadline); return readWithinDeadline(() => inner.complete(input, ctx), ctx); } },
      repo: { ...repo, load: ctx => { record('repo', ctx.deadline); return readWithinDeadline(() => repo.load(ctx), ctx); } },
      market: { ...market, quote: (ticker, ctx) => marketOperation(ctx, Date.now, read => {
        record('market', read.deadline); return market.quote(ticker, read);
      }) },
    });
    const handler = makeHandler({ now: Date.now, allowedOrigins: [], chat: service,
      authenticate: async () => { vi.setSystemTime(start + 2000); return user; } });
    const response = await handler(new Request('http://localhost/agent/chat', { method: 'POST', body: JSON.stringify(chatRequest('Kolik mám v portfoliu?')) }));
    const body = await response.text();
    expect(body).toContain('"persisted":true');
    expect(deadlines.begin).toEqual([start + 42_000]);
    expect(deadlines.router).toEqual([start + 8000]);
    expect(deadlines.writer.every(d => d === start + 42_000)).toBe(true);
    expect(deadlines.repo).toEqual([start + 45_000]);
    expect(deadlines.market.length).toBeGreaterThan(0);
    expect(deadlines.market.every(d => d === start + 10_000)).toBe(true);
    expect(deadlines.persist).toEqual([start + 45_000]);
    vi.setSystemTime(start + 45_000);
    const work = vi.fn(async () => true);
    await expect(readWithinDeadline(work, { deadline: start + 45_000, signal: new AbortController().signal })).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(marketOperation({ deadline: start + 45_000, signal: new AbortController().signal }, Date.now, work)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(work).not.toHaveBeenCalled();
  });
});
