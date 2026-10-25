// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../../supabase/functions/agent/core/agent.ts';
import { runsOf } from '../../supabase/functions/agent/core/context.ts';
import { keywordIntent, routeQuestion } from '../../supabase/functions/agent/core/router.ts';
import { executeTool, projectForModel } from '../../supabase/functions/agent/core/registry.ts';
import { buildVerifiedTemplate, factLabel } from '../../supabase/functions/agent/core/answerTemplate.ts';
import { intentEvidence, planIntent } from '../../supabase/functions/agent/core/intentContract.ts';
import { expandDraft, validateAnswer } from '../../supabase/functions/agent/core/grounding.ts';
import { heuristicRoute } from '../../supabase/functions/agent/core/router.ts';
import { fixtureSnapshot, snapshotRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { selectAccount, selectedAccount } from '../../supabase/functions/agent/core/accountChoices.ts';
import { validateToolCall } from '../../supabase/functions/agent/core/guards.ts';
import { history } from '../test/agentLlmFixture';
import { chatCtx, chatRequest, fakeModel, isRouter, llmDeps, llmResponse, rateLimited, routeReply, shownFactIds, TECHNICAL } from '../test/agentLlmFixture';
import { ok, toolCtx } from '../test/agentToolsFixture';

const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');
async function ask(question: string, select: 'one' | 'all' = 'one') {
  const ctx = chatCtx();
  const model = fakeModel(body => {
    if (isRouter(body)) return routeReply({ group: 'trh', analysis: false });
    const ids = shownFactIds(body).filter(id => select === 'all' || /:(count|price)$/.test(id)).slice(0, select === 'all' ? 100 : 1);
    return llmResponse({ content: JSON.stringify({ lang: 'cs', blocks: [{ kind: 'facts',
      text: ids.map((_, i) => `{{v${i}}}`).join(' '), claims: Object.fromEntries(ids.map((id, i) => [`v${i}`, { factId: id }])), sourceIds: [] }] }) });
  });
  const result = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) });
  return { ...result, text: plain(result.answer?.text ?? ''), ctx, bodies: model.bodies };
}

describe('I4 explicit intents in cs/sk/en, including negations', () => {
  it.each([
    ['Jaký zisk jsem letos realizoval?', 'realized'], ['Aký zisk som tento rok realizoval?', 'realized'], ['What gains have I realised this year?', 'realized'],
    ['Kolik daně bych zaplatil, kdybych teď prodal 1 kus SYNB za 210 USD?', 'simulation'],
    ['Aká by bola daň, keby som predal 1 kus SYNB za 210 USD?', 'simulation'], ['What tax if I sold 1 share of SYNB at 210 USD?', 'simulation'],
    ['Které moje akcie už splňují tříletý časový test?', 'lots'], ['Ktoré akcie ešte nespĺňajú časový test?', 'lots'], ['Which lots are not tax exempt yet?', 'lots'],
    ['Kolik by mě stál prodej všech SYNA z jednoho účtu?', 'account_clarification'],
    ['Nechci koupit SYNA, chci vědět realizovaný zisk.', 'realized'], ['Nechcem kúpiť SYNA, ukáž realizované zisky.', 'realized'],
    ['Do not simulate a sale; show realised gains.', 'realized'], ['Nechci simulaci prodeje, ukaž transakce.', 'transactions'],
    ['Nechcem simuláciu predaja, ukáž transakcie.', 'transactions'], ['What unrealized profit do I have?', undefined],
    ['Jaký mám nerealizovaný zisk?', undefined], ['Aký mám nerealizovaný zisk?', undefined],
    ['Neprodal jsem letos SYNA?', 'transactions'], ['Did I not sell SYNA this year?', 'transactions'],
    ['Jaké mám nákupní loty?', 'lots'], ['Aké mám nákupné loty?', 'lots'], ['How much did I realize this year?', 'realized'],
    ['Kolik daně zaplatím při prodeji 1 kusu SYNB za 210 USD?', 'simulation'],
  ])('%s', (question, intent) => expect(keywordIntent(question)).toBe(intent));

  it('does not let the model replace explicit evidence with a market route', async () => {
    const model = fakeModel(() => routeReply({ group: 'trh', tickers: ['WRONG'], analysis: true }));
    expect(await routeQuestion('Jaký zisk jsem letos realizoval?', [], chatCtx(), llmDeps(model.fetchImpl)))
      .toMatchObject({ group: 'dane', intent: 'realized', analysis: false, tickers: [] });
  });
  it('restricts model tools to the explicit intent and never lets the model choose an account', () => {
    const simulation = heuristicRoute('What tax if I sold 1 share of SYNA at 150 USD?', [], chatCtx(), 'en');
    expect(validateToolCall('get_tax_report', { year: 2026 }, simulation)).toBe(false);
    expect(validateToolCall('simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150, accountChoice: 'choice_1' }, simulation)).toBe(false);
    expect(validateToolCall('simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150 }, simulation)).toBe(true);
    const transactions = heuristicRoute('What did I sell this year?', [], chatCtx(), 'en');
    expect(validateToolCall('get_portfolio_summary', {}, transactions)).toBe(false);
  });
  it.each(['Jaký mám nerealizovaný zisk?', 'Aký mám nerealizovaný zisk?', 'What unrealized profit do I have?'])('never routes unrealized to realised tax evidence: %s', question => {
    expect(heuristicRoute(question, [], chatCtx(), 'cs').group).toBe('portfolio');
  });
  it.each(['Nechci koupit SYNA.', 'Nechcem kúpiť SYNA.', 'Do not buy SYNA.'])('does not restore a negated buy from the model: %s', async question => {
    const model = fakeModel(() => routeReply({ group: 'valuace', tickers: ['SYNA'], analysis: true }));
    expect((await routeQuestion(question, [], chatCtx(), llmDeps(model.fetchImpl))).analysis).toBe(false);
  });
});

describe('five failing live-eval regressions', () => {
  it('tx-cs-1 repairs incomplete selections and templates every bought AND sold datum', async () => {
    const r = await ask('Kolik jsem letos nakoupil a prodal?');
    expect(r.metrics.toolsUsed).toContain('get_transactions');
    for (const label of ['celkem 1 obchod', 'nic nenakoupil', 'prodal 2 kusy za 300,00 USD']) expect(r.text).toContain(label);
    expect(r.bodies.some(b => b.messages.some(m => m.content?.includes('intent_incomplete')))).toBe(true);
    expect(r.outcome).toBe('fallback');
  });
  it('realized-cs-1 loads and answers realised net, gains and losses', async () => {
    const r = await ask('Jaký zisk jsem letos realizoval?');
    expect(r.metrics.toolsUsed).toContain('get_realized_pnl');
    for (const label of ['realizoval zisk 1 506,95 Kč', 'Tržby z prodejů byly 6 221,10 Kč', 'žádné ztráty jsi neměl']) expect(r.text).toContain(label);
    expect(r.text).not.toContain('cena SYNA');
  });
  it('sim-cs-1 simulates the supplied sale, never substitutes the annual tax report', async () => {
    const r = await ask('Kolik daně bych zaplatil, kdybych teď prodal 1 kus SYNB za 210 USD?');
    expect(r.metrics.toolsUsed).toContain('simulate_sale');
    expect(r.metrics.toolsUsed).not.toContain('get_tax_report');
    expect(r.text).toMatch(/prodal 1 kus SYNB/);
    expect(r.text).toMatch(/Zisk z prodeje by byl/);
    expect(r.text).toMatch(/daň navíc/);
    expect(r.text).toMatch(/210,00 USD/);
  });
  it('time-test-cs-1 supplies ticker, acquisition, exemption date and status per lot', async () => {
    const r = await ask('Které moje akcie už splňují tříletý časový test?');
    expect(r.metrics.toolsUsed).toContain('get_tax_lots');
    expect(r.text).toMatch(/SYNA/);
    expect(r.text).toMatch(/osvobození od/);
    expect(r.text).toMatch(/SYNA \(lot 1\): 4 kusy, .*časový test (zatím ne)?splněn/);
    expect(r.text).not.toMatch(TECHNICAL);
  });
  it('ambiguous-account-cs-1 asks for the account without unrelated prices', async () => {
    const r = await ask('Kolik by mě stál prodej všech SYNA z jednoho účtu?');
    expect(r.text).toMatch(/úč(?:et|tu)/);
    expect(r.text).toContain('A1');
    expect(r.text).toContain('A2');
    expect(r.text).not.toMatch(/1[ ,]?500|USD|choice_/);
    expect(JSON.stringify(r.bodies)).not.toMatch(/SYNTHETIC|A1|A2/);
    expect(runsOf(r.ctx).some(r => r.name === 'simulate_sale' && r.result.ok)).toBe(false);
  });
  it('accepts a complete selection without forcing a fallback', async () => {
    const r = await ask('Kolik jsem letos nakoupil a prodal?', 'all');
    expect(r.outcome).toBe('ok');
    expect(r.text).toContain('celkem 1 obchod');
  });
});

describe('lot evidence and account selection', () => {
  it('projects per-lot facts with no underlying account or buy identifiers', async () => {
    const result = ok(await executeTool('get_tax_lots', {}, toolCtx()));
    const projected = projectForModel('get_tax_lots', result);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.facts.some(f => f.ticker === 'SYNA' && f.metric?.endsWith(':exempt_date') && f.unit === 'date')).toBe(true);
    expect(projected.facts.some(f => f.ticker === 'SYNA' && f.metric?.endsWith(':exempt') && f.unit === 'boolean')).toBe(true);
    expect(JSON.stringify(projected)).not.toMatch(/SYNTHETIC|A1|A2|buyId|buyTxId/);
  });
  it('selects only the account explicitly named in the current question', async () => {
    const r = await ask('Kolik daně bych zaplatil, kdybych prodal 1 kus SYNA za 150 USD z účtu A2?');
    const sale = runsOf(r.ctx).find(r => r.name === 'simulate_sale');
    expect(sale?.result.ok).toBe(true);
    expect(sale?.args).toMatchObject({ accountChoice: expect.stringMatching(/^choice_/) });
    expect(JSON.stringify(r.bodies)).not.toMatch(/SYNTHETIC|A1|A2/);
  });
  it('does not reuse a request-local choice in a fresh request', async () => {
    const result = await executeTool('simulate_sale', { ticker: 'SYNA', shares: 1, priceUsd: 150, accountChoice: 'choice_1' }, toolCtx());
    expect(result).toMatchObject({ ok: false, error: { code: 'clarify' } });
  });
  it('does not choose a negated account or invent missing simulation inputs', async () => {
    const r = await ask('Kdybych prodal SYNA, ne z účtu A1, kolik zaplatím?');
    expect(r.text).toMatch(/úč(?:et|tu)/);
    expect(runsOf(r.ctx).some(r => r.name === 'simulate_sale' && r.result.ok)).toBe(false);
  });
});

describe('intent boundary cases', () => {
  it.each(['1,5', '1.5'])('preserves decimal sale inputs %s', async quantity => {
    const ctx = chatCtx(), question = `Kdybych prodal ${quantity} kusů SYNB za 210.50 USD?`;
    const plan = await planIntent(heuristicRoute(question, [], ctx, 'cs'), question, ctx);
    expect(plan.calls[0]).toMatchObject({ name: 'simulate_sale', args: { shares: 1.5, priceUsd: 210.5 } });
  });
  it.each(['-1', '0', '1 nebo 2'])('does not turn an invalid or ambiguous quantity %s into a sale', async quantity => {
    const ctx = chatCtx(), question = `Kdybych prodal ${quantity} kusy SYNB za 210 USD?`;
    expect((await planIntent(heuristicRoute(question, [], ctx, 'cs'), question, ctx)).calls).toEqual([]);
  });
  it('does not silently ignore a supplied fee or future sale date', async () => {
    const ctx = chatCtx(), question = 'Kdybych prodal 1 kus SYNB za 210 USD s poplatkem 5 USD dne 2027-01-01?';
    expect((await planIntent(heuristicRoute(question, [], ctx, 'cs'), question, ctx)).calls).toEqual([]);
  });
  it('does not inherit an unrelated instrument for an explicitly portfolio-wide question', () => {
    const ctx = chatCtx();
    expect(heuristicRoute('Jaký zisk jsem letos realizoval?', history([['Jaká je cena SYNA?', 'Cena.']]), ctx, 'cs').tickers).toEqual([]);
  });
  it('does not silently widen two named transaction tickers to the whole portfolio', async () => {
    const ctx = chatCtx(), question = 'Kolik jsem prodal SYNA a SYNB?';
    const plan = await planIntent(heuristicRoute(question, [], ctx, 'cs'), question, ctx);
    expect(plan.calls.map(c => c.args)).toEqual([
      expect.objectContaining({ ticker: 'SYNA' }), expect.objectContaining({ ticker: 'SYNB' }),
    ]);
  });
  it('requires missing metrics, not merely all metrics that happened to be returned', async () => {
    const ctx = toolCtx(), route = heuristicRoute('Kolik jsem letos nakoupil a prodal?', [], ctx, 'cs');
    const result = ok(await executeTool('get_transactions', route.period, ctx));
    result.facts = result.facts.filter(f => !f.id.endsWith(':sell_usd'));
    expect(intentEvidence(route, [result]).missing).toBe(true);
  });
  it('checks completeness independently for every named instrument', async () => {
    const ctx = toolCtx(), route = heuristicRoute('Jaký zisk jsem realizoval na SYNA a SYNB?', [], ctx, 'cs');
    const first = ok(await executeTool('get_realized_pnl', { ...route.period, ticker: 'SYNA', currency: 'CZK' }, ctx));
    const second = ok(await executeTool('get_realized_pnl', { ...route.period, ticker: 'SYNB', currency: 'CZK' }, ctx));
    second.facts = second.facts.filter(f => !f.metric?.endsWith(':gains'));
    expect(intentEvidence(route, [first, second]).missing).toBe(true);
  });
  it('names the instrument in realised and transaction amount labels', async () => {
    const realised = await ask('Jaký zisk jsem realizoval na SYNA a SYNB?');
    expect(realised.text).toContain('jsi na SYNA realizoval zisk 1 506,95 Kč');
    expect(realised.text).toContain('jsi na SYNB nerealizoval žádný zisk ani ztrátu, výsledek je 0,00 Kč');
    const trades = await ask('Kolik jsem prodal SYNA a SYNB?');
    expect(trades.text).toContain('jsi u SYNA nic nenakoupil a prodal 2 kusy za 300,00 USD');
    expect(trades.text).toContain('neudělal žádný obchod se SYNB');
  });
  it('cannot satisfy completeness using an equal amount from another period', async () => {
    const ctx = toolCtx();
    const current = ok(await executeTool('get_transactions', { from: '2026-01-01', to: '2026-10-23' }, ctx));
    const prior = ok(await executeTool('get_transactions', { from: '2025-01-01', to: '2025-12-31' }, ctx));
    const required = current.facts.find(f => f.id.endsWith(':buy_usd'))!;
    const wrong = prior.facts.find(f => f.metric === required.metric)!;
    const draft = expandDraft({ lang: 'cs', blocks: [{ kind: 'facts', text: '{{v}}', claims: { v: { factId: wrong.id } }, sourceIds: [] }] }, ctx.facts);
    expect(validateAnswer(draft, ctx.facts, [], { requiredFactIds: [required.id] })).toMatchObject({ ok: false, reasons: ['intent_incomplete'] });
  });
  it('labels every lot distinctly, with precise dates, and keeps all required facts past eight rows', async () => {
    const ctx = toolCtx(), route = heuristicRoute('Které loty splňují časový test?', [], ctx, 'cs');
    const result = ok(await executeTool('get_tax_lots', {}, ctx));
    const dates = result.facts.filter(f => f.metric?.endsWith(':exempt_date') && f.ticker === 'SYNA');
    expect(dates.map(f => f.value)).toEqual(['2027-03-02', '2027-04-02']);
    expect(new Set(dates.map(f => factLabel(f, 'cs'))).size).toBe(2);
    const text = plain(buildVerifiedTemplate(ctx, route, undefined, intentEvidence(route, [result])).text);
    expect(text).toContain('2. 3. 2027');
    expect(text).toContain('2. 4. 2027');
    expect(text).toContain('3. 6. 2028');
  });
  it('distinguishes foreign missing exemption rules from a zero or a Czech date', async () => {
    const ctx = toolCtx('B'), route = heuristicRoute('Which lots are not tax exempt yet?', [], ctx, 'en');
    const result = await executeTool('get_tax_lots', {}, ctx);
    const text = buildVerifiedTemplate(ctx, route, undefined, intentEvidence(route, [result])).text;
    expect(text).toContain('No time-test exemption date is established');
    expect(text).not.toContain('time test met: yes');
  });
  it('returns complete zero lot counts for an empty account and an explicit limit on a failed read', async () => {
    const snap = fixtureSnapshot('A');
    snap.positions = []; snap.transactions = []; snap.snapshots = [];
    const ctx = toolCtx('A', { repo: snapshotRepo(snap, 'empty-lots') });
    const route = heuristicRoute('Which lots are not tax exempt yet?', [], ctx, 'en');
    const result = await executeTool('get_tax_lots', {}, ctx);
    const evidence = intentEvidence(route, [result]);
    expect(evidence.missing).toBe(false);
    expect(buildVerifiedTemplate(ctx, route, undefined, evidence).text).toMatch(/You have 0 lots/);
    const failed = intentEvidence(route, [{ ok: false, error: { code: 'unavailable', message: 'private' } }]);
    expect(buildVerifiedTemplate(ctx, route, undefined, failed).text).toContain('required figures are unavailable');
  });
  it('binds choices to request and ticker, and requires a broker for duplicate account names', () => {
    const ctx = toolCtx(), choices = [{ id: 'choice_1', broker: 'ONE', account: 'same' }, { id: 'choice_2', broker: 'TWO', account: 'same' }];
    expect(selectAccount(ctx, 'SYNA', choices, 'from account same')).toBeUndefined();
    expect(selectAccount(ctx, 'SYNA', choices, 'from account same at TWO')).toBe('choice_2');
    expect(() => selectedAccount(ctx, 'SYNB', 'choice_2')).toThrow();
    expect(() => selectedAccount(toolCtx(), 'SYNA', 'choice_2')).toThrow();
    expect(selectedAccount(ctx, 'SYNA', 'choice_2').broker).toBe('TWO');
  });
  it('does not ignore an explicitly wrong account even when only one account holds the ticker', async () => {
    const ctx = toolCtx(), question = 'Kdybych prodal 1 kus SYNB za 210 USD z účtu A2?';
    const model = fakeModel(() => routeReply({ group: 'dane' }));
    const plan = await planIntent(await routeQuestion(question, [], ctx, llmDeps(model.fetchImpl)), question, ctx);
    expect(plan.calls).toEqual([]);
    expect(plan.clarification).toContain('A1');
  });
  it('honors the selected account on a transaction question and keeps it out of model payloads', async () => {
    const r = await ask('Kolik jsem letos prodal z účtu A2?');
    const run = runsOf(r.ctx).find(r => r.name === 'get_transactions');
    expect(run?.args).toMatchObject({ scope: { account: 'A2' } });
    expect(r.text).toContain('neudělal žádný obchod. Počítáno jen pro vybraný účet.');
    expect(JSON.stringify(r.bodies)).not.toMatch(/SYNTHETIC|A1|A2/);
  });
  it('asks for an ambiguous transaction account instead of returning all-account totals', async () => {
    const r = await ask('Kolik jsem letos prodal z jednoho účtu?');
    expect(r.text).toContain('A1');
    expect(runsOf(r.ctx).some(r => r.name === 'get_transactions' && r.result.ok)).toBe(false);
  });
  it('projects only complete lot groups and explicitly truncates long lot lists in the answer', async () => {
    const snap = fixtureSnapshot('A'), buy = snap.transactions[0];
    snap.transactions = Array.from({ length: 60 }, (_, i) => ({ ...buy, id: `synthetic-lot-${i}`, ext_id: `synthetic:${i}` }));
    const ctx = toolCtx('A', { repo: snapshotRepo(snap, 'many-lots') });
    const result = ok(await executeTool('get_tax_lots', {}, ctx));
    const projected = projectForModel('get_tax_lots', result);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(6000);
    if (!projected.ok) throw new Error('Expected lot projection');
    const prefixes = new Set(projected.facts.flatMap(f => f.metric?.match(/^lots:lot_\d+/)?.[0] ?? []));
    expect(prefixes.size).toBeGreaterThan(0);
    for (const prefix of prefixes) expect(projected.facts.filter(f => f.metric?.startsWith(`${prefix}:`))).toHaveLength(4);
    const route = heuristicRoute('Which lots are tax exempt?', [], ctx, 'en');
    const text = buildVerifiedTemplate(ctx, route, undefined, intentEvidence(route, [result])).text;
    expect(text).toContain('(lot 50)');
    expect(text).toContain('lot list is truncated');
    expect(text).not.toContain('(lot 51)');
  });
  it.each(['count', 'buy_count', 'sell_count', 'buy_usd', 'sell_usd', 'bought_shares', 'sold_shares'])('requires transaction datum %s even if it is zero', async field => {
    const ctx = toolCtx(), route = heuristicRoute('Kolik jsem letos nakoupil a prodal?', [], ctx, 'cs');
    const result = ok(await executeTool('get_transactions', route.period, ctx));
    const evidence = intentEvidence(route, [result]);
    const facts = evidence.facts.filter(f => !f.metric?.endsWith(`:${field}`));
    const draft = expandDraft({ lang: 'cs', blocks: [{ kind: 'facts', text: facts.map((_, i) => `{{v${i}}}`).join(' '),
      claims: Object.fromEntries(facts.map((f, i) => [`v${i}`, { factId: f.id }])), sourceIds: [] }] }, ctx.facts);
    expect(validateAnswer(draft, ctx.facts, [], { requiredFactIds: evidence.facts.map(f => f.id) }))
      .toMatchObject({ ok: false, reasons: ['intent_incomplete'] });
  });
  it.each([
    ['Aký zisk som tento rok realizoval?', 'si realizoval zisk', 'get_realized_pnl'],
    ['What gains have I realised this year?', 'you realized a gain of', 'get_realized_pnl'],
    ['Aká by bola daň, keby som predal 1 kus SYNB za 210 USD?', 'daň navyše', 'simulate_sale'],
    ['What tax if I sold 1 share of SYNB at 210 USD?', 'the extra tax', 'simulate_sale'],
    ['Ktoré akcie ešte nespĺňajú časový test?', 'časový test zatiaľ nesplnený', 'get_tax_lots'],
    ['Which lots are not tax exempt yet?', 'time test not met yet', 'get_tax_lots'],
  ])('answers without a model: %s', async (question, label, tool) => {
    const model = fakeModel(() => rateLimited());
    const r = await answerQuestion({ request: chatRequest(question), history: [] }, { ctx: chatCtx(), llm: llmDeps(model.fetchImpl) });
    expect(r.answer?.text).toContain(label);
    expect(r.metrics.toolsUsed).toContain(tool);
    expect(r.outcome).toBe('fallback');
  });
});
