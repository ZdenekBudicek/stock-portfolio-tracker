import { datedCzkPer, makeRateLookup } from "./fxLookup";
import { computeNetDeposits, type DatedDeposit } from "./netDeposits";
import { runFifo, realizedUsd, isRealTradeTx } from "./fifo";
import type { DbPosition, DbTransaction, DisplaySnapshot, LivePosition, LivePrices } from "./portfolioTypes";
import type { BrokerSummary } from "./brokerSummary";
import type { DividendRecord } from "./dividendTax";
import type { LocalFx } from "./displayCurrency";
import type { CalculationCache } from "./calculationCache";

export interface PortfolioInput {
  deposits?: DatedDeposit[];
  positions: DbPosition[];
  prices: LivePrices["prices"];
  transactions: DbTransaction[];
  snapshots: DisplaySnapshot[];
  t212Summary: BrokerSummary | null;
  dividends: DividendRecord[];
  usdCzk: number;
  fx: LocalFx;
}

export interface ComputedPortfolio {
  fxEstimated?: boolean;
  /** Display holdings; dust is excluded only after all totals and returns are computed. */
  positions: LivePosition[];
  totalValue: number;
  totalInvested: number;
  totalInvestedCzk: number;
  unrealizedProfit: number;
  unrealizedProfitCzk: number;
  realizedProfit: number;
  dailyReturn: number;
  netDepositsUsd: number | null;
  netDepositsCzk: number | null;
  totalProfit: number;
  totalProfitCzk: number;
  totalReturnPct: number;
  totalReturnPctCzk: number;
  totalProfitPct: number;
  totalProfitPctCzk: number;
  usdCzk: number;
  usdLocal: number;
}

/**
 * Total realized profit/loss across all sells — the shared FIFO (src/lib/fifo.ts) over real
 * trades, so the header, the closed positions and the tax report report the same number.
 * Shares sold without a matching lot are left out (their cost is unknown), not counted as
 * pure profit.
 */
function computeRealizedFifo(txs: DbTransaction[], cache?: CalculationCache): number {
  return realizedUsd(cache ? cache.fifo(txs, 'real') : runFifo(txs.filter(isRealTradeTx)));
}

/**
 * FIFO cost basis of the shares STILL HELD per ticker (sells consume the oldest lots,
 * so what remains is the most recent buys). This is the correct cost of the current
 * holding — a plain weighted average over all buys is wrong once some have been sold,
 * and it also lets us ignore synthetic :adj:/:pos: reconcile rows (which carry $0 cost
 * and would otherwise dilute the average and inflate profit%). Returns remaining
 * shares + their total cost per ticker.
 */
export function computeHoldingCostFifo(
  txs: DbTransaction[],
  fxAt?: (date: string) => number,
  cache?: CalculationCache,
): Map<string, { shares: number; cost: number; costCzk: number }> {
  // The shared FIFO keeps lots per ticker AND broker ACCOUNT: each account's sells consume
  // only that account's lots. The same ticker held at two brokers — or at two accounts of
  // one broker — has independent cost bases (matching what each broker's own app shows);
  // they're summed for the combined holding.
  //
  // Reconciliation rows (:adj:) are INCLUDED. They are genuine share corrections priced at
  // the broker's own average, and `positions.shares` counts them — excluding them computed
  // the cost basis over a DIFFERENT set of shares than the quantity shown beside it, so
  // "investováno" and profit % came out wrong for every reconciled ticker.
  const out = new Map<string, { shares: number; cost: number; costCzk: number }>();
  for (const lot of (cache ? cache.fifo(txs, 'all') : runFifo(txs)).openLots) {
    const cost = lot.shares * (lot.priceUsd + lot.feePerShareUsd);
    const cur = out.get(lot.ticker) ?? { shares: 0, cost: 0, costCzk: 0 };
    cur.shares += lot.shares;
    cur.cost += cost;
    cur.costCzk += cost * (fxAt ? fxAt(lot.acquiredAt.slice(0, 10)) : 1);
    out.set(lot.ticker, cur);
  }
  return out;
}

/**
 * Money moved INTO the positions per date, in USD: a BUY adds, a SELL takes out, both at
 * the trade price. Synthetic rows (`:adj:` reconciliations, `:pos:` holdings snapshots) and
 * CASH movements are excluded — they are not purchases.
 *
 * This is the baseline the portfolio chart measures against. It is derived purely from the
 * trade ledger, so unlike the deposits table it is complete for every broker, and because a
 * sale lowers both the holdings value and this baseline by the same amount, selling a
 * position can never look like a loss.
 */
export function computeTradeFlows(txs: DbTransaction[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of txs) {
    if (t.ticker === "CASH") continue;
    const ext = String(t.ext_id ?? "");
    if (ext.includes(":adj:") || ext.includes(":pos:")) continue;
    const day = t.executed_at.slice(0, 10);
    // Merger cash: a 0-share SELL with the amount in price_usd (see lib/fifo).
    const qtyValue = ext.includes(":mergercash:") ? Math.abs(t.price_usd) * (t.shares > 0 ? t.shares : 1) : t.shares * t.price_usd;
    const usd = (t.side === "BUY" ? 1 : -1) * qtyValue;
    if (!Number.isFinite(usd)) continue;
    m.set(day, (m.get(day) ?? 0) + usd);
  }
  return m;
}

export const isCashPosition = (p: { ticker: string; type?: string }) => p.ticker === "CASH" || p.type === "Cash";

export const DUST_USD = 10;

/** Shared display policy, including cash even below the threshold. Never use for totals. */
export function visibleHoldings<T extends { ticker: string; type?: string; value: number }>(positions: T[]): T[] {
  return positions.filter((p) => isCashPosition(p) || p.value >= DUST_USD);
}

/**
 * Totals of the open positions, cash EXCLUDED. Cash has no cost and no return; counting it
 * as "invested" diluted the unrealized % (45,84 % instead of 47,31 % in the demo) and made
 * "Investováno" differ between the tabs by the cash balance.
 */
export function summarizeHoldings(positions: LivePosition[]) {
  let value = 0, invested = 0, valueCzk = 0, investedCzk = 0;
  for (const p of positions) {
    if (isCashPosition(p)) continue;
    value += p.value; invested += p.invested;
    valueCzk += p.valueCzk; investedCzk += p.investedCzk;
  }
  const profit = value - invested, profitCzk = valueCzk - investedCzk;
  return {
    value, invested, profit, profitPct: invested > 0 ? (profit / invested) * 100 : 0,
    valueCzk, investedCzk, profitCzk, profitPctCzk: investedCzk > 0 ? (profitCzk / investedCzk) * 100 : 0,
  };
}

export function computePortfolio({ positions: dbPositions, prices, transactions, snapshots, t212Summary, dividends, deposits: datedDeposits, usdCzk, fx }: PortfolioInput, cache?: CalculationCache): ComputedPortfolio {
  // The …Czk figures are in the local display currency; snapshots already carry USD→local.
  const rate = usdCzk * fx.perCzkToday;
  // USD->local by date from snapshot fx_rate, for the purchase-time local cost basis.
  const fxByDate = new Map<string, number>();
  for (const s of snapshots) if (s.fx_rate) fxByDate.set(s.snapshot_date, Number(s.fx_rate));
  const historical = makeRateLookup([...fxByDate].map(([date, close]) => ({ date, close: close / fx.perCzkAt(date) })));
  let fxEstimated = false;
  const fxAt = (date: string): number => {
    const recorded = historical(date);
    const bundled = datedCzkPer("USD", date);
    const czk = Number.isFinite(recorded) ? recorded : bundled;
    if (Number.isFinite(czk)) return czk * fx.perCzkAt(date);
    fxEstimated = true;
    return rate;
  };

  // Correct per-holding cost basis via FIFO from real trades (handles same ticker across
  // brokers + ignores $0 reconcile rows). Falls back to the stored avg if no trade data.
  const fifoCost = computeHoldingCostFifo(transactions, fxAt, cache);

  const positions: LivePosition[] = dbPositions
    .map((p) => {
    const live = prices[p.ticker];
    const currentPrice = live?.price ?? p.avg_cost_usd;
    const dailyPct = live?.changePct ?? 0;
    const value = p.shares * currentPrice;
    const f = fifoCost.get(p.ticker);
    const avgCost = f && f.shares > 1e-6 ? f.cost / f.shares : p.avg_cost_usd;
    const invested = p.shares * avgCost;
    const avgCostCzk = f && f.shares > 1e-6 ? f.costCzk / f.shares : p.avg_cost_usd * rate;
    const investedCzk = p.shares * avgCostCzk;
    const valueCzk = value * rate;
    const dailyChangeUsd = live?.prevClose ? p.shares * (currentPrice - live.prevClose) : 0;
    return {
      ticker: p.ticker,
      name: p.name,
      type: p.type,
      shares: p.shares,
      avgPrice: avgCost,
      currentPrice,
      invested,
      value,
      profitUsd: value - invested,
      profitPct: invested > 0 ? ((value - invested) / invested) * 100 : 0,
      avgPriceCzk: avgCostCzk,
      investedCzk,
      valueCzk,
      profitCzk: valueCzk - investedCzk,
      profitPctCzk: investedCzk > 0 ? ((valueCzk - investedCzk) / investedCzk) * 100 : 0,
      dailyChangeUsd,
      dailyChangePct: dailyPct,
      allocation: 0,
    };
  });

  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  for (const p of positions) p.allocation = totalValue > 0 ? Math.round((p.value / totalValue) * 1000) / 10 : 0;

  const holdings = summarizeHoldings(positions);
  const totalInvested = holdings.invested;
  const unrealizedProfit = holdings.profit;
  const dailyReturn = positions.reduce((s, p) => s + p.dailyChangeUsd, 0);

  // Realized profit via the shared FIFO incl. fees — the same lots as the Tax report.
  const realizedProfit = computeRealizedFifo(transactions, cache);

  // Net money put in, measured on the same basis as Hodnota (see lib/netDeposits): the
  // honest base for total return, profit = current value − net deposits, which inherently
  // includes gains already locked in from sold positions.
  const deposits = computeNetDeposits({ txs: transactions, t212: t212Summary, usdCzk, localPerCzk: fx.perCzkToday, localPerCzkAt: fx.perCzkAt, fxAt, dividends, deposits: datedDeposits });
  const hasDeposits = deposits.usd > 0;
  const totalProfit = hasDeposits ? totalValue - deposits.usd : unrealizedProfit + realizedProfit;
  const totalReturnPct = hasDeposits
    ? (totalProfit / deposits.usd) * 100
    : (totalInvested > 0 ? ((unrealizedProfit + realizedProfit) / totalInvested) * 100 : 0);
  // In CZK: today's value against the koruny actually put in (each flow at its own day's
  // rate; a CZK T212 account's own figure exactly), so the result includes the currency move.
  const totalValueCzk = totalValue * rate;
  const totalProfitCzk = hasDeposits ? totalValueCzk - deposits.czk : totalProfit * rate;
  const totalReturnPctCzk = hasDeposits && deposits.czk > 0 ? (totalProfitCzk / deposits.czk) * 100 : totalReturnPct;

  return {
    ...(fxEstimated || deposits.estimated ? { fxEstimated: true } : {}),
    positions: visibleHoldings(positions),
    totalValue,
    totalInvested,
    totalInvestedCzk: holdings.investedCzk,
    unrealizedProfit,
    unrealizedProfitCzk: holdings.profitCzk,
    realizedProfit,
    dailyReturn,
    netDepositsUsd: hasDeposits ? deposits.usd : null,
    netDepositsCzk: hasDeposits ? deposits.czk : null,
    totalProfit,
    totalProfitCzk,
    totalReturnPct,
    totalReturnPctCzk,
    totalProfitPct: holdings.profitPct,
    totalProfitPctCzk: holdings.profitPctCzk,
    /** Today's real USD/CZK (taxes, ČNB notes) — not the display currency. */
    usdCzk,
    /** Today's USD → local display currency (the rate of every …Czk figure). */
    usdLocal: rate,
  };
}
