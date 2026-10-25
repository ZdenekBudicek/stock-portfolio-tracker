// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { collectAnalysisEvidence, runChat } from '../../supabase/functions/agent/core/agent.ts';
import { analysisPolicy, buildVerifiedTemplate, renderVerifiedAnswer } from '../../supabase/functions/agent/core/answerTemplate.ts';
import { recordRun } from '../../supabase/functions/agent/core/context.ts';
import { fixtureMarket, fixtureSnapshot, snapshotRepo } from '../../supabase/functions/agent/core/fixture.ts';
import { expandDraft, validateAnswer } from '../../supabase/functions/agent/core/grounding.ts';
import { executeTool, projectForModel } from '../../supabase/functions/agent/core/registry.ts';
import { calculate } from '../../supabase/functions/agent/core/tools/calculate.ts';
import { meta, success } from '../../supabase/functions/agent/core/tools/common.ts';
import type { AnswerDraft, Fact, Route, ToolResult } from '../../supabase/functions/agent/core/types.ts';
import { chatRequest, collect, fakeModel, isRouter, llmDeps, llmResponse, routeReply, shownFactIds } from '../test/agentLlmFixture';
import { ok, toolCtx, toolPeriod } from '../test/agentToolsFixture';

const buy: Route = { group: 'valuace', lang: 'en', tickers: ['SYNA'], period: toolPeriod, analysis: true, needsClarification: false };
const missing: ToolResult<unknown> = { ok: false, error: { code: 'unavailable', message: 'Unavailable' } };
const selection = (f: Fact, text = '{{p}}', extra = {}) => ({ lang: 'en', blocks: [{ kind: 'facts', text,
  claims: { p: { factId: f.id, ...extra } }, sourceIds: [] }] });

describe('meaning-aware claims (C2)', () => {
  it('rejects unsupported non-numeric assertions and empty answers even without claims', () => {
    for (const text of ['Analysts guarantee a profit.', 'News proves the stock is safe.', '']) {
      expect(validateAnswer({ lang: 'en', blocks: [{ kind: 'facts', text, claims: {}, sourceIds: [] }] }, new Map(), []).ok).toBe(false);
    }
  });
  it.each(['Your tax bill is {{p}}.', 'Analysts guarantee that you will profit.', 'There are no risks.'])('rejects unsupported prose: %s', async text => {
    const ctx = toolCtx(), f = ok(await executeTool('get_quote', { ticker: 'SYNA' }, ctx)).facts[0];
    expect(validateAnswer(expandDraft(selection(f, text), ctx.facts), ctx.facts, []).ok).toBe(false);
  });

  it.each([{ metric: 'tax:estimated_tax' }, { scope: 'scope_foreign' }, { quality: { state: 'complete', freshness: 'missing' } },
    { period: { from: '2020-01-01', to: '2020-12-31' } }])('rejects a forged binding %j', async extra => {
    const ctx = toolCtx(), f = ok(await executeTool('get_quote', { ticker: 'SYNA' }, ctx)).facts[0];
    expect(validateAnswer(expandDraft(selection(f, '{{p}}', extra), ctx.facts), ctx.facts, []).ok).toBe(false);
  });

  it('renders a selected price with its server label and refuses direct unvalidated prose', async () => {
    const ctx = toolCtx(), f = ok(await executeTool('get_quote', { ticker: 'SYNA' }, ctx)).facts[0];
    const check = validateAnswer(expandDraft(selection(f), ctx.facts), ctx.facts, []);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(renderVerifiedAnswer(check.draft, ctx.facts).text).toMatch(/SYNA price/);
    expect(() => renderVerifiedAnswer(expandDraft(selection(f, 'Your tax bill is {{p}}.'), ctx.facts) as AnswerDraft, ctx.facts)).toThrow();
  });

  it('binds equal-valued facts to distinct private scopes without exposing account identifiers', async () => {
    const ctx = toolCtx();
    const a = ok(await executeTool('get_transactions', { ...toolPeriod, from: '2026-10-22', scope: { broker: 'SYNTHETIC', account: 'A1' } }, ctx));
    const b = ok(await executeTool('get_transactions', { ...toolPeriod, from: '2026-10-22' }, ctx));
    expect(a.facts[0].scope).not.toEqual(b.facts[0].scope);
    expect(a.facts[0].id).not.toEqual(b.facts[0].id);
    expect(JSON.stringify(projectForModel('get_transactions', a))).not.toMatch(/SYNTHETIC|A1/);
  });
});

describe('evidence quality (I2)', () => {
  it('distinguishes complete zero, unknown and incomplete zero on the same metric', () => {
    const ctx = toolCtx();
    const f: Fact = { id: 'tax:2026:estimated_tax', value: 0, unit: 'money', currency: 'CZK', period: toolPeriod, source: 'tax_model', as_of: '2026-10-23' };
    const complete = ok(success(ctx, {}, [f], meta({ snapshotId: 'test' }))).facts[0];
    const unknown = ok(success(ctx, {}, [{ ...f, value: null }], meta({ snapshotId: 'test' }))).facts[0];
    const incomplete = ok(success(ctx, {}, [f], meta({ snapshotId: 'test', complete: false, freshness: 'stale' }))).facts[0];
    expect(complete.quality).toEqual({ state: 'complete', freshness: 'fresh' });
    expect(unknown.quality?.state).toBe('unknown');
    expect(incomplete.quality).toEqual({ state: 'incomplete', freshness: 'stale' });
    expect(new Set([complete.id, unknown.id, incomplete.id]).size).toBe(3);
    expect(validateAnswer(expandDraft(selection(unknown), ctx.facts), ctx.facts, []).ok).toBe(false);
    const draft = expandDraft(selection(incomplete), ctx.facts) as AnswerDraft;
    // Incompleteness of a ledger figure is said; freshness is the assistant's own concern and never repeated in the text.
    expect(renderVerifiedAnswer(draft, ctx.facts).text).toMatch(/incomplete/);
    expect(renderVerifiedAnswer(draft, ctx.facts).text).not.toMatch(/not fresh/);
    expect(ok(calculate({ op: 'add', inputs: [complete.id, incomplete.id] }, ctx)).data.result.quality).toEqual(incomplete.quality);
  });

  it('does not discard a different period when calculating a claim', async () => {
    const ctx = toolCtx();
    const a = ok(await executeTool('get_transactions', toolPeriod, ctx)).facts[0];
    const b = ok(await executeTool('get_transactions', { ...toolPeriod, from: '2025-01-01' }, ctx)).facts[0];
    expect(calculate({ op: 'add', inputs: [a.id, b.id] }, ctx).ok).toBe(false);
  });

  it('distinguishes no headlines in a complete period from an unavailable news source', async () => {
    const base = fixtureMarket();
    const empty = toolCtx('A', { market: { ...base, news: async () => ({ data: [], asOf: '2026-10-23', fetchedAt: '2026-10-23', source: 'stock_news', freshness: 'fresh', warnings: [] }) } });
    const absent = toolCtx('A', { market: { ...base, news: async () => ({ data: null, asOf: '2026-10-23', fetchedAt: '2026-10-23', source: 'stock_news', freshness: 'missing', warnings: [] }) } });
    const args = { ticker: 'SYNA', period: toolPeriod };
    expect(ok(await executeTool('get_stock_news', args, empty))).toMatchObject({ meta: { complete: true }, facts: [{ value: 0, quality: { state: 'complete' } }] });
    expect(ok(await executeTool('get_stock_news', args, absent))).toMatchObject({ meta: { complete: false }, facts: [{ value: null, quality: { state: 'unknown' } }] });
  });

  it('keeps period and incomplete qualifiers attached to each tax claim', async () => {
    const ctx = toolCtx();
    const a = ok(await executeTool('get_tax_report', { year: 2025 }, ctx));
    recordRun(ctx, { name: 'get_tax_report', args: { year: 2025 }, result: a });
    const text = buildVerifiedTemplate(ctx, { ...buy, analysis: false, group: 'dane' }).text;
    expect(text.split('\n').find(line => line.includes('estimated tax'))).toMatch(/2025/);
  });
  it.each(['holdings', 'allocation', 'fundamentals', 'news'] as const)('lowers confidence for unavailable %s while keeping the data-backed verdict', async key => {
    const ctx = toolCtx(), evidence = await collectAnalysisEvidence('SYNA', ctx);
    evidence[key] = missing;
    expect(analysisPolicy(ctx, evidence)).toMatchObject({ verdict: 'attractive', maxConfidence: 'low', confidence: 'low' });
    const text = buildVerifiedTemplate(ctx, buy, evidence).text;
    expect(text).toMatch(/rather attractive/);
    // Missing evidence lowers the confidence shown with the view; it is not narrated as "incomplete evidence".
    expect(text).toMatch(/Confidence: low/);
    expect(text).not.toMatch(/incomplete evidence|not fresh/i);
    if (key === 'holdings' || key === 'allocation') expect(text).not.toMatch(/You do not hold/);
  });

  it('does not infer non-ownership from a missing allocation fact when holdings are incomplete', async () => {
    const ctx = toolCtx(), evidence = await collectAnalysisEvidence('SYNA', ctx);
    for (const id of ctx.facts.keys()) if (id.startsWith('holding:')) ctx.facts.delete(id);
    evidence.holdings = missing; evidence.allocation = missing;
    expect(buildVerifiedTemplate(ctx, buy, evidence).text).not.toMatch(/You do not hold/);
  });

  it('carries incomplete zero and stale quality through facts, claims, calculations and tax output', async () => {
    const snap = fixtureSnapshot('A');
    const base = snapshotRepo(snap, 'incomplete');
    const ctx = toolCtx('A', { repo: { ...base, load: async read => { const loaded = await base.load(read);
      return { ...loaded, meta: { ...loaded.meta, complete: false, warnings: ['missing_fx:2026'] } }; } } });
    const result = ok(await executeTool('get_tax_report', { year: 2026 }, ctx));
    recordRun(ctx, { name: 'get_tax_report', args: { year: 2026 }, result });
    const f = result.facts.find(f => f.id.includes('estimated_tax'))!;
    expect(f.quality?.state).toBe('incomplete');
    const draft = expandDraft(selection(f), ctx.facts) as AnswerDraft;
    expect(draft.blocks[0].claims.p.quality).toEqual(f.quality);
    const derived = ok(calculate({ op: 'add', inputs: [f.id, f.id] }, ctx));
    expect(derived.data.result.quality.state).toBe('incomplete');
    const text = buildVerifiedTemplate(ctx, { ...buy, analysis: false, group: 'dane' }).text;
    expect(text).toMatch(/incomplete/i);
    expect(text).toMatch(/exchange rate/i);
  });

  it('treats an empty portfolio as complete without a market FX rate, including chat trace', async () => {
    const snap = fixtureSnapshot('A');
    snap.positions = []; snap.transactions = []; snap.snapshots = []; snap.dividends = []; snap.deposits = []; snap.brokerSummary = null;
    const base = fixtureMarket();
    const ctx = toolCtx('A', { repo: snapshotRepo(snap, 'empty'), market: { ...base, quote: async () => ({ data: null,
      asOf: null, fetchedAt: null, freshness: 'missing', source: 'none', warnings: [] }) } });
    for (const name of ['get_portfolio_summary', 'get_holdings', 'get_allocation']) {
      const result = ok(await executeTool(name, {}, ctx));
      expect(result.meta.complete).toBe(true);
      expect(result.facts.every(f => f.value === null || f.value === 0)).toBe(true);
    }
    const model = fakeModel(body => isRouter(body) ? routeReply({ group: 'portfolio', analysis: false }) : llmResponse({ content: '{}' }));
    const events = await collect(runChat({ request: chatRequest('Co držím v portfoliu?'), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) }));
    const answer = events.find(e => e.type === 'answer');
    expect(answer?.type === 'answer' && answer.text).toMatch(/zatím nic nedržíš/i);
    expect(events.filter(e => e.type === 'trace').flatMap(e => e.items).every(t => t.state === 'ok')).toBe(true);
  });

  it('keeps tax qualifications on a successful model answer, not only the fallback', async () => {
    const base = snapshotRepo(fixtureSnapshot('A'), 'partial-tax');
    const ctx = toolCtx('A', { repo: { ...base, load: async read => { const loaded = await base.load(read);
      return { ...loaded, meta: { ...loaded.meta, complete: false, warnings: ['missing_fx:2026'] } }; } } });
    const model = fakeModel(body => {
      if (isRouter(body)) return routeReply({ group: 'dane', analysis: false, tickers: [], lang: 'en' });
      return llmResponse({ content: JSON.stringify({ lang: 'en', blocks: [{ kind: 'facts', factIds: shownFactIds(body) }] }) });
    });
    const events = await collect(runChat({ request: chatRequest('What is my tax for 2026?', 'en'), history: [] }, { ctx, llm: llmDeps(model.fetchImpl) }));
    expect(events.at(-1)).toMatchObject({ outcome: 'ok' });
    expect(events.find(e => e.type === 'answer')).toMatchObject({ text: expect.stringMatching(/exchange rates.*missing/) });
  });

  it('uses only the current analysis evidence, not a more recent unrelated assumption run', async () => {
    const ctx = toolCtx(), evidence = await collectAnalysisEvidence('SYNA', ctx);
    const before = buildVerifiedTemplate(ctx, buy, evidence).text;
    await executeTool('get_fair_value', { ticker: 'SYNA', assumptions: { growth: 0.01, discount: 0.2 } }, ctx);
    expect(buildVerifiedTemplate(ctx, buy, evidence).text).toBe(before);
  });

  it('qualifies an analyst target with unknown currency and cannot treat it as complete support', async () => {
    const base = fixtureMarket();
    const ctx = toolCtx('A', { market: { ...base, analysts: async (ticker, read) => {
      const result = await base.analysts(ticker, read);
      return { ...result, data: result.data ? { ...result.data, currency: null } : null };
    } } });
    const evidence = await collectAnalysisEvidence('SYNA', ctx);
    expect(analysisPolicy(ctx, evidence)).toMatchObject({ verdict: 'attractive', maxConfidence: 'low' });
    expect(buildVerifiedTemplate(ctx, buy, evidence).text).toMatch(/currency.*unknown/);
    evidence.fairValue = missing;
    expect(analysisPolicy(ctx, evidence)).toMatchObject({ verdict: 'insufficient', missing: expect.arrayContaining(['analysts']) });
  });
});

describe('the view on a buy question is a clear opinion from the data, without narrating stale or incomplete evidence', () => {
  const ask = async (market: ReturnType<typeof fixtureMarket>, lang: 'cs' | 'en' = 'cs') => {
    const ctx = toolCtx('A', { market, lang }), evidence = await collectAnalysisEvidence('SYNA', ctx);
    return buildVerifiedTemplate(ctx, { ...buy, lang }, evidence).text.replace(/[\u00a0\u202f]/g, ' ');
  };
  it('says plainly not to buy more at a stretched valuation', async () => {
    const base = fixtureMarket();
    const market = { ...base, quote: async (t: string, c: Parameters<typeof base.quote>[1]) => {
      const q = await base.quote(t, c);
      return t === 'SYNA' && q.data ? { ...q, data: { ...q.data, price: q.data.price * 3 } } : q;
    } };
    const text = await ask(market);
    expect(text).toMatch(/Můj názor\nNa současné valuaci bych nepřikupoval: cena je o [\d ,]+ % nad férovou hodnotou modelu\./);
    expect(text).toMatch(/Cena vůči ocenění: spíš drahá\./);
    expect(text).toMatch(/Potvrzují to i analytici: jejich průměrný cíl 150,00 USD je pod aktuální cenou\./);
    expect(text).toMatch(/ne investiční doporučení/);
  });
  it('says when the business does not make sense in the numbers: a loss, cash burn and a short runway', async () => {
    const base = fixtureMarket();
    const market = { ...base, fundamentals: async (t: string, c: Parameters<typeof base.fundamentals>[1]) => {
      const v = await base.fundamentals(t, c);
      if (t !== 'SYNA' || !v.data) return v;
      const data = structuredClone(v.data);
      const last = (s: { periods: string[]; values: Record<string, (number | null)[] | undefined> }, k: string, x: number) => {
        const arr = s.values[k] ?? (s.values[k] = s.periods.map(() => null));
        arr[arr.length - 1] = x;
      };
      last(data.annual, 'netIncome', -120_000_000); last(data.annual, 'freeCashFlow', -90_000_000);
      last(data.quarterly, 'cash', 100_000_000);
      return { ...v, data };
    } };
    const text = await ask(market);
    expect(text).toMatch(/Byznys mi z čísel zatím nedává přesvědčivý smysl: v posledním vykázaném roce je ve ztrátě \(-120 mil\. USD\) a pálí hotovost \(volný cash flow -90 mil\. USD\)/);
    expect(text).toMatch(/nevystačí na dlouho/);
  });
  it('never repeats "not fresh" or "incomplete evidence" in a buy answer, even with stale evidence', async () => {
    const base = fixtureMarket();
    const market = { ...base, analysts: async (t: string, c: Parameters<typeof base.analysts>[1]) => ({ ...(await base.analysts(t, c)), freshness: 'stale' as const }) };
    const cs = await ask(market), en = await ask(market, 'en');
    expect(cs).not.toMatch(/není čerstv|neúplné podklady|Část podkladů chybí|čas stažení od poskytovatele/);
    expect(en).not.toMatch(/not fresh|incomplete evidence|retrieved from the provider/);
    expect(cs).toMatch(/Jistota: nízká/);
  });
});

describe('codex review of the view: business cases that must change or qualify it', () => {
  type Series = { periods: string[]; values: Record<string, (number | null)[] | undefined> };
  const withStatements = (change: (data: { annual: Series; quarterly: Series }) => void) => {
    const base = fixtureMarket();
    return { ...base, fundamentals: async (t: string, c: Parameters<typeof base.fundamentals>[1]) => {
      const v = await base.fundamentals(t, c);
      if (t !== 'SYNA' || !v.data) return v;
      const data = structuredClone(v.data) as unknown as { annual: Series; quarterly: Series };
      change(data);
      return { ...v, data: data as unknown as typeof v.data };
    } };
  };
  const set = (s: Series, k: string, x: number | null) => { const arr = s.values[k] ?? (s.values[k] = s.periods.map(() => null)); arr[arr.length - 1] = x; };
  const view = async (market: ReturnType<typeof fixtureMarket>) => {
    const ctx = toolCtx('A', { market, lang: 'cs' }), evidence = await collectAnalysisEvidence('SYNA', ctx);
    const text = buildVerifiedTemplate(ctx, { ...buy, lang: 'cs' }, evidence).text.replace(/[\u00a0\u202f]/g, ' ');
    return text.slice(text.indexOf('Můj názor'));
  };
  it('burning cash that will not last decides the view even when the price looks cheap', async () => {
    const text = await view(withStatements(d => { set(d.annual, 'netIncome', -120_000_000); set(d.annual, 'freeCashFlow', -90_000_000); set(d.quarterly, 'cash', 1_000_000); }));
    expect(text).toMatch(/^Můj názor\nTeď bych nepřikupoval: firma pálí hotovost/);
    expect(text).not.toMatch(/rozumná příležitost|přikupoval jen opatrně/);
  });
  it('calls operating cash flow by its name when free cash flow is not reported', async () => {
    const text = await view(withStatements(d => { set(d.annual, 'freeCashFlow', null); set(d.annual, 'operatingCashFlow', 200_000_000); }));
    expect(text).toMatch(/provozní cash flow 200 mil\. USD/);
    expect(text).not.toMatch(/volný cash flow/);
  });
  it('says when a profitable company still burns cash, and warns on a short runway', async () => {
    const text = await view(withStatements(d => { set(d.annual, 'netIncome', 150_000_000); set(d.annual, 'freeCashFlow', -90_000_000); set(d.quarterly, 'cash', 10_000_000); }));
    expect(text).toMatch(/Účetně je ziskový \(150 mil\. USD\), ale hotovost zatím pálí/);
    expect(text).toMatch(/nevystačí na dlouho/);
  });
  it('uses the newest cash balance, annual or quarterly', async () => {
    const text = await view(withStatements(d => {
      set(d.annual, 'netIncome', -50_000_000); set(d.annual, 'freeCashFlow', -100_000_000); set(d.annual, 'cash', 500_000_000);
      d.quarterly.periods = ['2024-03-31']; d.quarterly.values = { cash: [1_000_000] };
    }));
    expect(text).toMatch(/nedává přesvědčivý smysl/);
    expect(text).not.toMatch(/nevystačí na dlouho/);
  });
  it('says nothing about the business from statements older than about a year and a half', async () => {
    const text = await view(withStatements(d => { d.annual.periods = d.annual.periods.map((_, i, a) => `${2020 - (a.length - 1 - i)}-12-31`); }));
    expect(text).not.toMatch(/Byznys|Účetně/);
  });
});
