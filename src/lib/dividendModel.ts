import { annualByTicker, dividendForecast, receivedLast12m, remainingThisMonth } from './dividendAnalytics';
import type { DividendRecord } from './dividendTax';
import type { LivePosition } from './portfolioTypes';

export interface DividendModel {
  forecast: ReturnType<typeof dividendForecast>;
  rest: ReturnType<typeof remainingThisMonth>;
  annual: Map<string, number>;
  annualTotal: number;
  received: ReturnType<typeof receivedLast12m>;
  next: ReturnType<typeof remainingThisMonth>[number] | null;
  today: string;
}

export function computeDividendModel({ dividends, positions, today }: {
  dividends: DividendRecord[]; positions: LivePosition[]; today: string;
}): DividendModel {
  const held = new Set(positions.filter(p => p.ticker !== 'CASH').map(p => p.ticker.toUpperCase().split('.')[0]));
  const forecast = dividendForecast(dividends, today, held);
  const rest = remainingThisMonth(dividends, today, held);
  const annual = annualByTicker(forecast, rest);
  const annualTotal = [...annual.values()].reduce((s, v) => s + v, 0);
  const received = receivedLast12m(dividends, today);
  const next = [...rest, ...forecast.flatMap(m => m.items)][0] ?? null;
  return { forecast, rest, annual, annualTotal, received, next, today };
}
