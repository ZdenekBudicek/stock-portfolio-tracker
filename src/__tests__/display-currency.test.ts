import { describe, expect, it } from 'vitest';
import { compactMoney, createCzkPer, formatMoney, localFx, normalizeDisplayCurrency, symbolOf, wrapSymbol } from '@/lib/displayCurrency';
import { computeNetDeposits } from '@/lib/netDeposits';

const table = { rates: {
  '2024-01-02': { USD: 22.5, EUR: 24.75, GBP: 28.5, PLN: 5.7 },
  '2024-06-03': { USD: 22.8, EUR: 24.7, GBP: 29.0, PLN: 5.75 },
  '2025-01-02': { USD: 24.2, EUR: 25.2, GBP: 30.3, PLN: 5.9 },
} };
const per = createCzkPer(table);

describe('display currency rates', () => {
  it('takes the last ČNB rate on or before the day, the first before the series and the latest for today', () => {
    expect(per('EUR', '2024-03-15')).toBe(24.75);
    expect(per('EUR', '2024-06-03')).toBe(24.7);
    expect(per('EUR', '2023-05-01')).toBe(24.75);
    expect(per('EUR')).toBe(25.2);
    expect(per('CZK', '2024-03-15')).toBe(1);
  });

  it('converts koruny into the local currency at the rate of the same day', () => {
    const fx = localFx('EUR', per);
    expect(fx.perCzkAt('2024-06-03T10:00:00Z')).toBeCloseTo(1 / 24.7, 12);
    expect(fx.perCzkToday).toBeCloseTo(1 / 25.2, 12);
    expect(localFx('CZK', per).perCzkAt('2024-06-03')).toBe(1);
  });

  it('a purchase in euros uses the purchase-day cross rate, so the gain includes the currency move', () => {
    // $1 000 bought on 2024-01-02, still worth $1 000 on 2025-01-02.
    const fx = localFx('EUR', per);
    const costEur = 1000 * 22.5 * fx.perCzkAt('2024-01-02');   // USD→CZK that day, then CZK→EUR that day
    const valueEur = 1000 * 24.2 * fx.perCzkToday;
    expect(costEur).toBeCloseTo(909.09, 2);
    expect(valueEur).toBeCloseTo(960.32, 2);
    expect(valueEur - costEur).toBeGreaterThan(0); // the dollar rose against the euro
  });

  it('normalizes unknown codes to the fallback', () => {
    expect(normalizeDisplayCurrency('eur')).toBe('EUR');
    expect(normalizeDisplayCurrency('CHF')).toBe('CZK');
    expect(normalizeDisplayCurrency(null, 'USD')).toBe('USD');
  });
});

describe('formatting', () => {
  it('writes each currency the way it is usually written', () => {
    expect(formatMoney(1234.5, 'USD', 'en')).toBe('$1,234.50');
    expect(formatMoney(1234.5, 'USD', 'cs')).toBe('$1,234.50');
    expect(formatMoney(-1234.5, 'EUR', 'en')).toBe('-€1,234.50');
    expect(formatMoney(1234.5, 'GBP', 'en')).toBe('£1,234.50');
    expect(formatMoney(1234.4, 'CZK', 'en')).toBe('CZK 1,234');
    expect(formatMoney(1234.5, 'EUR', 'cs').replace(/\s/g, ' ')).toBe('1 234,50 €');
    expect(formatMoney(1234.4, 'CZK', 'cs').replace(/\s/g, ' ')).toBe('1 234 Kč');
    expect(formatMoney(12, 'PLN', 'cs', { signed: true })).toBe('+12,00 zł');
    expect(formatMoney(1234.5, 'GBP', 'cs').replace(/\s/g, ' ')).toBe('1 234,50 £');
    expect(wrapSymbol('••••', 'EUR', 'cs')).toBe('•••• €');
    expect(symbolOf('PLN', 'en')).toBe('PLN');
    expect(compactMoney(60630, 'USD', 'en')).toBe('$60.6K');
  });
});

describe('net deposits in another local currency', () => {
  it('converts a koruna T212 account at today\'s cross rate and USD flows at their day\'s USD→local', () => {
    const k = 1 / 25; // EUR per CZK today
    const out = computeNetDeposits({
      txs: [{ ticker: 'CASH', side: 'BUY', shares: 1, price_usd: 100, executed_at: '2024-06-03T10:00:00Z', broker: 'manual', broker_account: null }] as import("@/hooks/usePortfolio").DbTransaction[],
      t212: { total: 30000, ppl: 2000, result: 3000, currency: 'CZK', account: 'A' } as import("@/lib/brokerSummary").BrokerSummary,
      usdCzk: 24, localPerCzk: k,
      fxAt: () => 0.92, // USD→EUR on the flow's day
    });
    expect(out.usd).toBeCloseTo(100 + 25000 / 24, 6);
    expect(out.czk).toBeCloseTo(92 + 25000 * k, 6);
  });
});
