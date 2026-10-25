import { isCashPosition } from './portfolioModel';
import { resolveSector, type TickerProfileMap } from './tickerProfileModel';
import type { DbPosition, LivePosition } from './portfolioTypes';

export interface AllocationModel {
  sectors: { name: string; value: number; pct: number }[];
  assetTypes: { name: string; value: number; pct: number }[];
  currencies: { name: string; value: number; pct: number }[];
  top5: { ticker: string; pct: number }[];
  hhi: number;
  denominatorUsd: number;
  warnings: string[];
}

export function computeAllocationModel({ positions, dbPositions, profiles, quoteCurrencies }: {
  positions: LivePosition[]; dbPositions: DbPosition[]; profiles: TickerProfileMap; quoteCurrencies: Record<string, string | null>;
}): AllocationModel {
  const invested = positions.filter(p => !isCashPosition(p));
  const denominatorUsd = invested.reduce((sum, p) => sum + p.value, 0);
  const manual = new Map(dbPositions.map(p => [p.ticker.toUpperCase(), p.sector]));
  const group = (key: (p: LivePosition) => string) => {
    const values = new Map<string, number>();
    for (const p of invested) values.set(key(p), (values.get(key(p)) ?? 0) + p.value);
    return [...values].map(([name, value]) => ({ name, value, pct: denominatorUsd > 0 ? value / denominatorUsd * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  };
  const currencies = group(p => quoteCurrencies[p.ticker]?.trim().toUpperCase() || 'unknown');
  const tickers = group(p => p.ticker);
  return { sectors: group(p => resolveSector(p.ticker, manual.get(p.ticker.toUpperCase()), profiles)),
    assetTypes: group(p => p.type || 'unknown'), currencies,
    top5: tickers.slice(0, 5).map(p => ({ ticker: p.name, pct: p.pct })),
    hhi: tickers.reduce((sum, p) => sum + (p.pct / 100) ** 2, 0), denominatorUsd,
    warnings: ['quote-currency-not-economic-exposure', ...(currencies.some(p => p.name === 'unknown') ? ['unknown-quote-currency'] : [])] };
}
