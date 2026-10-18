import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, type QueryObserverOptions } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompanyFundamentals } from '@/hooks/useCompanyFundamentals';
import { normalizeYahooFundamentals } from '../../supabase/functions/_shared/fundamentals.js';

const mocks = vi.hoisted(() => ({ from: vi.fn(), alias: vi.fn(), row: vi.fn(), ilike: vi.fn(), eq: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));

const mount = (symbol: string | null) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { ...renderHook(() => useCompanyFundamentals(symbol), { wrapper }), client };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alias.mockResolvedValue({ data: null, error: null });
  mocks.row.mockResolvedValue({ data: null, error: null });
  mocks.ilike.mockReturnValue({ maybeSingle: mocks.alias });
  mocks.eq.mockReturnValue({ maybeSingle: mocks.row });
  mocks.from.mockImplementation((table: string) => ({ select: () => table === 'ticker_alias' ? { ilike: mocks.ilike } : { eq: mocks.eq } }));
});
afterEach(cleanup);

describe('useCompanyFundamentals', () => {
  it('reads by canonical ticker, keeps last good data on error, and caches for one hour', async () => {
    const saved = normalizeYahooFundamentals({ timeseries: { result: [{ annualTotalRevenue: [
      { asOfDate: '2025-12-31', currencyCode: 'USD', reportedValue: { raw: 100 } },
    ] }] } }, 'META', '2026-10-17T06:00:00Z');
    mocks.alias.mockResolvedValue({ data: { canonical: 'META' }, error: null });
    mocks.row.mockResolvedValue({ data: { symbol: 'META', data: saved, currency: 'USD', status: 'error', fetched_at: saved.fetchedAt }, error: null });
    const { result, client } = mount(' fb ');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ ...saved, status: 'error' });
    expect(mocks.ilike).toHaveBeenCalledWith('alias', 'FB');
    expect(mocks.eq).toHaveBeenCalledWith('symbol', 'META');
    const options = client.getQueryCache().find({ queryKey: ['company-fundamentals', 'FB'] })!.options as QueryObserverOptions;
    expect(options.staleTime).toBe(3600000);
  });

  it('returns null for a symbol absent from the shared cache', async () => {
    const { result } = mount('NBIS');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('disables queries for empty symbols and cash', () => {
    for (const symbol of [null, '', ' cash ']) {
      const { result } = mount(symbol);
      expect(result.current.fetchStatus).toBe('idle');
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('escapes wildcard broker tickers during alias lookup', async () => {
    const { result } = mount('ELF_EQ_US');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.ilike).toHaveBeenCalledWith('alias', 'ELF\\_EQ\\_US');
  });

  it('surfaces database errors instead of turning them into empty fundamentals', async () => {
    const error = new Error('unavailable');
    mocks.row.mockResolvedValue({ data: null, error });
    const { result } = mount('META');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(error);
  });
});
