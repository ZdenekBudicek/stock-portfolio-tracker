// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { calculate } from '../../supabase/functions/agent/core/tools/calculate.ts';
import { mapLimit } from '../../supabase/functions/agent/core/tools/common.ts';
import { executeTool } from '../../supabase/functions/agent/core/registry.ts';
import type { Fact } from '../../supabase/functions/agent/core/types.ts';
import { factOf, ok, toolCtx } from '../test/agentToolsFixture';

const at = '2026-10-23T11:55:00.000Z';
function ctxWith(...facts: Fact[]) {
  const ctx = toolCtx();
  for (const f of facts) ctx.facts.set(f.id, f);
  return ctx;
}
const usd = (id: string, value: number, ticker = 'SYNA', extra: Partial<Fact> = {}): Fact =>
  ({ id, value, unit: 'money', currency: 'USD', ticker, source: 'Finnhub', as_of: at, ...extra });

describe('calculate', () => {
  it('subtracts two same-ticker USD facts and records its inputs', () => {
    const ctx = ctxWith(usd('f1', 518.25), usd('f2', 521.6));
    const result = ok(calculate({ op: 'subtract', inputs: ['f1', 'f2'] }, ctx));
    expect(result.data.result.value).toBeCloseTo(-3.35, 12);
    expect(result.data.result).toMatchObject({ unit: 'money', currency: 'USD', ticker: 'SYNA', source: 'calculate', as_of: at });
    expect(result.data.inputs.map(f => f.id)).toEqual(['f1', 'f2']);
    expect(result.data.op).toBe('subtract');
    expect(ctx.calculations).toEqual([result.data]);
    expect(ctx.facts.get(result.data.result.id)).toEqual(result.data.result);
    expect(result.facts).toEqual([result.data.result]);
  });

  it('keeps the oldest input time as the result time', () => {
    const ctx = ctxWith(usd('f1', 1, 'SYNA', { as_of: '2026-10-20' }), usd('f2', 2));
    expect(ok(calculate({ op: 'add', inputs: ['f1', 'f2'] }, ctx)).data.result.as_of).toBe('2026-10-20');
  });

  it.each([
    ['USD minus EUR', { op: 'subtract', inputs: ['usd', 'eur'] }],
    ['different tickers without explicit sum', { op: 'add', inputs: ['usd', 'other'] }],
    ['division by zero', { op: 'divide', inputs: ['usd', 'zero'] }],
    ['percent change from zero', { op: 'percentChange', inputs: ['zero', 'usd'] }],
    ['unknown fact ID', { op: 'add', inputs: ['usd', 'f99'] }],
    ['code instead of an ID', { op: 'add', inputs: ['usd', 'process.exit()'] }],
    ['code instead of an op', { op: 'process.exit()', inputs: ['usd', 'usd2'] }],
    ['numeric literal input', { op: 'add', inputs: ['usd', 5] }],
    ['null value', { op: 'add', inputs: ['usd', 'missing'] }],
    ['text fact', { op: 'add', inputs: ['usd', 'text'] }],
    ['money times money', { op: 'multiply', inputs: ['usd', 'usd2'] }],
    ['single input subtract', { op: 'subtract', inputs: ['usd'] }],
    ['extra property', { op: 'add', inputs: ['usd', 'usd2'], value: 3 }],
  ])('%s is invalid', (_label, args) => {
    const ctx = ctxWith(usd('usd', 10), usd('usd2', 20), usd('other', 5, 'SYNB'), { ...usd('eur', 4), currency: 'EUR' },
      { ...usd('zero', 0), unit: 'count', currency: undefined }, { ...usd('missing', 0), value: null },
      { id: 'text', value: 'x', unit: 'text', source: 's', as_of: at });
    expect(calculate(args as never, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(ctx.calculations).toEqual([]);
  });

  it('sums across tickers only when asked explicitly and supports shares times price', () => {
    const ctx = ctxWith(usd('a', 10), usd('b', 5, 'SYNB'),
      { id: 'shares', value: 0.00001234, unit: 'shares', ticker: 'BTC', source: 'portfolio_model', as_of: at },
      usd('price', 60000, 'BTC'));
    const sum = ok(calculate({ op: 'sum', inputs: ['a', 'b'] }, ctx)).data.result;
    expect(sum).toMatchObject({ value: 15, currency: 'USD' });
    expect(sum.ticker).toBeUndefined();
    const value = ok(calculate({ op: 'multiply', inputs: ['shares', 'price'] }, ctx)).data.result;
    expect(value).toMatchObject({ unit: 'money', currency: 'USD', ticker: 'BTC' });
    expect(value.value).toBeCloseTo(0.7404, 12);
    const change = calculate({ op: 'percentChange', inputs: ['b', 'a'] }, ctx);
    expect(change).toMatchObject({ ok: false });
  });

  it('percent change and ratio between compatible facts', () => {
    const ctx = ctxWith(usd('old', 100), usd('new', 110));
    expect(ok(calculate({ op: 'percentChange', inputs: ['old', 'new'] }, ctx)).data.result).toMatchObject({ unit: 'percent', ticker: 'SYNA' });
    expect(ok(calculate({ op: 'percentChange', inputs: ['old', 'new'] }, ctx)).data.result.value).toBeCloseTo(10, 12);
    expect(ok(calculate({ op: 'divide', inputs: ['new', 'old'] }, ctx)).data.result).toMatchObject({ unit: 'ratio', value: 1.1 });
  });

  it('works through the registry on facts produced by tools in the same request', async () => {
    const ctx = toolCtx();
    const quote = ok(await executeTool('get_quote', { ticker: 'SYNA' }, ctx));
    const analysts = ok(await executeTool('get_analyst_view', { ticker: 'SYNA' }, ctx));
    const result = ok(await executeTool('calculate', { op: 'percentChange', inputs: [factOf(quote, 'quote:SYNA:price')!.id,
      factOf(analysts, 'analysts:SYNA:target_mean')!.id] }, ctx));
    expect(result.data.result.value).toBe(0);
    expect(await executeTool('calculate', { op: 'add', inputs: ['quote:SYNA:price'] }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });
});

describe('audit A5: bounded quote fan-out', () => {
  it('mapLimit keeps order and never runs more than the limit at once', async () => {
    let running = 0, peak = 0;
    const out = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 6, async i => {
      running++; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 1));
      running--; return i * 2;
    });
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(peak).toBe(6);
  });
});
