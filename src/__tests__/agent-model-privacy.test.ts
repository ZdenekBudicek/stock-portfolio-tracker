// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runChat } from '../../supabase/functions/agent/core/agent.ts';
import { fixtureSnapshot, snapshotRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { toolResultText } from '../../supabase/functions/agent/core/prompts.ts';
import { executeTool, projectForModel } from '../../supabase/functions/agent/core/registry.ts';
import { modelMessages } from '../../supabase/functions/agent/core/modelPrivacy.ts';
import { chatCtx, chatRequest, collect, fakeModel, history, isRouter, llmDeps, llmResponse, routeReply } from '../test/agentLlmFixture';
import { ok, toolCtx, toolPeriod } from '../test/agentToolsFixture';

describe('model account privacy', () => {
  it.each([
    ['simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150 }],
    ['get_transactions', { ...toolPeriod, scope: { broker: 'unknown', account: 'unknown' } }],
  ])('%s keeps account choices structured and out of model prose', async (name, args) => {
    const result = await executeTool(name as string, args, toolCtx());
    expect(result).toMatchObject({ ok: false, error: { code: 'clarify', choices: expect.any(Array) } });
    const projected = projectForModel(name as string, result);
    expect(JSON.stringify(projected)).not.toMatch(/SYNTHETIC|A1|A2/i);
    expect(toolResultText(result, 'en')).not.toMatch(/SYNTHETIC|A1|A2/i);
    expect(JSON.stringify(projected)).toContain('choice_1');
  });

  it('never forwards arbitrary error or warning details, even when they look like codes', async () => {
    const result = ok(await executeTool('get_portfolio_summary', {}, toolCtx()));
    result.meta.warnings = ['missing_fx:2026:2', 'tax:{"account":"secret-account"}', 'secret_account', 'quote_missing:secret-account'];
    for (const text of [JSON.stringify(projectForModel('get_portfolio_summary', result)), toolResultText(result, 'en')]) {
      expect(text).not.toMatch(/secret.account/);
      expect(text).toContain('missing_fx');
      expect(text).toContain('warning');
    }
    const error = { ok: false as const, error: { code: 'invalid' as const, message: 'secret-account' } };
    expect(JSON.stringify(projectForModel('simulate_sale', error))).not.toContain('secret-account');
    expect(toolResultText(error, 'en')).not.toContain('secret-account');
  });

  it('sanitizes warning details nested in otherwise successful tool data', async () => {
    const result = ok(await executeTool('get_portfolio_summary', {}, toolCtx()));
    result.data = { report: { warnings: [{ code: 'missing_fx', message: 'secret-account', account: 'secret-account' }] } };
    expect(JSON.stringify(projectForModel('get_tax_report', result))).not.toContain('secret-account');
  });

  it('redacts JSON-escaped account identifiers in model tool-call echoes', async () => {
    const snapshot = fixtureSnapshot('A'), account = 'synthetic-"account\\with-slash';
    snapshot.transactions[0].broker_account = account;
    const project = await modelMessages(chatCtx({ repo: snapshotRepo(snapshot, 'privacy') }));
    const [message] = project([{ role: 'assistant', content: null,
      toolCalls: [{ id: 'call_1', name: 'simulate_sale', arguments: JSON.stringify({ account }) }] }]);
    expect(JSON.parse(message.toolCalls![0].arguments).account).toBe('[private]');
  });

  it('redacts current questions, both history roles and subsequent tool turns in actual router/writer payloads', async () => {
    const snapshot = fixtureSnapshot('A');
    for (const row of snapshot.transactions) {
      if (row.broker_account) row.broker_account = `private-${row.broker_account}`;
    }
    const model = fakeModel((body, call) => isRouter(body) ? routeReply({ group: 'dane', tickers: ['SYNA'] })
      : call === 1 ? llmResponse({ toolCalls: [{ name: 'simulate_sale', arguments: { ticker: 'SYNA', shares: 1, priceUsd: 150 } }] })
      : llmResponse({ content: '{}' }));
    const messages = history([['My account is private-A1', 'Which account: private-A1 or private-A2?']]);
    await collect(runChat({ request: chatRequest('What about SYNA in private-A1?'), history: messages },
      { ctx: chatCtx({ repo: snapshotRepo(snapshot, 'privacy') }), llm: llmDeps(model.fetchImpl) }));
    expect(model.bodies.some(isRouter)).toBe(true);
    expect(model.bodies.some(b => b.messages.some(m => m.role === 'tool'))).toBe(true);
    expect(JSON.stringify(model.bodies)).not.toMatch(/private-A1|private-A2|SYNTHETIC/i);
    expect(messages[0].content).toContain('private-A1');
  });

  it('redacts before history truncation and omits legacy account selections absent from the current ledger', async () => {
    const snapshot = fixtureSnapshot('A');
    snapshot.transactions[0].broker_account = 'identifier-at-cutoff-private';
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio' }) : llmResponse({ content: '{}' }));
    await collect(runChat({ request: chatRequest('How much is my portfolio?'), history: history([
      ['x'.repeat(1495) + 'identifier-at-cutoff-private', 'Which account sells SYNA? OLD_BROKER / removed-private-account'],
    ]) }, { ctx: chatCtx({ repo: snapshotRepo(snapshot, 'privacy') }), llm: llmDeps(model.fetchImpl) }));
    const payload = JSON.stringify(model.bodies);
    expect(payload).not.toContain('x'.repeat(20) + 'ident');
    expect(payload).not.toContain('removed-private-account');
    expect(payload).not.toContain('OLD_BROKER');
  });

  it('does not revive an omitted historical account ID as an inherited ticker', async () => {
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio' }) : llmResponse({ content: '{}' }));
    await collect(runChat({ request: chatRequest('How much is my portfolio?'), history: history([['Account ZX9875', 'Selected.']]) },
      { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) }));
    expect(JSON.stringify(model.bodies)).not.toContain('ZX9875');
  });
});
