import { expect, it } from 'vitest';
import { chooseCpuPolicy } from '../../supabase/functions/agent/core/budget.ts';
import { createCpuFixture, computeCpuFixture, createPortfolioCpuFixture, computePortfolioCpuFixture } from '../test/agentCpuFixture.ts';

it.each([[1199, 'full'], [1200, 'limited'], [1201, 'limited'], [2001, 'limited'], [NaN, 'limited']])('CPU policy %s = %s', (ms, policy) => {
  expect(chooseCpuPolicy(ms as number)).toBe(policy);
});

it('profiles the extracted portfolio over the entire synthetic history', () => {
  const fixture = createPortfolioCpuFixture(5000);
  expect(fixture.portfolio.transactions).toHaveLength(5000);
  expect(fixture.portfolio.snapshots).toHaveLength(731);
  expect(fixture.portfolio.positions).toHaveLength(9);
  const result = computePortfolioCpuFixture(fixture);
  expect(result.portfolio.positions).toHaveLength(9);
  expect(result.portfolio.totalValue).toBeGreaterThan(0);
  expect(result.portfolio.realizedProfit).toBeGreaterThan(0);
  expect(result.performance).toHaveLength(731);
});
it('uses deterministic 5000 trades, multiple accounts, sales, splits and two years of daily history', () => {
  const fixture = createCpuFixture(5000);
  expect(fixture).toEqual(createCpuFixture(5000));
  expect(fixture.transactions).toHaveLength(5000);
  expect(new Set(fixture.transactions.map(t => t.broker_account)).size).toBeGreaterThan(1);
  expect(fixture.transactions.some(t => t.side === 'SELL')).toBe(true);
  expect(fixture.transactions.some(t => t.ext_id?.includes(':split:'))).toBe(true);
  expect(fixture.snapshots).toHaveLength(731);
  const result = computeCpuFixture(fixture);
  expect(result.fifo.disposals.length).toBeGreaterThan(0);
  expect(result.fifo.warnings).toEqual([]);
  expect(result.sales.rows.length).toBeGreaterThan(0);
  expect(result.performance).toHaveLength(731);
});
