import { describe, expect, it } from 'vitest';
import { CZ, OTHER, jurisdictionFor, normalizeBaseCurrency, normalizeResidence } from '@/lib/tax/jurisdictions';
import { buildSalesReport, isTimeTestExempt, SALE_INCOME_LIMIT_CZK, TAX_RATE, timeTestExemptFrom } from '@/lib/czTax';
import { simulateSale } from '@/lib/saleSimulation';
import { buildDividendReport } from '@/lib/dividendTax';
import { cnbUsdCzk } from '@/lib/cnbRates';
import { runFifo, type Disposal, type FifoTx } from '@/lib/fifo';
import { deriveAlerts, type AlertInput } from '@/lib/alerts';
import { buildRealizedReport, realizedYears } from '@/lib/tax/realized';
import { DEFAULT_USER_SETTINGS, effectiveSettings, readLastSettings, settingsFromResponse, settingsFromRow, writeLastSettings } from '@/lib/tax/userSettings';

const tx = (id: string, side: 'BUY' | 'SELL', shares: number, price: number, at: string, ticker = 'AAPL'): FifoTx =>
  ({ id, ticker, side, shares, price_usd: price, fee_usd: 0, executed_at: at, broker: 'T212', broker_account: null });

describe('jurisdiction selection', () => {
  it('maps the stored residence to a jurisdiction; unknown countries are OTHER', () => {
    expect(jurisdictionFor('CZ')).toBe(CZ);
    expect(jurisdictionFor(' cz ')).toBe(CZ);
    expect(jurisdictionFor('OTHER')).toBe(OTHER);
    expect(jurisdictionFor('DE').annualEngine?.residence).toBe('DE');
    expect(jurisdictionFor('FR')).toBe(OTHER);
    expect(normalizeResidence(null)).toBe('OTHER');
    expect(normalizeBaseCurrency('usd')).toBe('USD');
    expect(normalizeBaseCurrency('eur')).toBe('EUR');
    expect(normalizeBaseCurrency('CHF')).toBe('CZK');
  });

  it('a transient read error is thrown (retried), never read as a Czech resident', () => {
    expect(() => settingsFromResponse({ data: null, error: { code: '08006', message: 'connection failure' } })).toThrow();
    expect(() => settingsFromResponse({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } })).toThrow();
    // Only a missing table (migration not applied) keeps the old Czech default.
    expect(settingsFromResponse({ data: null, error: { code: 'PGRST205', message: 'no table' } })).toEqual(DEFAULT_USER_SETTINGS);
    expect(settingsFromResponse({ data: [{ tax_residence: 'OTHER', base_currency: 'USD', confirmed_at: '2026-10-18T10:00:00Z' }], error: null }).taxResidence).toBe('OTHER');
  });

  it('while the read fails the last known setting applies, else the residence is unknown', () => {
    localStorage.clear();
    expect(effectiveSettings(undefined, readLastSettings('u1'))).toBeNull();
    writeLastSettings('u1', { taxResidence: 'OTHER', baseCurrency: 'USD', confirmed: true, available: true });
    expect(effectiveSettings(undefined, readLastSettings('u1'))).toEqual({ taxResidence: 'OTHER', baseCurrency: 'USD', confirmed: true, available: true });
    expect(readLastSettings('u2')).toBeNull();
    // A fresh read wins over the remembered one.
    expect(effectiveSettings(settingsFromRow({ tax_residence: 'CZ', base_currency: 'CZK', confirmed_at: 'x' }), readLastSettings('u1'))!.taxResidence).toBe('CZ');
    // The missing-table fallback is not remembered as the user's answer.
    writeLastSettings('u3', DEFAULT_USER_SETTINGS);
    expect(readLastSettings('u3')).toBeNull();
  });

  it('a user without a settings row keeps Czech rules but is asked once', () => {
    expect(settingsFromRow(null)).toEqual({ taxResidence: 'CZ', baseCurrency: 'CZK', confirmed: false, available: true });
    expect(settingsFromRow({ tax_residence: 'OTHER', base_currency: 'USD', confirmed_at: '2026-10-18T10:00:00Z' }))
      .toEqual({ taxResidence: 'OTHER', baseCurrency: 'USD', confirmed: true, available: true });
  });
});

describe('CZ jurisdiction wraps the Czech engine unchanged', () => {
  it('points at the existing functions and constants', () => {
    expect(CZ.engine).toEqual({ buildSalesReport, simulateSale, buildDividendReport });
    expect(CZ.caps).toEqual({ taxEstimate: true, holdingExemption: true, annualProceedsLimit: true, dividendTaxCredit: true, taxReport: true });
    const r = CZ.rulesFor(2026);
    expect(r.holdingPeriodYears).toBe(3);
    expect(r.annualProceedsLimit).toEqual({ amount: SALE_INCOME_LIMIT_CZK, currency: 'CZK' });
    expect(r.capitalGainsRate).toBe(TAX_RATE);
    expect(CZ.fxSource).toBe('cnb');
    expect(CZ.lotMethod).toBe('fifo-per-account');
  });

  it('gives the same time test and the same report as calling czTax directly', () => {
    for (const [a, s] of [['2020-03-15', '2023-03-16'], ['2020-03-15', '2023-03-15'], ['2020-02-29', '2023-03-01']]) {
      expect(CZ.isHoldingExempt(a, s)).toBe(isTimeTestExempt(a, s));
      expect(CZ.exemptFrom(a)).toBe(timeTestExemptFrom(a));
    }
    const fifo = runFifo([tx('b1', 'BUY', 10, 100, '2021-01-05T15:00:00Z'), tx('b2', 'BUY', 10, 150, '2024-02-01T15:00:00Z'), tx('s1', 'SELL', 15, 200, '2024-06-03T15:00:00Z')]);
    expect(CZ.engine!.buildSalesReport(fifo.disposals, 2024, undefined, fifo.warnings)).toEqual(buildSalesReport(fifo.disposals, 2024, undefined, fifo.warnings));
  });
});

describe('OTHER jurisdiction', () => {
  it('has no exemptions, no limit, no estimate', () => {
    expect(Object.values(OTHER.caps).every((v) => v === false)).toBe(true);
    expect(OTHER.rulesFor(2026)).toEqual({ year: 2026, holdingPeriodYears: null, annualProceedsLimit: null, capitalGainsRate: null, dividendWithholdingDefault: null, dividendCreditCap: null });
    expect(OTHER.exemptFrom('2020-01-01')).toBeNull();
    expect(OTHER.isHoldingExempt('2010-01-01', '2026-01-01')).toBe(false);
    expect(OTHER.engine).toBeNull();
  });
});

describe('tax alerts follow the jurisdiction', () => {
  const input: AlertInput = {
    today: '2026-10-18', positions: [], moveThresholdPct: 7, watch: [], priceOf: () => null,
    tax: { year: 2026, overLimit: true, complete: true, proceedsCzk: 250_000, estTaxCzk: 12_000 },
    earnings: [], earningsDaysAhead: 3, held: new Set(),
    newlyExempt: [{ ticker: 'AAPL', exemptFrom: '2026-10-10', valueUsd: 1000 }],
    pricesStale: false, pricesError: null,
  };
  const codes = (i: AlertInput) => deriveAlerts(i).map((a) => a.code).sort();

  it('Czech (and the default) keeps tax.limitOver and exempt.lots', () => {
    expect(codes(input)).toEqual(['exempt.lots', 'tax.limitOver']);
    expect(codes({ ...input, caps: CZ.caps })).toEqual(['exempt.lots', 'tax.limitOver']);
  });

  it('OTHER shows neither', () => {
    expect(codes({ ...input, caps: OTHER.caps })).toEqual([]);
  });
});

describe('neutral realized report', () => {
  const fifo = runFifo([
    tx('b1', 'BUY', 10, 100, '2023-03-01T15:00:00Z'),
    tx('s1', 'SELL', 4, 150, '2024-06-03T15:00:00Z'),
    tx('b2', 'BUY', 5, 50, '2024-01-10T15:00:00Z', 'MSFT'),
    tx('s2', 'SELL', 5, 40, '2024-07-01T15:00:00Z', 'MSFT'),
    tx('s3', 'SELL', 2, 10, '2024-08-01T15:00:00Z', 'NOPE'),
  ]);
  const divs = [
    { id: 'd1', ticker: 'AAPL', ex_date: '2024-05-10', pay_date: '2024-05-16', amount_per_share: 0.25, shares_held: 10, total_amount_usd: 2.5, status: 'paid', broker: 'T212', ext_id: 't212:d1' },
    { id: 'd2', ticker: 'AAPL', ex_date: '2024-08-09', pay_date: '2024-08-15', amount_per_share: 0.25, shares_held: 6, total_amount_usd: 1.5, status: 'paid', broker: 'XTB', ext_id: 'xtb:d2' },
    // sync-earnings projection marked 'paid' after its ex-date: not a recorded payment.
    { id: 'p1', ticker: 'MSFT', ex_date: '2024-05-15', pay_date: '2024-06-13', amount_per_share: 0.75, shares_held: 10, total_amount_usd: 6.375, status: 'paid', broker: 'auto' },
    { id: 'p2', ticker: 'MSFT', ex_date: '2023-05-15', pay_date: '2023-06-13', amount_per_share: 0.75, shares_held: 10, total_amount_usd: 6.375, status: 'paid', broker: 'auto' },
    { id: 'd3', ticker: 'AAPL', ex_date: '2025-02-09', pay_date: '2025-02-15', amount_per_share: 0.25, shares_held: 6, total_amount_usd: 1.5, status: 'paid', broker: 'manual' },
  ];

  it('sums gains and losses in USD with no exemption or tax', () => {
    const r = buildRealizedReport(fifo.disposals, fifo.warnings, divs, 2024, 'USD', '2026-10-18');
    expect(r.rows).toHaveLength(2);
    expect(r.gains).toBeCloseTo(200);
    expect(r.losses).toBeCloseTo(-50);
    expect(r.net).toBeCloseTo(150);
    expect(r.proceeds).toBeCloseTo(800);
    expect(r.dividends).toEqual({ total: 4, count: 2, grossRecorded: 1, projected: 1 });
    expect(r.unmatchedSells).toBe(1);
    expect(r.complete).toBe(false);
    expect(Object.keys(r)).not.toContain('estTaxCzk');
  });

  it('converts to CZK at the purchase-day and sale-day rates', () => {
    const r = buildRealizedReport(fifo.disposals, [], [], 2024, 'CZK', '2026-10-18');
    const aapl = r.rows.find((x) => x.ticker === 'AAPL')!;
    const buy = cnbUsdCzk('2023-03-01')!.rate, sell = cnbUsdCzk('2024-06-03')!.rate;
    expect(aapl.proceeds).toBeCloseTo(600 * sell);
    expect(aapl.cost).toBeCloseTo(400 * buy);
    expect(aapl.gain).toBeCloseTo(600 * sell - 400 * buy);
    expect(r.complete).toBe(true);
  });

  it('lists the years with activity, newest first', () => {
    // The 2023 projection alone does not make 2023 a year with activity.
    expect(realizedYears(fifo.disposals, divs, '2026-10-18')).toEqual([2026, 2025, 2024]);
  });

  it('keeps the disposals Disposal-shaped (shared FIFO)', () => {
    const d: Disposal = fifo.disposals[0];
    expect(d.ticker).toBe('AAPL');
  });
});
