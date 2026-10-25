import type { AllocationModel, ComputedPortfolio, DbTransaction, DisplaySnapshot, DividendModel, LivePosition, LocalFx,
  PerformanceSummary, RealizedYear } from '../../_lib/trackora-lib.js';
import { calculationCache, memo, requestRead, toolRead } from '../context.ts';
import type { Loaded, PortfolioSnapshot, Scope } from '../dataTypes.ts';
import { type MarketValue, type Quote, RETRIEVAL_TIME_NOTE } from '../marketTypes.ts';
import { type Fact, type Freshness, ToolInputError, type ToolCtx } from '../types.ts';
import { arrayOf, checkPeriod, checkPeriodYears, compute, dateSchema, defineTool, ensureWithinLimits, factSchema, factSink, MAX_ROWS,
  mapLimit, meta, num, numOrNull, object, open, parseWith, QUOTE_CONCURRENCY, periodOf, quoteSchema, resolveTicker, scopeMatches, scopeSchema, slug,
  success, tickerSchema, unavailable, worst, yearsOf } from './common.ts';

/** The UI's computed portfolio over this request's snapshot, live quotes and FX — computed once per request. */
export type Priced = {
  loaded: Loaded<PortfolioSnapshot>; portfolio: ComputedPortfolio; fx: LocalFx; snapshots: DisplaySnapshot[];
  quotes: Map<string, MarketValue<Quote>>; usdCzk: { value: number; source: string; as_of: string | null };
  warnings: string[]; freshness: Freshness; complete: boolean; valuationFallback?: 'close' | 'cost';
};

export function pricedPortfolio(ctx: ToolCtx): Promise<Priced> {
  return memo(ctx, 'priced', async () => {
    const loaded = await ctx.loadSnapshot();
    const snap = loaded.data;
    ensureWithinLimits(ctx, snap);
    const read = requestRead(ctx), local = ctx.preferences.localCurrency;
    const tickers = [...new Set(snap.positions.filter(p => !ctx.lib.isCashPosition(p)).map(p => p.ticker))];
    const [quoteList, fxQuote, localQuote] = await Promise.all([
      mapLimit(tickers, QUOTE_CONCURRENCY, t => ctx.market.quote(t, read)),
      ctx.market.quote('USDCZK', read),
      local === 'CZK' ? Promise.resolve(null) : ctx.market.quote(`${local}CZK`, read),
    ]);
    const warnings = [...loaded.meta.warnings];
    const quotes = new Map(tickers.map((t, i) => [t, quoteList[i]]));
    const prices: Record<string, { price: number; changePct: number; prevClose: number | null }> = {};
    let freshness: Freshness = 'fresh', valuationFallback: Priced['valuationFallback'];
    for (const [ticker, quote] of quotes) {
      if (!quote.data) {
        // Without a price the model values the position at cost, exactly as the UI does; it is flagged.
        warnings.push(`quote_missing:${ticker}`); valuationFallback = 'cost'; freshness = worst(freshness, 'stale');
        continue;
      }
      if (quote.data.currency !== 'USD') {
        // The model and every money fact are USD: a price in another currency is never taken as USD. The market
        // source normalizes what the UI normalizes (marketTypes usdQuoteCurrency); anything left is unpriced.
        warnings.push(`quote_currency_unsupported:${ticker}:${quote.data.currency}`); valuationFallback = 'cost';
        freshness = worst(freshness, 'stale');
        continue;
      }
      prices[ticker] = { price: quote.data.price, changePct: quote.data.changePct ?? 0, prevClose: quote.data.previousClose };
      if (quote.data.kind === 'close' && valuationFallback !== 'cost') valuationFallback = 'close';
      if (!quote.asOf) warnings.push(`quote_time_unknown:${ticker}`);
      if (quote.source === 'price_cache') warnings.push(RETRIEVAL_TIME_NOTE);
      if (quote.freshness !== 'fresh') { warnings.push(`quote_stale:${ticker}`); freshness = worst(freshness, 'stale'); }
    }
    // USD/CZK: the cached market rate, else the newest snapshot's own rate (dated); never a constant.
    const lastFx = [...snap.snapshots].reverse().find(s => Number(s.fx_rate) > 0);
    const usdCzk = fxQuote.data && fxQuote.data.price > 0 ? { value: fxQuote.data.price, source: fxQuote.source, as_of: fxQuote.asOf }
      : lastFx ? { value: Number(lastFx.fx_rate), source: 'daily_snapshots', as_of: lastFx.snapshot_date } : null;
    if (!usdCzk) return unavailable('No USD/CZK rate is available.');
    if (!fxQuote.data) {
      warnings.push('usdczk_from_snapshot');
      // A snapshot rate is the rate of its own day: older than a long weekend it is not today's rate.
      const age = usdCzk.as_of ? (Date.parse(ctx.today) - Date.parse(usdCzk.as_of)) / 86_400_000 : NaN;
      if (!(age <= 4)) { warnings.push('usdczk_stale'); freshness = worst(freshness, 'stale'); }
    }
    else if (fxQuote.source === 'price_cache') warnings.push(RETRIEVAL_TIME_NOTE);
    if (fxQuote.data && fxQuote.freshness !== 'fresh') { warnings.push('usdczk_stale'); freshness = worst(freshness, 'stale'); }
    const fx = ctx.lib.localFx(local, ctx.lib.czkPer, localQuote?.data?.price);
    const snapshots = ctx.lib.toDisplaySnapshots(snap.snapshots, fx);
    const portfolio = compute(ctx, snap, 'portfolio', ['fifo_all', 'fifo_real', 'portfolio'], () => ctx.lib.computePortfolio({ positions: snap.positions, prices, transactions: snap.transactions,
      snapshots, t212Summary: snap.brokerSummary, dividends: snap.dividends, usdCzk: usdCzk.value, fx }, calculationCache(ctx)));
    return { loaded, portfolio, fx, snapshots, quotes, usdCzk, warnings, freshness, valuationFallback,
      complete: loaded.meta.complete && valuationFallback !== 'cost' };
  });
}

const brokerName = (r: { broker?: string | null; ext_id?: string | null }, lib: ToolCtx['lib']) => lib.brokerOf(r);
/** A named account must exist in the ledger; otherwise the caller is asked which one was meant. */
export function requireScope(ctx: ToolCtx, transactions: readonly DbTransaction[], scope: Scope | undefined) {
  if (!scope || 'all' in scope) return;
  if (transactions.some(t => scopeMatches(scope, brokerName(t, ctx.lib), t.broker_account))) return;
  const accounts = [...new Set(transactions.map(t => JSON.stringify([brokerName(t, ctx.lib), t.broker_account || ''])))].sort();
  throw new ToolInputError('clarify', 'Choose an existing account.', accounts.map((value, i) => {
    const [broker, account] = JSON.parse(value) as [string, string];
    return { id: `choice_${i + 1}`, broker, account };
  }));
}

/* ----------------------------- get_portfolio_summary ----------------------------- */

type Summary = Pick<ComputedPortfolio, 'totalValue' | 'netDepositsUsd' | 'totalProfit' | 'unrealizedProfit'> & { cashUsd: number; usdCzk: number | null; usdLocal: number | null };
const summary = defineTool<Record<string, never>, Summary>({
  name: 'get_portfolio_summary', group: 'portfolio',
  description: 'Current portfolio totals in USD as the Trackora overview computes them: value, net deposits, total and unrealized profit, cash, USD/CZK and USD/local rates.',
  inputSchema: object({}), parse: parseWith(object({})),
  outputSchema: open({ totalValue: num, netDepositsUsd: numOrNull, totalProfit: num, unrealizedProfit: num, usdCzk: numOrNull, usdLocal: numOrNull, cashUsd: num },
    ['totalValue', 'netDepositsUsd', 'totalProfit', 'unrealizedProfit', 'usdCzk', 'usdLocal', 'cashUsd']),
  async run(_args, ctx) {
    const loaded = await ctx.loadSnapshot(), snap = loaded.data;
    if (!snap.positions.length && !snap.transactions.length && !snap.snapshots.length && !snap.dividends.length && !snap.deposits.length && !snap.brokerSummary) {
      const warnings = [...loaded.meta.warnings], sink = factSink(ctx, warnings);
      const base = { source: 'portfolio_model', as_of: loaded.meta.asOf };
      sink.add('portfolio:holding_count', 0, 'count', base);
      for (const key of ['total_value', 'net_deposits', 'total_profit', 'unrealized_profit', 'cash']) sink.add(`portfolio:${key}`, 0, 'money', { ...base, currency: 'USD' });
      return success(ctx, { totalValue: 0, netDepositsUsd: 0, totalProfit: 0, unrealizedProfit: 0, cashUsd: 0, usdCzk: null, usdLocal: null },
        sink.facts, meta({ snapshotId: loaded.meta.snapshotId, complete: loaded.meta.complete, warnings }));
    }
    const p = await pricedPortfolio(ctx);
    const m = p.portfolio;
    const data: Summary = { totalValue: m.totalValue, netDepositsUsd: m.netDepositsUsd, totalProfit: m.totalProfit,
      unrealizedProfit: m.unrealizedProfit, usdCzk: m.usdCzk, usdLocal: m.usdLocal,
      cashUsd: m.positions.find(x => ctx.lib.isCashPosition(x))?.value ?? 0 };
    const warnings = [...p.warnings], sink = factSink(ctx, warnings);
    const base = { source: 'portfolio_model', as_of: p.loaded.meta.asOf, currency: 'USD' };
    sink.add('portfolio:total_value', data.totalValue, 'money', base);
    sink.add('portfolio:net_deposits', data.netDepositsUsd, 'money', base);
    sink.add('portfolio:total_profit', data.totalProfit, 'money', base);
    sink.add('portfolio:unrealized_profit', data.unrealizedProfit, 'money', base);
    sink.add('portfolio:cash', data.cashUsd, 'money', base);
    sink.add('portfolio:usd_czk', data.usdCzk, 'ratio', { source: p.usdCzk.source, as_of: p.usdCzk.as_of });
    sink.add('portfolio:usd_local', data.usdLocal, 'ratio', { source: p.usdCzk.source, as_of: p.usdCzk.as_of });
    return success(ctx, data, sink.facts, meta({ snapshotId: p.loaded.meta.snapshotId, complete: p.complete, warnings,
      freshness: p.freshness, valuationFallback: p.valuationFallback }));
  },
});

/* ----------------------------- get_holdings ----------------------------- */

const positionSchema = open({ ticker: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, shares: num, avgPrice: num,
  currentPrice: num, invested: num, value: num, profitUsd: num, profitPct: num, allocation: num }, ['ticker', 'shares', 'value', 'allocation']);
type HoldingsArgs = { assetType?: 'stock' | 'etf' | 'crypto'; ticker?: string; dayChange?: boolean };
const holdingsInput = object({ assetType: { type: 'string', enum: ['stock', 'etf', 'crypto'] }, ticker: tickerSchema, dayChange: { type: 'boolean' } });
const holdings = defineTool<HoldingsArgs, { rows: LivePosition[]; totalRows: number }>({
  name: 'get_holdings', group: 'portfolio',
  description: 'Open positions with shares, cost, value, profit and allocation (percent of total value), optionally filtered by asset type or one ticker. At most 50 rows; totalRows counts all. dayChange adds the change today per position and for the portfolio, largest moves first.',
  inputSchema: holdingsInput, parse: parseWith(holdingsInput),
  outputSchema: open({ rows: arrayOf(positionSchema, MAX_ROWS), totalRows: { type: 'integer', minimum: 0 } }, ['rows', 'totalRows']),
  async run(args, ctx) {
    const loaded = await ctx.loadSnapshot();
    if (!loaded.data.positions.length) {
      if (args.ticker) await resolveTicker(ctx, args.ticker);
      const warnings = [...loaded.meta.warnings], sink = factSink(ctx, warnings);
      sink.add('portfolio:holding_count', 0, 'count', { source: 'portfolio_model', as_of: loaded.meta.asOf });
      return success(ctx, { rows: [], totalRows: 0 }, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, complete: loaded.meta.complete, warnings }));
    }
    const p = await pricedPortfolio(ctx);
    const ticker = args.ticker ? (await resolveTicker(ctx, args.ticker)).ticker : undefined;
    const { kindOf } = ctx.lib.resolveTaxIdentity(p.loaded.data.registry);
    const filtered = p.portfolio.positions.filter(row => (!args.assetType || (!ctx.lib.isCashPosition(row) && kindOf(row.ticker) === args.assetType))
      && (!ticker || row.ticker.toUpperCase() === ticker));
    // Today's change exists only for a priced position whose quote has a previous close; the rest is never a silent zero.
    const moved = (row: LivePosition) => {
      const quote = p.quotes.get(row.ticker)?.data;
      return !ctx.lib.isCashPosition(row) && !!quote && quote.currency === 'USD' && typeof quote.previousClose === 'number' && quote.previousClose > 0;
    };
    // Largest absolute moves first, so the 50-row cut never hides a big mover.
    const rows = args.dayChange ? [...filtered].sort((a, b) => Number(moved(b)) - Number(moved(a)) || Math.abs(b.dailyChangeUsd) - Math.abs(a.dailyChangeUsd)) : filtered;
    const shown = rows.slice(0, MAX_ROWS);
    const warnings = [...p.warnings], sink = factSink(ctx, warnings);
    for (const row of shown) {
      const base = { source: 'portfolio_model', as_of: p.loaded.meta.asOf, currency: 'USD', ticker: row.ticker };
      sink.add(`holding:${row.ticker}:value`, row.value, 'money', base);
      sink.add(`holding:${row.ticker}:shares`, row.shares, 'shares', { ...base, currency: null });
      sink.add(`holding:${row.ticker}:profit`, row.profitUsd, 'money', base);
      sink.add(`holding:${row.ticker}:allocation`, row.allocation, 'percent', { ...base, currency: null });
      if (args.dayChange && moved(row)) {
        sink.add(`holding:${row.ticker}:day_change`, row.dailyChangeUsd, 'money', base);
        sink.add(`holding:${row.ticker}:day_change_pct`, row.dailyChangePct, 'percent', { ...base, currency: null });
      } else if (args.dayChange && !ctx.lib.isCashPosition(row)) warnings.push(`day_change_missing:${row.ticker}`);
    }
    if (args.dayChange && !ticker && !args.assetType) {
      // The portfolio's day is the sum of its positions' days; a position without one makes the sum incomplete.
      const partial = p.portfolio.positions.some(row => !ctx.lib.isCashPosition(row) && !moved(row));
      const change = p.portfolio.dailyReturn, start = p.portfolio.totalValue - change;
      const base = { source: 'portfolio_model', as_of: p.loaded.meta.asOf, currency: 'USD' };
      const facts = [sink.add('portfolio:day_change', change, 'money', base),
        start > 0 ? sink.add('portfolio:day_change_pct', change / start * 100, 'percent', { ...base, currency: null }) : null];
      if (partial) for (const f of facts) if (f) f.quality = { state: 'incomplete', freshness: p.freshness };
    }
    return success(ctx, { rows: shown, totalRows: rows.length }, sink.facts, meta({ snapshotId: p.loaded.meta.snapshotId, complete: p.complete,
      warnings, omittedRows: rows.length - shown.length, freshness: p.freshness, valuationFallback: p.valuationFallback }));
  },
});

/* ----------------------------- get_transactions ----------------------------- */

type TxArgs = { from: string; to: string; ticker?: string; side?: 'BUY' | 'SELL'; scope?: Scope };
type TxData = { boughtShares: number; soldShares: number; buyUsd: number; sellUsd: number; feesUsd: number; rows: DbTransaction[]; totalRows: number };
const txInput = object({ from: dateSchema, to: dateSchema, ticker: tickerSchema, side: { type: 'string', enum: ['BUY', 'SELL'] }, scope: scopeSchema }, ['from', 'to']);
const transactions = defineTool<TxArgs, TxData>({
  name: 'get_transactions', group: 'portfolio',
  description: 'Real trades in a date period (optionally one ticker, side or account) with total bought/sold shares, USD amounts and fees over ALL matching trades; at most 50 newest rows.',
  inputSchema: txInput, parse: parseWith(txInput, checkPeriod),
  outputSchema: open({ boughtShares: num, soldShares: num, buyUsd: num, sellUsd: num, feesUsd: num,
    rows: arrayOf(open({ ticker: { type: 'string' }, side: { enum: ['BUY', 'SELL'] }, shares: num, price_usd: num }, ['ticker', 'side', 'shares']), MAX_ROWS),
    totalRows: { type: 'integer', minimum: 0 } }, ['boughtShares', 'soldShares', 'buyUsd', 'sellUsd', 'feesUsd', 'rows', 'totalRows']),
  async run(args, ctx) {
    const loaded = await ctx.loadSnapshot();
    const ticker = args.ticker ? (await resolveTicker(ctx, args.ticker)).ticker : undefined;
    const trades = loaded.data.transactions.filter(t => ctx.lib.isRealTradeTx(t));
    requireScope(ctx, trades, args.scope);
    const rows = trades.filter(t => t.executed_at.slice(0, 10) >= args.from && t.executed_at.slice(0, 10) <= args.to
      && (!ticker || t.ticker.toUpperCase() === ticker) && (!args.side || t.side === args.side)
      && scopeMatches(args.scope, brokerName(t, ctx.lib), t.broker_account));
    const data: TxData = { boughtShares: 0, soldShares: 0, buyUsd: 0, sellUsd: 0, feesUsd: 0, rows: [], totalRows: rows.length };
    for (const t of rows) {
      if (t.side === 'BUY') { data.boughtShares += t.shares; data.buyUsd += t.shares * t.price_usd; }
      else { data.soldShares += t.shares; data.sellUsd += t.shares * t.price_usd; }
      data.feesUsd += t.fee_usd ?? 0;
    }
    data.rows = [...rows].sort((a, b) => b.executed_at.localeCompare(a.executed_at)).slice(0, MAX_ROWS);
    const warnings = [...loaded.meta.warnings];
    const excluded = loaded.data.transactions.length - trades.length;
    if (excluded) warnings.push(`non_trade_rows_excluded:${excluded}`);
    const sink = factSink(ctx, warnings), period = periodOf(args), key = `transactions:${ticker ?? 'all'}`;
    const base = { source: 'transactions', as_of: loaded.meta.asOf, ticker, period };
    sink.add(`${key}:bought_shares`, data.boughtShares, 'shares', base);
    sink.add(`${key}:sold_shares`, data.soldShares, 'shares', base);
    sink.add(`${key}:buy_usd`, data.buyUsd, 'money', { ...base, currency: 'USD' });
    sink.add(`${key}:sell_usd`, data.sellUsd, 'money', { ...base, currency: 'USD' });
    sink.add(`${key}:fees_usd`, data.feesUsd, 'money', { ...base, currency: 'USD' });
    sink.add(`${key}:count`, rows.length, 'count', base);
    sink.add(`${key}:buy_count`, rows.filter(t => t.side === 'BUY').length, 'count', base);
    sink.add(`${key}:sell_count`, rows.filter(t => t.side === 'SELL').length, 'count', base);
    return success(ctx, data, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, scope: args.scope, period, complete: loaded.meta.complete,
      warnings, omittedRows: rows.length - data.rows.length }));
  },
});

/* ----------------------------- get_performance ----------------------------- */

type PerfData = PerformanceSummary & { best: Fact[]; worst: Fact[] };
const perfInput = object({ from: dateSchema, to: dateSchema, benchmark: { type: 'string', enum: ['SPX'] } }, ['from', 'to']);
const performance = defineTool<{ from: string; to: string; benchmark?: 'SPX' }, PerfData>({
  name: 'get_performance', group: 'portfolio',
  description: 'Time-weighted portfolio return for a period as on the Returns screen (ratios, 0.1 = 10 %), annualized when at least a year, profit in the display currency, optional S&P 500 comparison, and best/worst held positions by price change.',
  inputSchema: perfInput, parse: parseWith(perfInput, checkPeriod),
  outputSchema: open({ portfolioReturn: numOrNull, benchmarkReturn: numOrNull, annualReturn: numOrNull, benchmarkAnnualReturn: numOrNull,
    profit: numOrNull, from: { type: 'string' }, to: { type: 'string' }, years: num, best: arrayOf(factSchema), worst: arrayOf(factSchema) },
  ['portfolioReturn', 'benchmarkReturn', 'profit', 'from', 'to', 'best', 'worst']),
  async run(args, ctx) {
    const p = await pricedPortfolio(ctx);
    const snap = p.loaded.data, period = periodOf(args), read = toolRead(ctx);
    const held = [...new Set(snap.positions.filter(x => !ctx.lib.isCashPosition(x) && x.shares > 0).map(x => x.ticker))];
    const [bench, histories] = await Promise.all([
      args.benchmark ? ctx.market.benchmark('SPX', { from: '1990-01-01', to: ctx.today }, read) : Promise.resolve(null),
      Promise.all(held.map(t => ctx.market.history(t, period, read))),
    ]);
    const model = compute(ctx, snap, `performance:${args.benchmark ?? 'none'}`, ['performance'], () => ctx.lib.computePerformanceModel({ snapshots: p.snapshots, portfolio: p.portfolio,
      transactions: snap.transactions, dividends: snap.dividends, benchmark: bench?.data ?? [], currency: ctx.preferences.displayCurrency, today: ctx.today }));
    const result = ctx.lib.summarizePerformance(model, period);
    const warnings = [...p.warnings, ...(bench?.warnings ?? []).map(w => `benchmark:${w}`), `return_quality:${result.quality.level}`];
    const sink = factSink(ctx, warnings);
    const changes: { ticker: string; change: number; from: string; to: string; source: string }[] = [];
    held.forEach((ticker, i) => {
      const points = histories[i].data ?? [];
      if (points.length < 2) { warnings.push(`position_history_missing:${ticker}`); return; }
      const first = points[0], last = points[points.length - 1];
      changes.push({ ticker, change: last.close / first.close - 1, from: first.date, to: last.date, source: histories[i].source });
    });
    changes.sort((a, b) => b.change - a.change);
    const factFor = (c: typeof changes[number]) => sink.add(`performance:${c.ticker}:price_change`, c.change, 'ratio',
      { source: c.source, as_of: c.to, ticker: c.ticker, period: { from: c.from, to: c.to } });
    const best = changes.slice(0, 3).map(factFor).filter((f): f is Fact => !!f);
    const worstFacts = changes.slice(-3).reverse().map(factFor).filter((f): f is Fact => !!f);
    const base = { source: 'performance_model', as_of: p.loaded.meta.asOf, period: { from: result.from, to: result.to } };
    sink.add('performance:portfolio_return', result.portfolioReturn, 'ratio', base);
    sink.add('performance:annual_return', result.annualReturn, 'ratio', base);
    sink.add('performance:profit', result.profit, 'money', { ...base, currency: ctx.preferences.displayCurrency });
    if (args.benchmark) {
      sink.add('performance:benchmark_return', result.benchmarkReturn, 'ratio', { ...base, ticker: 'SPX' });
      sink.add('performance:benchmark_annual_return', result.benchmarkAnnualReturn, 'ratio', { ...base, ticker: 'SPX' });
    }
    return success(ctx, { ...result, best, worst: worstFacts }, sink.facts, meta({ snapshotId: p.loaded.meta.snapshotId, period,
      complete: p.complete && result.portfolioReturn !== null && changes.length === held.length, warnings,
      freshness: worst(p.freshness, bench?.freshness ?? 'fresh'), valuationFallback: p.valuationFallback }));
  },
});

/* ----------------------------- get_allocation ----------------------------- */

const share = arrayOf(open({ name: { type: 'string' }, value: num, pct: num }, ['name', 'value', 'pct']));
const allocation = defineTool<Record<string, never>, AllocationModel>({
  name: 'get_allocation', group: 'portfolio',
  description: 'Allocation of invested money (cash excluded) by sector, asset type and quote currency, top 5 positions and concentration (HHI). Quote currency is not economic exposure.',
  inputSchema: object({}), parse: parseWith(object({})),
  outputSchema: open({ sectors: share, assetTypes: share, currencies: share, top5: arrayOf(open({ ticker: { type: 'string' }, pct: num })), hhi: num,
    denominatorUsd: num, warnings: arrayOf({ type: 'string' }) }, ['sectors', 'assetTypes', 'currencies', 'top5', 'hhi', 'denominatorUsd']),
  async run(_args, ctx) {
    const loaded = await ctx.loadSnapshot();
    if (!loaded.data.positions.length) {
      const warnings = [...loaded.meta.warnings], sink = factSink(ctx, warnings);
      sink.add('allocation:invested', 0, 'money', { source: 'allocation_model', as_of: loaded.meta.asOf, currency: 'USD' });
      return success(ctx, { sectors: [], assetTypes: [], currencies: [], top5: [], hhi: 0, denominatorUsd: 0, warnings: [] },
        sink.facts, meta({ snapshotId: loaded.meta.snapshotId, complete: loaded.meta.complete, warnings }));
    }
    const p = await pricedPortfolio(ctx);
    const snap = p.loaded.data;
    const profiles = ctx.lib.buildProfileMap(snap.registry.profiles.map(r => ({ ticker: r.ticker, sector: r.sector ?? null })), snap.registry.aliases);
    const quoteCurrencies = Object.fromEntries([...p.quotes].map(([t, q]) => [t, q.data?.currency ?? null]));
    const model = compute(ctx, snap, 'allocation', ['allocation'], () => ctx.lib.computeAllocationModel({ positions: p.portfolio.positions, dbPositions: snap.positions, profiles, quoteCurrencies }));
    const warnings = [...p.warnings, ...model.warnings], sink = factSink(ctx, warnings);
    const base = { source: 'allocation_model', as_of: p.loaded.meta.asOf };
    for (const [group, rows] of [['sector', model.sectors], ['asset_type', model.assetTypes], ['currency', model.currencies]] as const) {
      for (const row of rows) sink.add(`allocation:${group}:${slug(row.name)}`, row.pct, 'percent', base);
    }
    sink.add('allocation:hhi', model.hhi, 'ratio', base);
    sink.add('allocation:invested', model.denominatorUsd, 'money', { ...base, currency: 'USD' });
    return success(ctx, model, sink.facts, meta({ snapshotId: p.loaded.meta.snapshotId, complete: p.complete, warnings,
      freshness: p.freshness, valuationFallback: p.valuationFallback }));
  },
});

/* ----------------------------- get_dividends ----------------------------- */

type ForecastView = Omit<DividendModel, 'annual'> & { annual: Record<string, number> };
type DividendData = { received: RealizedYear['dividends'] | null; forecast: ForecastView | null };
type DividendArgs = { mode: 'received'; from: string; to: string } | { mode: 'forecast' };
const dividendInput = object({ mode: { type: 'string', enum: ['received', 'forecast'] }, from: dateSchema, to: dateSchema }, ['mode'], {
  oneOf: [object({ mode: { const: 'received' }, from: dateSchema, to: dateSchema }, ['mode', 'from', 'to']), object({ mode: { const: 'forecast' } }, ['mode'])],
});
const dividends = defineTool<DividendArgs, DividendData>({
  name: 'get_dividends', group: 'portfolio',
  description: 'Dividends: mode "received" sums recorded payments in a period (display currency) with gross, withheld and net USD; mode "forecast" projects the next 12 months for held positions. Assumed withholding is flagged.',
  inputSchema: dividendInput, parse: parseWith<DividendArgs>(dividendInput, a => { if (a.mode === 'received') { checkPeriod(a); checkPeriodYears(a); } }),
  outputSchema: open({ received: { anyOf: [open({ total: num, count: num, grossRecorded: num, projected: num }, ['total', 'count']), { type: 'null' }] },
    forecast: { anyOf: [open({ annualTotal: num }, ['annualTotal']), { type: 'null' }] } }, ['received', 'forecast']),
  async run(args, ctx) {
    if (args.mode === 'forecast') {
      const p = await pricedPortfolio(ctx);
      const snap = p.loaded.data;
      const model = compute(ctx, snap, 'dividend_forecast', ['dividend_forecast'], () => ctx.lib.computeDividendModel({ dividends: snap.dividends, positions: p.portfolio.positions, today: ctx.today }));
      const warnings = [...p.warnings, 'forecast_is_estimate'], sink = factSink(ctx, warnings);
      const base = { source: 'dividend_forecast', as_of: p.loaded.meta.asOf, currency: 'USD' };
      sink.add('dividends:forecast_annual', model.annualTotal, 'money', base);
      if (model.next) sink.add('dividends:next_pay_date', model.next.payDate, 'date', { ...base, currency: null, ticker: model.next.ticker });
      return success(ctx, { received: null, forecast: { ...model, annual: Object.fromEntries(model.annual) } }, sink.facts,
        meta({ snapshotId: p.loaded.meta.snapshotId, complete: p.complete, warnings, freshness: p.freshness }));
    }
    const loaded = await ctx.loadSnapshot();
    const snap = loaded.data, period = periodOf(args), currency = ctx.preferences.displayCurrency;
    ensureWithinLimits(ctx, snap);
    const payDate = (d: { pay_date: string | null; ex_date: string }) => d.pay_date ?? d.ex_date;
    const inPeriod = snap.dividends.filter(d => payDate(d) >= period.from && payDate(d) <= period.to);
    const received = { total: 0, count: 0, grossRecorded: 0, projected: 0 };
    let complete = loaded.meta.complete;
    // The whole per-year loop is one charge: refused up front, never stopped half way.
    const years = yearsOf(period);
    const reports = compute(ctx, snap, `dividends_received:${period.from}:${period.to}:${currency}`, ['fifo_real', ...years.map(() => 'realized_year' as const)],
      () => years.map(year => ctx.lib.computeRealized({ transactions: snap.transactions, dividends: inPeriod, year, currency,
        today: ctx.today }, calculationCache(ctx)).report));
    const dividendDays = new Set(inPeriod.map(payDate));
    for (const report of reports) {
      for (const key of ['total', 'count', 'grossRecorded', 'projected'] as const) received[key] += report.dividends[key];
      if (report.missingFx.some(d => dividendDays.has(d))) complete = false;
    }
    // Gross, withheld and net of the same recorded payments; an assumed withholding is visible, not hidden.
    const rows = inPeriod.filter(d => d.status === 'paid' && payDate(d) <= ctx.today && ctx.lib.isRecorded(d))
      .map(d => ctx.lib.dividendTaxRow(d, ctx.preferences.tax.fxMethod));
    const warnings = [...loaded.meta.warnings];
    if (rows.some(r => r.basis !== 'exact')) warnings.push('withholding_assumed');
    if (received.projected) warnings.push(`projections_excluded:${received.projected}`);
    const sink = factSink(ctx, warnings), base = { source: 'realized_model', as_of: loaded.meta.asOf, period };
    sink.add('dividends:received', received.total, 'money', { ...base, currency });
    sink.add('dividends:count', received.count, 'count', base);
    const usd = { ...base, source: 'dividend_tax', currency: 'USD' };
    sink.add('dividends:gross', rows.reduce((s, r) => s + r.grossUsd, 0), 'money', usd);
    sink.add('dividends:withheld', rows.reduce((s, r) => s + r.whtUsd, 0), 'money', usd);
    sink.add('dividends:net', rows.reduce((s, r) => s + r.netUsd, 0), 'money', usd);
    return success(ctx, { received, forecast: null }, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, period, complete, warnings }));
  },
});

/* ----------------------------- get_watchlist ----------------------------- */

type WatchRow = { ticker: string; targetPriceUsd: number | null; quote: Quote | null };
const watchlist = defineTool<Record<string, never>, { rows: WatchRow[] }>({
  name: 'get_watchlist', group: 'portfolio',
  description: 'Watched tickers with the user\'s target price (USD) and the current quote. Personal notes are never returned.',
  inputSchema: object({}), parse: parseWith(object({})),
  outputSchema: open({ rows: arrayOf(open({ ticker: { type: 'string' }, targetPriceUsd: numOrNull, quote: { anyOf: [quoteSchema, { type: 'null' }] } },
    ['ticker', 'targetPriceUsd', 'quote']), MAX_ROWS) }, ['rows']),
  async run(_args, ctx) {
    const loaded = await ctx.loadSnapshot();
    const entries = loaded.data.watchlist.slice(0, MAX_ROWS), read = toolRead(ctx);
    // Only the ticker leaves the request; the user's note stays in the database row.
    const quotes = await Promise.all(entries.map(w => ctx.market.quote(w.ticker, read)));
    const warnings = [...loaded.meta.warnings], sink = factSink(ctx, warnings);
    let freshness: Freshness = 'fresh';
    const rows = entries.map((w, i) => {
      const ticker = w.ticker.toUpperCase(), q = quotes[i];
      freshness = worst(freshness, q.freshness === 'missing' ? 'stale' : q.freshness);
      if (!q.data) warnings.push(`quote_missing:${ticker}`);
      else if (q.source === 'price_cache') warnings.push(RETRIEVAL_TIME_NOTE);
      sink.add(`watchlist:${ticker}:target`, w.target_price_usd, 'money', { source: 'user', as_of: loaded.meta.asOf, currency: 'USD', ticker });
      if (q.data) sink.add(`quote:${q.data.ticker}:price`, q.data.price, 'money', { source: q.source, as_of: q.asOf, currency: q.data.currency, ticker: q.data.ticker });
      return { ticker, targetPriceUsd: w.target_price_usd ?? null, quote: q.data };
    });
    return success(ctx, { rows }, sink.facts, meta({ snapshotId: loaded.meta.snapshotId, complete: loaded.meta.complete, warnings,
      omittedRows: loaded.data.watchlist.length - entries.length, freshness }));
  },
});

export const portfolioTools = [summary, holdings, transactions, performance, allocation, dividends, watchlist];
