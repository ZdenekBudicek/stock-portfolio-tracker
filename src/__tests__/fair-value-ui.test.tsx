import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FairValue, { FairValueForSymbol } from '@/components/fundamentals/FairValue';
import i18n from '@/i18n';
import type { CompanyFundamentals, FundamentalSeries } from '@/types/fundamentals';
import fixtures from './fixtures/fair-value-companies.json';
import { defaultAssumptions } from '@/lib/fairValue';

const queries = vi.hoisted(() => ({ fundamentals: vi.fn(), history: vi.fn() }));
vi.mock('@/hooks/useCompanyFundamentals', () => ({ useCompanyFundamentals: queries.fundamentals }));
vi.mock('@/hooks/usePriceHistory', () => ({ usePriceHistory: queries.history }));

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
    const pe = () => screen.getByRole('slider', { name: 'Férové / cílové P/E' });
    expect(pe()).toHaveValue('22');
    fireEvent.change(pe(), { target: { value: '30' } });
    queries.history.mockReturnValue({ data: c.closes });
    rerender(<FairValueForSymbol symbol="GOOGL" price={c.price} />);
    expect(queries.history).toHaveBeenCalledWith('GOOGL');
    expect(pe()).toHaveValue('30');
    fireEvent.click(screen.getByRole('button', { name: 'Vrátit výchozí' }));
    expect(Number((pe() as HTMLInputElement).value)).toBeCloseTo(29.0640776283);
    expect(screen.getByRole('button', { name: 'Normalizovat investice' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Férová hodnota · vážený odhad').parentElement!.textContent).toContain('$370.50');
    expect(screen.getByText('Potenciál k férové hodnotě').parentElement!.textContent).toContain('+8,8');
    expect(screen.getByText(/Cena je o 8,1.*pod férovou hodnotou/)).toBeInTheDocument();
    expect(screen.getByText(/Bezpečnostní rezerva:/)).toBeInTheDocument();
    const graham = screen.getByText('Grahamovo číslo').parentElement!.parentElement!;
    expect(graham.textContent).toContain('Jen pro srovnání');
    expect(screen.getAllByText(/Váha v souhrnu:/)).toHaveLength(4);
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
