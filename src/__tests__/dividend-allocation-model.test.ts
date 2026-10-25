import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { useDividendModel } from '@/hooks/useInsights';
import SectorAllocation from '@/components/SectorAllocation';
import { analyticsDividend, analyticsPosition, analyticsToday } from '@/test/agentAnalyticsFixture';
import { computeDividendModel } from '@/lib/dividendModel';
import { computeAllocationModel } from '@/lib/allocationModel';
import { buildProfileMap, resolveSector } from '@/lib/tickerProfileModel';

const state = vi.hoisted(() => ({ dividends: [] as ReturnType<typeof analyticsDividend>[],
  positions: null as ReturnType<typeof analyticsPosition>[] | null }));
vi.mock('@/hooks/usePortfolio', async () => ({ useComputedPortfolio: () => ({ positions: state.positions ?? [analyticsPosition('SYN', 600)] }),
  usePositions: () => ({ data: [] }), isCashPosition: (await import('@/lib/portfolioModel')).isCashPosition }));
vi.mock('@/hooks/useExtras', () => ({ useDividends: () => ({ data: state.dividends }) }));
vi.mock('@/hooks/useAssetKinds', () => ({}));
vi.mock('@/hooks/useTaxResidence', () => ({}));
vi.mock('@/hooks/useTickerProfiles', async () => {
  const model = await import('@/lib/tickerProfileModel');
  return { useTickerProfiles: () => ({ data: model.buildProfileMap([{ ticker: 'SYN', sector: 'Technology' }], []) }), resolveSector: model.resolveSector };
});
vi.mock('@/contexts/CurrencyContext', () => ({ useCurrency: () => ({ format: String }) }));
vi.mock('recharts', () => ({ ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children, PieChart: ({ children }: { children: React.ReactNode }) => children,
  Pie: ({ data }: { data: unknown[] }) => createElement('output', { 'data-testid': 'sectors' }, JSON.stringify(data)), Cell: () => null, Tooltip: () => null }));
afterEach(() => { cleanup(); vi.useRealTimers(); state.positions = null; });

it('preserves original dividend hook output with recorded and projected payments', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${analyticsToday}T12:00:00Z`));
  state.dividends = [analyticsDividend(), analyticsDividend({ id: 'projection', broker: 'auto' }),
    analyticsDividend({ id: 'future', broker: 'auto', pay_date: '2026-11-15' })];
  const { result } = renderHook(() => useDividendModel());
  expect(result.current).toMatchSnapshot();
  expect(computeDividendModel({ dividends: state.dividends, positions: [analyticsPosition('SYN', 600)], today: analyticsToday })).toEqual(result.current);
  expect(result.current.received.total).toBe(85);
  expect(result.current.annualTotal).toBe(85);
});

it('excludes cash from every invested allocation and computes concentration in weights', () => {
  const profiles = buildProfileMap([{ ticker: 'SYN', sector: 'Technology' }], []);
  const result = computeAllocationModel({ positions: [analyticsPosition('SYN', 600), analyticsPosition('OTHER', 400), analyticsPosition('CASH', 1000)],
    dbPositions: [], profiles, quoteCurrencies: { SYN: 'USD' } });
  expect(result.denominatorUsd).toBe(1000);
  expect(result.sectors).toEqual([{ name: 'Technology', value: 600, pct: 60 }, { name: 'Ostatní', value: 400, pct: 40 }]);
  expect(result.sectors.reduce((sum, p) => sum + p.pct, 0)).toBe(100);
  expect(result.hhi).toBeCloseTo(0.52);
  expect(result.top5).toEqual([{ ticker: 'SYN', pct: 60 }, { ticker: 'OTHER', pct: 40 }]);
  expect(result.assetTypes).toEqual([{ name: 'Stock', value: 1000, pct: 100 }]);
  expect(result.currencies).toEqual([{ name: 'USD', value: 600, pct: 60 }, { name: 'unknown', value: 400, pct: 40 }]);
  expect(result.warnings).toContain('quote-currency-not-economic-exposure');
  expect(result.warnings).toContain('unknown-quote-currency');
});

it('preserves manual, alias, API and static sector precedence', () => {
  const profiles = buildProfileMap([{ ticker: 'META', sector: 'API' }, { ticker: 'AAPL', sector: 'API' }], [{ alias: 'FB', canonical: 'META' }]);
  expect(resolveSector('FB', null, profiles)).toBe('API');
  expect(resolveSector('AAPL', 'Manual', profiles)).toBe('Manual');
  const result = computeAllocationModel({ positions: [analyticsPosition('AAPL', 600)], profiles, quoteCurrencies: {},
    dbPositions: [{ id: 'synthetic', ticker: 'AAPL', sector: 'Manual', name: 'Synthetic', type: 'Stock', shares: 1, avg_cost_usd: 1, holding_start_date: null }] });
  expect(result.sectors).toEqual([{ name: 'Manual', value: 600, pct: 100 }]);
});

it('handles an empty invested portfolio without NaN', () => {
  const result = computeAllocationModel({ positions: [analyticsPosition('CASH', 1000)], dbPositions: [], profiles: new Map(), quoteCurrencies: {} });
  expect(result.denominatorUsd).toBe(0);
  expect(result.hhi).toBe(0);
  expect(result.top5).toEqual([]);
  expect(result.sectors).toEqual([]);
});

it('renders the original sector percentages in the UI with cash excluded', () => {
  state.positions = [analyticsPosition('SYN', 600), analyticsPosition('OTHER', 400), analyticsPosition('CASH', 1000)];
  render(createElement(SectorAllocation));
  expect(JSON.parse(screen.getByTestId('sectors').textContent!)).toEqual([
    { name: 'Technology', value: 600, pct: 60 }, { name: 'Ostatní', value: 400, pct: 40 },
  ]);
});
