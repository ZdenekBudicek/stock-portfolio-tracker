import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import type { RequestBudget } from '../../supabase/functions/agent/core/budget.ts';
import { createToolContext } from '../../supabase/functions/agent/core/context.ts';
import { FIXTURE_TODAY, fixtureMarket, fixtureRepo, type FixtureUser } from '../../supabase/functions/agent/core/fixture.ts';
import type { ViewPreferences } from '../../supabase/functions/agent/core/protocol.ts';
import type { Fact, ResultMeta, ToolCtx, ToolResult } from '../../supabase/functions/agent/core/types.ts';

export const toolPreferences: ViewPreferences = { displayCurrency: 'USD', localCurrency: 'CZK',
  tax: { fxMethod: 'cnb-daily', limitIncludesExempt: true } };
export const toolPeriod = { from: '2026-01-01', to: FIXTURE_TODAY };

export function testBudget(ms = 45_000, signal = new AbortController().signal): RequestBudget {
  const startedAt = Date.now(), deadline = startedAt + ms;
  return { startedAt, deadline, signal, remainingMs: () => Math.max(0, deadline - Date.now()) };
}

export function toolCtx(user: FixtureUser = 'A', over: Partial<Omit<ToolCtx, 'facts' | 'calculations' | 'loadSnapshot'>> = {}): ToolCtx {
  return createToolContext({ repo: fixtureRepo(user), market: fixtureMarket(), lib, budget: testBudget(), today: FIXTURE_TODAY,
    lang: 'cs', preferences: toolPreferences, ...over });
}

// executeTool is untyped by name; tests read its data loosely and the schemas check the shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose<T> = unknown extends T ? any : T;
export function ok<T>(result: ToolResult<T>): { ok: true; data: Loose<T>; facts: Fact[]; meta: ResultMeta } {
  if (result.ok === false) {
    const { error } = result as Extract<ToolResult<T>, { ok: false }>;
    throw new Error(`Expected ok, got ${error.code}: ${error.message}`);
  }
  return result as { ok: true; data: Loose<T>; facts: Fact[]; meta: ResultMeta };
}
export const errorOf = (result: { ok: boolean }) => (result as { error?: { code: string; message: string } }).error;

export function factOf(result: { facts: Fact[] }, id: string): Fact | undefined {
  return result.facts.find(f => f.id === id || f.id.startsWith(`${id}#`));
}

/** A repository wrapper that counts reads, to prove request-local memoization. */
export function countingRepo(user: 'A' | 'B' = 'A') {
  const inner = fixtureRepo(user);
  const calls = { load: 0, loadHistory: 0 };
  return { calls, repo: { load: (ctx: Parameters<typeof inner.load>[0]) => { calls.load++; return inner.load(ctx); },
    loadHistory: (ctx: Parameters<typeof inner.loadHistory>[0]) => { calls.loadHistory++; return inner.loadHistory(ctx); } } };
}
