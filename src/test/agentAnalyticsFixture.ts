import { portfolioGolden } from './agentPortfolioFixture';
import type { DisplaySnapshot, LivePosition } from '../lib/portfolioTypes';
import type { DividendRecord } from '../lib/dividendTax';

export const analyticsToday = '2026-10-23';
export function analyticsPosition(ticker: string, value: number): LivePosition {
  return { ...portfolioGolden.positions[0], ticker, value, type: ticker === 'CASH' ? 'Cash' : 'Stock' };
}
export function analyticsSnapshot(date: string, value: number, cash: number | null, rate = 1): DisplaySnapshot {
  return { snapshot_date: date, value_usd: value, value_czk: value * rate, fx_rate: rate,
    cash_usd: cash, profit_usd: 0, profit_czk: 0, profit_pct: 0, fxBasis: 'display', displayCurrency: 'EUR' };
}
export function analyticsDividend(overrides: Partial<DividendRecord> = {}): DividendRecord {
  return { id: 'synthetic-income', ticker: 'SYN', ex_date: '2026-10-01', pay_date: '2026-10-22',
    amount_per_share: 85, shares_held: 1, total_amount_usd: 85, status: 'paid', broker: 'manual', ...overrides };
}
export function analyticsFixture() {
  return { today: analyticsToday, snapshots: [analyticsSnapshot('2026-10-22', 100, 20, 0.8),
    analyticsSnapshot(analyticsToday, 105, 20, 0.9)],
  portfolio: { ...portfolioGolden, positions: [analyticsPosition('SYN', 110), analyticsPosition('CASH', 20)],
    totalValue: 130, usdLocal: 0.9 }, transactions: [], dividends: [],
  benchmark: [{ date: '2026-10-22', close_value: 100 }, { date: analyticsToday, close_value: 105 }] };
}
