import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FairValue, { FairValueForSymbol } from '@/components/fundamentals/FairValue';
import i18n from '@/i18n';
import type { CompanyFundamentals, FundamentalSeries } from '@/types/fundamentals';
import fixtures from './fixtures/fair-value-companies.json';
import { calculateFairValue, defaultAssumptions, type MarketContext } from '@/lib/fairValue';

const queries = vi.hoisted(() => ({ fundamentals: vi.fn(), history: vi.fn(), analysts: vi.fn(() => ({ data: undefined, isFetched: false })),
  live: vi.fn(async () => ({ analysts: 'loaded' })), invalidate: vi.fn() }));
vi.mock('@/hooks/useCompanyFundamentals', () => ({ useCompanyFundamentals: queries.fundamentals }));
vi.mock('@/hooks/usePriceHistory', () => ({ usePriceHistory: queries.history }));
vi.mock('@/hooks/useAnalystSnapshot', () => ({ useAnalystSnapshot: queries.analysts }));
vi.mock('@/hooks/useFundamentalsRequests', () => ({ fetchCompanyData: queries.live }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: queries.invalidate }) }));

const fundamentals: CompanyFundamentals = {
  symbol: 'TEST', currency: 'USD', status: 'ok', fetchedAt: '2026-10-18',
  annual: {
    periods: ['2023-12-31', '2024-12-31', '2025-12-31'],
    values: { freeCashFlow: [100, 100, 100], dilutedEps: [3, 3, 3], dilutedShares: [10, 10, 10], equity: [100, 100, 100], dividendsPaid: [-10, -10, -10] } as FundamentalSeries['values'],
  },
  quarterly: { periods: [], values: {} as FundamentalSeries['values'] },
};

beforeEach(async () => { await i18n.changeLanguage('cs'); });
afterEach(cleanup);

describe('fair value panel', () => {
  it('recalculates from controls, selects average FCF and resets all assumptions', () => {
    render(<FairValue fundamentals={fundamentals} price={40} />);
    const dcfText = () => screen.getByText('DCF · volné cash flow').parentElement!.textContent;
    const original = dcfText();
    fireEvent.change(screen.getByRole('slider', { name: 'Růst FCF · roky 1–5' }), { target: { value: '25' } });
    expect(dcfText()).not.toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'Průměr tří let' }));
    expect(screen.getByRole('button', { name: 'Průměr tří let' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Přičíst čistou hotovost na akcii' }));
    expect(screen.getAllByText(/Pro přičtení čisté hotovosti chybí/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Vrátit výchozí' }));
    expect(dcfText()).toBe(original);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'TTM / poslední rok' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('marks controls that cannot change the fair value of a loss maker', () => {
    const loss = { ...fundamentals, annual: { ...fundamentals.annual, values: { ...fundamentals.annual.values, dilutedEps: [-1, -1, -1] } } };
    const { unmount } = render(<FairValue fundamentals={fundamentals} price={40} />);
    expect(screen.getByRole('slider', { name: 'Růst FCF · roky 1–5' }).parentElement!.textContent).not.toContain('Nemění férovou hodnotu');
    unmount();
    render(<FairValue fundamentals={loss} price={40} />);
    expect(screen.getByRole('slider', { name: 'Růst FCF · roky 1–5' }).parentElement!.textContent).toContain('Nemění férovou hodnotu');
    expect(screen.getByText(/U profilu „Ztrátová firma“ vstupují/)).toBeInTheDocument();
  });
  it('explains invalid terminal assumptions and leaves other methods available', () => {
    render(<FairValue fundamentals={fundamentals} price={40} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Diskontní sazba' }), { target: { value: '2' } });
    expect(screen.getAllByText(/Zkontroluj sazby:/).length).toBeGreaterThan(0);
    expect(screen.getByText('Násobek zisku · P/E').parentElement!.textContent).toContain('$54.00');
  });
  it('blocks foreign-currency calculations and disables assumption controls', () => {
    render(<FairValue fundamentals={{ ...fundamentals, currency: 'EUR' }} price={40} />);
    expect(screen.getByText(/Výkazy jsou v měně EUR/, { selector: '[role="status"]' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Diskontní sazba' })).toBeDisabled();
    expect(screen.getByText('Férová hodnota · vážený odhad').parentElement!.textContent).toContain('0 použitelných metod');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('renders translated English labels and number formats, with no missing translation keys', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    const { container } = render(<FairValue fundamentals={fundamentals} price={40} />);
    expect(screen.getByRole('heading', { name: 'Fair value calculator' })).toBeInTheDocument();
    expect(screen.getByText('Earnings multiple · P/E').parentElement!.textContent).toContain('$54.00');
    expect(screen.getByRole('slider', { name: 'Growth P/E horizon' })).toHaveAttribute('aria-valuetext', '5 years');
    expect(container.textContent).not.toMatch(/fair\.[a-z]/);
  });
  it('resets overrides when the company changes and handles a missing quote', () => {
    const { rerender } = render(<FairValue fundamentals={fundamentals} price={40} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Férové / cílové P/E' }), { target: { value: '30' } });
    rerender(<FairValue fundamentals={{ ...fundamentals, symbol: 'OTHER' }} price={null} />);
    expect(screen.getByRole('slider', { name: 'Férové / cílové P/E' })).toHaveValue('18');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Chybí kladná aktuální cena pro reverzní DCF.')).toBeInTheDocument();
  });

  it('loads historical defaults through the symbol wrapper, preserves edits on arrival and resets to history', () => {
    const c = fixtures.companies.GOOGL;
    queries.fundamentals.mockReturnValue({ data: c.fundamentals });
    queries.history.mockReturnValue({ data: undefined });
    const { rerender } = render(<FairValueForSymbol symbol="GOOGL" price={c.price} />);
    const f = c.fundamentals as CompanyFundamentals;
    const pe = () => screen.getByRole('slider', { name: 'Férové / cílové P/E' });
    // GOOGL grows fast: the growth model's P/E comes from the growth ahead, not from the price history.
    const growthPe = defaultAssumptions(f, c.closes).assumptions.pe;
    expect(Number((pe() as HTMLInputElement).value)).toBeCloseTo(defaultAssumptions(f).assumptions.pe);
    fireEvent.change(pe(), { target: { value: '30' } });
    queries.history.mockReturnValue({ data: c.closes });
    rerender(<FairValueForSymbol symbol="GOOGL" price={c.price} />);
    expect(queries.history).toHaveBeenCalledWith('GOOGL');
    expect(queries.analysts).toHaveBeenCalledWith('GOOGL');
    expect(pe()).toHaveValue('30');
    fireEvent.click(screen.getByRole('button', { name: 'Vrátit výchozí' }));
    expect(Number((pe() as HTMLInputElement).value)).toBeCloseTo(growthPe);
    expect(screen.getByRole('button', { name: 'Normalizovat investice' })).toHaveAttribute('aria-pressed', 'true');
    const r = calculateFairValue(f, c.price, undefined, c.closes);
    expect(r.model).toBe('revenue');
    expect(screen.getByText('Profil podle výkazů: Rychle rostoucí firma')).toBeInTheDocument();
    expect(screen.getByText('Férová hodnota · vážený odhad').parentElement!.textContent).toContain(`$${r.value!.toFixed(2)}`);
    expect(screen.getByText(/Cena je o .*nad férovou hodnotou/)).toBeInTheDocument();
    expect(screen.queryByText(/Bezpečnostní rezerva:/)).not.toBeInTheDocument();
    expect(screen.getByText('DCF · tržby a marže')).toBeInTheDocument();
    expect(screen.getByText(/Odhady analytiků pro tuto akcii zatím nejsou stažené/)).toBeInTheDocument();
    // The growth model's own inputs replace the FCF growth slider.
    expect(screen.getByRole('slider', { name: 'Růst tržeb · roky 1–2' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Růst FCF · roky 1–5' })).not.toBeInTheDocument();
    const graham = screen.getByText('Grahamovo číslo').parentElement!.parentElement!;
    expect(graham.textContent).toContain('Jen pro srovnání');
    expect(screen.getAllByText(/Váha v souhrnu:/)).toHaveLength(2);
  });

  it('fetches a missing analyst consensus right away, once, and reloads it', async () => {
    const c = fixtures.companies.GOOGL;
    queries.fundamentals.mockReturnValue({ data: c.fundamentals });
    queries.history.mockReturnValue({ data: c.closes });
    queries.analysts.mockReturnValue({ data: null, isFetched: true });
    const { rerender } = render(<FairValueForSymbol symbol="GOOGL" price={c.price} />);
    rerender(<FairValueForSymbol symbol="GOOGL" price={c.price} />);
    await act(async () => {});
    expect(queries.live).toHaveBeenCalledTimes(1);
    expect(queries.live).toHaveBeenCalledWith('GOOGL');
    expect(queries.invalidate).toHaveBeenCalledWith({ queryKey: ['analyst-snapshot', 'GOOGL'] });
    queries.analysts.mockReturnValue({ data: undefined, isFetched: false });
  });

  it('shows the consensus, forward P/E and the analysts check once the snapshot arrives', () => {
    const c = fixtures.companies.NVDA;
    const f = c.fundamentals as CompanyFundamentals;
    const market: MarketContext = { estimatesCurrency: 'USD', targetCurrency: 'USD', targetMean: 329, targetLow: 180, targetHigh: 515, asOf: '2026-10-24',
      estimates: [
        { period: 'current', endDate: '2027-01-31', eps: 9.31, revenue: 411.6e9, epsGrowth: 0.95, revenueGrowth: 0.906, analysts: 51 },
        { period: 'next', endDate: '2028-01-31', eps: 15.91, revenue: 692.2e9, epsGrowth: 0.71, revenueGrowth: 0.68, analysts: 52 },
      ] };
    render(<FairValue fundamentals={f} price={c.price} closes={c.closes} market={market} />);
    const r = calculateFairValue(f, c.price, undefined, c.closes, market);
    expect(screen.getByText('Odhady analytiků')).toBeInTheDocument();
    expect(screen.getByText(/Fiskální rok do 2028-01-31: tržby \$692,2 B \(\+68,0 %\), EPS \$15.91 · analytiků: 52/)).toBeInTheDocument();
    expect(screen.getByText('P/E · odhad zisku na příští rok')).toBeInTheDocument();
    expect(screen.getByText('Růst tržeb obsažený v ceně')).toBeInTheDocument();
    expect(r.analystCheck!.status).not.toBe('inline');
    expect(screen.getByText(new RegExp(r.analystCheck!.status === 'outside' ? 'mimo celé rozpětí cílů analytiků' : 'průměrným cílem analytiků'))).toBeInTheDocument();
  });

  it('shows bounded downside and above-value wording without negative safety', () => {
    const c = fixtures.companies.TSLA;
    render(<FairValue fundamentals={c.fundamentals as CompanyFundamentals} price={c.price} closes={c.closes} />);
    expect(screen.getByText('Potenciál k férové hodnotě').parentElement!.textContent).toMatch(/86,2/);
    expect(screen.getByText(/Cena je o .*nad férovou hodnotou/)).toBeInTheDocument();
    expect(screen.queryByText(/Bezpečnostní rezerva:/)).not.toBeInTheDocument();
  });

  it.each(['cs', 'en'])('labels loss-company P/S, unavailable REITs and all method controls in %s', async language => {
    await act(async () => { await i18n.changeLanguage(language); });
    const c = fixtures.companies.RKLB;
    const { container, rerender } = render(<FairValue fundamentals={c.fundamentals as CompanyFundamentals} price={c.price} closes={c.closes} />);
    expect(screen.getByText(i18n.t('fair.relativeSummary'))).toBeInTheDocument();
    expect(container.textContent).toContain(i18n.t('fair.reason.lossMaking'));
    expect(container.textContent).not.toMatch(/fair\.[a-z]/);
    const o = fixtures.companies.O;
    rerender(<FairValue fundamentals={o.fundamentals as CompanyFundamentals} price={o.price} closes={o.closes} />);
    expect(screen.getByText(i18n.t('fair.reason.missingAffo'), { selector: '[role="status"]' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/fair\.[a-z]/);
  });

  it('resets all new multiple controls to company-derived defaults', () => {
    const c = fixtures.companies.JPM;
    render(<FairValue fundamentals={c.fundamentals as CompanyFundamentals} price={c.price} closes={c.closes} />);
    const defaults = defaultAssumptions(c.fundamentals as CompanyFundamentals, c.closes).assumptions;
    for (const key of ['pfcf', 'ps', 'pb'] as const) {
      fireEvent.change(screen.getByRole('slider', { name: i18n.t(`fair.controls.${key}`) }), { target: { value: '5' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Vrátit výchozí' }));
    for (const key of ['pfcf', 'ps', 'pb'] as const) {
      const input = screen.getByRole('slider', { name: i18n.t(`fair.controls.${key}`) }) as HTMLInputElement;
      expect(Number(input.value)).toBeCloseTo(defaults[key], 8);
    }
  });
});
