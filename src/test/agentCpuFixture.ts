import { runFifo } from '../lib/fifo.ts';
import type { FifoTx } from '../lib/fifo.ts';
import { buildSalesReport } from '../lib/czTax.ts';
import { buildPerformanceSeries } from '../lib/performanceSeries.ts';
import { computePortfolio } from '../lib/portfolioModel.ts';
import type { PortfolioInput } from '../lib/portfolioModel.ts';
import { toDisplaySnapshots } from '../lib/snapshotFx.ts';
import { createCalculationCache, computeRealized, computeCzTaxModel, computeInternationalTaxModel, computeSaleModel,
  computePerformanceModel, summarizePerformance, computeDividendModel, computeAllocationModel } from '../lib/agentLib.ts';
import { calculateFairValue, valuationSeries, medianOf } from '../lib/agentLib.ts';
import { createInternationalFixture } from './agentPortfolioFixture.ts';
import type { Country } from '../lib/tax/engines.ts';
import type { CompanyFundamentals, FundamentalSeries } from '../types/fundamentals.ts';

export function createCpuFixture(count: number) {
  const start = Date.UTC(2024, 0, 1);
  const day = (index: number) => new Date(start + index * 86400000).toISOString().slice(0, 10);
  const transactions: FifoTx[] = [];
  const balances = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const scope = i % 24, round = Math.floor(i / 24);
    const split = round === 60;
    const sell = !split && round % 4 === 3;
    const shares = split ? balances.get(scope)! : sell ? 1 : 3;
    balances.set(scope, (balances.get(scope) ?? 0) + (sell ? -shares : shares));
    transactions.push({ id: `synthetic-${String(i).padStart(6, '0')}`, ticker: `SYN${scope % 8}`, broker: 'synthetic', broker_account: `fixture-${Math.floor(scope / 8)}`,
      side: sell ? 'SELL' : 'BUY', shares, price_usd: split ? 0 : 50 + scope + round / 10, fee_usd: split ? 0 : 0.1,
      executed_at: `${day(Math.floor(i * 731 / count))}T12:00:00Z`, ext_id: split ? `fixture:split:${i}` : null });
  }
  const snapshots = Array.from({ length: 731 }, (_, i) => ({ snapshot_date: day(i), value_usd: 10000 + i * 25,
    value_czk: (10000 + i * 25) * (22 + i / 1000), fx_rate: 22 + i / 1000, cash_usd: 500 + i % 30 }));
  const tradeFlowsUsd = new Map<string, number>();
  for (const tx of transactions) {
    const date = tx.executed_at.slice(0, 10);
    tradeFlowsUsd.set(date, (tradeFlowsUsd.get(date) ?? 0) + (tx.side === 'BUY' ? 1 : -1) * tx.shares * tx.price_usd + (tx.fee_usd ?? 0));
  }
  return { transactions, snapshots, tradeFlowsUsd };
}

export function computeCpuFixture(fixture: ReturnType<typeof createCpuFixture>) {
  const fifo = runFifo(fixture.transactions);
  const sales = buildSalesReport(fifo.disposals, 2025, undefined, fifo.warnings);
  const performance = buildPerformanceSeries({ snapshots: fixture.snapshots, tradeFlowsUsd: fixture.tradeFlowsUsd,
    benchAt: date => 4000 + (Date.parse(date) - Date.UTC(2024, 0, 1)) / 86400000, currency: 'CZK', fallbackFx: 22 });
  return { fifo, sales, performance };
}

export function createPortfolioCpuFixture(count: number) {
  const fixture = createCpuFixture(count);
  const fifo = runFifo(fixture.transactions);
  const shares = new Map<string, number>();
  for (const lot of fifo.openLots) shares.set(lot.ticker, (shares.get(lot.ticker) ?? 0) + lot.shares);
  const fx = { code: 'CZK' as const, perCzkAt: () => 1, perCzkToday: 1 };
  const portfolio: PortfolioInput = {
    positions: [...shares, ['CASH', 500] as const].map(([ticker, quantity]) => ({ id: ticker, ticker, name: ticker,
      type: ticker === 'CASH' ? 'Cash' : 'Stock', shares: quantity, avg_cost_usd: ticker === 'CASH' ? 1 : 60, sector: null, holding_start_date: null })),
    transactions: fixture.transactions.map(t => ({ ...t, fee_usd: t.fee_usd ?? 0, note: null })),
    snapshots: toDisplaySnapshots(fixture.snapshots.map(s => ({ ...s, fxBasis: 'raw-czk', profit_usd: 0, profit_czk: 0, profit_pct: 0 })), fx),
    prices: Object.fromEntries([...shares.keys()].map(ticker => [ticker, { price: 100, changePct: 1, prevClose: 99 }])),
    t212Summary: null, dividends: [], usdCzk: 25, fx,
  };
  return { ...fixture, portfolio };
}

export function computePortfolioCpuFixture(fixture: ReturnType<typeof createPortfolioCpuFixture>) {
  return { ...computeCpuFixture(fixture), portfolio: computePortfolio(fixture.portfolio) };
}

export function createAnalyticsCpuFixture(count: number) {
  const fixture = createPortfolioCpuFixture(count);
  fixture.portfolio.dividends = Array.from({ length: 24 }, (_, i) => ({ id: `synthetic-div-${i}`, ticker: `SYN${i % 8}`,
    ex_date: `2025-${String(i % 12 + 1).padStart(2, '0')}-10`, pay_date: `2025-${String(i % 12 + 1).padStart(2, '0')}-15`,
    amount_per_share: 1, shares_held: 10, total_amount_usd: 10, status: 'paid', broker: 'manual' }));
  fixture.portfolio.dividends.push({ ...fixture.portfolio.dividends[0], id: 'synthetic-forecast', pay_date: '2026-01-15', broker: 'auto' });
  const registry = { positions: fixture.portfolio.positions, aliases: [], profiles: [] };
  const countries: Country[] = ['SK', 'PL', 'DE', 'GB', 'US'];
  const international = countries.map(residence => {
    const original = createInternationalFixture(residence).storedProfiles.profiles[`${residence}-2026`];
    return { transactions: fixture.portfolio.transactions, dividends: fixture.portfolio.dividends, registry, residence, year: 2025, today: '2025-12-31',
      storedProfiles: { profiles: { [`${residence}-2025`]: { ...original, year: 2025 } } } };
  });
  const fundamentals: CompanyFundamentals = { symbol: 'SYN0', currency: 'USD', status: 'ok', fetchedAt: '2025-12-31T12:00:00Z',
    annual: { periods: ['2022-12-31', '2023-12-31', '2024-12-31'], values: { revenue: [1000, 1100, 1200],
      freeCashFlow: [80, 100, 120], dilutedEps: [1, 2, 3], dilutedShares: [10, 10, 10], equity: [200, 250, 300],
      cash: [20, 30, 40], totalDebt: [10, 10, 15], dividendsPaid: [-10, -15, -20] } as FundamentalSeries['values'] },
    quarterly: { periods: [], values: {} as FundamentalSeries['values'] } };
  const closes = fixture.snapshots.map((s, i) => ({ date: s.snapshot_date, close: 100 + i / 10 }));
  return { ...fixture, registry, international, fundamentals, closes };
}

export function computeAnalyticsCpuFixture(fixture: ReturnType<typeof createAnalyticsCpuFixture>) {
  const cache = createCalculationCache();
  const portfolio = cache.model(computePortfolio, fixture.portfolio);
  if (cache.model(computePortfolio, fixture.portfolio) !== portfolio) throw new Error('Model cache not reused');
  const common = { transactions: fixture.portfolio.transactions, dividends: fixture.portfolio.dividends, positions: portfolio.positions,
    registry: fixture.registry, year: 2025, today: '2025-12-31', usdCzk: 25,
    settings: { fxMethod: 'cnb-daily' as const, limitIncludesExempt: true }, currency: 'USD' as const };
  const realized = cache.model(computeRealized, common);
  const cz = cache.model(computeCzTaxModel, common);
  if (realized.fifo !== cz.fifo) throw new Error('Compatible FIFO not reused');
  const performance = computePerformanceModel({ ...common, portfolio, snapshots: fixture.portfolio.snapshots,
    benchmark: fixture.snapshots.map((s, i) => ({ date: s.snapshot_date, close_value: 4000 + i })) });
  const summary = summarizePerformance(performance, { from: '2024-01-01', to: common.today });
  const dividends = computeDividendModel(common);
  const allocation = computeAllocationModel({ positions: portfolio.positions, dbPositions: fixture.portfolio.positions,
    profiles: new Map(), quoteCurrencies: {} });
  const sale = { ticker: 'SYN0', broker: 'synthetic', account: 'fixture-0', shares: 1, priceUsd: 100,
    feeUsd: 0, at: '2025-12-31T15:00:00Z', saleFx: 25 };
  const czSale = computeSaleModel({ jurisdiction: 'CZ', model: cz, transactions: common.transactions, sale });
  const international = fixture.international.map(input => {
    const model = computeInternationalTaxModel(input);
    if (model.status !== 'ready') throw new Error('International benchmark input rejected');
    return { model, sale: computeSaleModel({ jurisdiction: input.residence, model,
      sale: { ...sale, assumedLocalFx: input.residence === 'US' ? 1 : 0.9 } }) };
  });
  const valuation = calculateFairValue(fixture.fundamentals, 100, undefined, fixture.closes);
  const medianPe = medianOf(valuationSeries(fixture.fundamentals, fixture.closes), 'pe');
  return { portfolio, realized, sales: cz.report, performance: performance.points, summary, dividends, allocation, czSale, international, valuation, medianPe };
}
