import { expect, it, vi } from 'vitest';
import { createCalculationCache } from '@/lib/calculationCache';
import { computePortfolio } from '@/lib/portfolioModel';
import { computeRealized } from '@/lib/realizedModel';
import { computeCzTaxModel } from '@/lib/czTaxModel';
import { createPortfolioFixture, createTaxFixture } from '@/test/agentPortfolioFixture';
import { toDisplaySnapshots } from '@/lib/snapshotFx';
import { computeWithinLimits } from '../../supabase/functions/agent/core/calculations';

it('reuses only FIFO with the same transaction identity and filter', () => {
  const cache = createCalculationCache();
  const txs = createPortfolioFixture().transactions;
  txs.push({ ...txs[0], id: 'correction', shares: 3, price_usd: 80, ext_id: 'fixture:adj:1' });
  const all = cache.fifo(txs, 'all'), real = cache.fifo(txs, 'real');
  expect(cache.fifo(txs, 'all')).toBe(all);
  expect(cache.fifo(txs, 'real')).toBe(real);
  expect(all.openLots.reduce((sum, lot) => sum + lot.shares, 0)).toBe(9);
  expect(real.openLots.reduce((sum, lot) => sum + lot.shares, 0)).toBe(6);
  expect(cache.fifo([...txs], 'real')).not.toBe(real);
  expect(createCalculationCache().fifo(txs, 'real')).not.toBe(real);
});

it('shares compatible FIFO across portfolio, neutral and Czech models without changing results', () => {
  const cache = createCalculationCache();
  const data = createTaxFixture();
  const fixture = createPortfolioFixture();
  const input = { ...fixture, transactions: data.transactions, snapshots: toDisplaySnapshots(fixture.snapshots, fixture.fx),
    prices: fixture.livePrices.prices, usdCzk: 25, t212Summary: null, dividends: [] };
  expect(computePortfolio(input, cache)).toEqual(computePortfolio(input));
  const real = computeRealized(data, cache), cz = computeCzTaxModel(data, cache);
  expect(real.fifo).toBe(cz.fifo);
  expect(real).toEqual(computeRealized(data));
  expect(cz.report).toEqual(computeCzTaxModel(data).report);
});

it('caches models only within a request and only for identical complete input', () => {
  const cache = createCalculationCache();
  const work = vi.fn((input: { year: number }) => ({ year: input.year }));
  const input = { year: 2026 };
  expect(cache.model(work, input)).toBe(cache.model(work, input));
  expect(work).toHaveBeenCalledTimes(1);
  expect(cache.model(work, { year: 2025 })).toEqual({ year: 2025 });
  expect(createCalculationCache().model(work, input)).not.toBe(cache.model(work, input));
});

it.each([{ transactions: 5001, snapshots: 1 }, { transactions: 1, snapshots: 732 },
  { transactions: -1, snapshots: 1 }, { transactions: NaN, snapshots: 1 }])('rejects unmeasured size before synchronous work: %j', size => {
  const work = vi.fn(() => { throw new Error('must not start'); });
  expect(computeWithinLimits(size, work, { mode: 'limited', maxTransactions: 5000, maxSnapshots: 731 }).status).toBe('unavailable');
  expect(work).not.toHaveBeenCalled();
});

it('allows the measured size without truncating history, including full mode', () => {
  for (const mode of ['full', 'limited'] as const) {
    const work = vi.fn(() => 200);
    expect(computeWithinLimits({ transactions: 5000, snapshots: 731 }, work,
      { mode, maxTransactions: 5000, maxSnapshots: 731 })).toEqual({ status: 'ready', value: 200 });
    expect(work).toHaveBeenCalledTimes(1);
  }
});

it('defaults to the measured manifest limit (Běh 18: largest measured history, 5,000 trades / 3,653 snapshots)', () => {
  const work = vi.fn(() => 200);
  expect(computeWithinLimits({ transactions: 5001, snapshots: 0 }, work).status).toBe('unavailable');
  expect(computeWithinLimits({ transactions: 0, snapshots: 3654 }, work).status).toBe('unavailable');
  expect(work).not.toHaveBeenCalled();
  expect(computeWithinLimits({ transactions: 5000, snapshots: 3653 }, work)).toEqual({ status: 'ready', value: 200 });
});
