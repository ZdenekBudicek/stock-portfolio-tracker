import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaxResidence } from '@/hooks/useTaxResidence';
import { writeLastSettings } from '@/lib/tax/userSettings';

const mocks = vi.hoisted(() => ({ eq: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({ select: () => ({ eq: mocks.eq }) }) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useTaxResidence(), { wrapper });
};

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);

describe('useTaxResidence', () => {
  it('a failed read with nothing remembered leaves the residence unknown — no Czech outputs', async () => {
    mocks.eq.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
    const { result } = mount();
    expect(result.current.known).toBe(false);
    expect(result.current.jurisdiction.caps.taxEstimate).toBe(false);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.known).toBe(false);
    expect(result.current.jurisdiction.caps).toEqual({ taxEstimate: false, holdingExemption: false, annualProceedsLimit: false, dividendTaxCredit: false, taxReport: false });
    expect(result.current.needsOnboarding).toBe(false);
  });

  it('a failed read keeps the last known answer of this user', async () => {
    writeLastSettings('u1', { taxResidence: 'OTHER', baseCurrency: 'USD', confirmed: true, available: true });
    mocks.eq.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
    const { result } = mount();
    expect(result.current.known).toBe(true);
    expect(result.current.jurisdiction.code).toBe('OTHER');
    expect(result.current.baseCurrency).toBe('USD');
  });

  it('a successful read applies and remembers the setting', async () => {
    mocks.eq.mockResolvedValue({ data: [{ tax_residence: 'CZ', base_currency: 'CZK', confirmed_at: '2026-10-18T10:00:00Z' }], error: null });
    const { result } = mount();
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.jurisdiction.code).toBe('CZ');
    expect(JSON.parse(localStorage.getItem('user-settings:u1')!)).toEqual({ taxResidence: 'CZ', baseCurrency: 'CZK', confirmed: true });
  });
});
