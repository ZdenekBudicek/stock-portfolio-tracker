import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useMemo, useState } from 'react';
import { Archive, ChevronDown } from 'lucide-react';
import { useTransactions, type DbTransaction } from '@/hooks/usePortfolio';
import { runFifo, isRealTradeTx } from '@/lib/fifo';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatPct } from '@/data/portfolio';
import { TickerLogo } from '@/components/TickerLogo';

interface ClosedRow {
  ticker: string;
  sharesSold: number;
  proceeds: number;   // USD received on sells (net of fees)
  costSold: number;   // FIFO cost of the sold shares incl. buy fees
  realized: number;   // proceeds − costSold
  firstBuy: string;
  lastSell: string;
  /** Shares sold without a matching lot — left out of the numbers above. */
  unmatched: number;
}

/**
 * Tickers fully closed across every broker account, from the shared FIFO (the same lots the
 * header and the tax report use). Closed = nothing beyond dust left open AND something sold.
 */
function computeClosed(txs: DbTransaction[]): ClosedRow[] {
  const { disposals, openLots, warnings } = runFifo(txs.filter(isRealTradeTx));
  const open = new Map<string, number>();
  for (const l of openLots) open.set(l.ticker, (open.get(l.ticker) ?? 0) + l.shares);
  const unmatched = new Map<string, number>();
  for (const w of warnings) if (w.kind === 'unmatched-sell') unmatched.set(w.ticker, (unmatched.get(w.ticker) ?? 0) + (w.shares ?? 0));
  const rows = new Map<string, ClosedRow>();
  for (const d of disposals) {
    const r = rows.get(d.ticker) ?? { ticker: d.ticker, sharesSold: 0, proceeds: 0, costSold: 0, realized: 0, firstBuy: '', lastSell: '', unmatched: unmatched.get(d.ticker) ?? 0 };
    r.sharesSold += d.shares;
    r.proceeds += d.proceedsUsd - d.sellFeeUsd;
    r.costSold += d.costUsd;
    r.realized += d.gainUsd;
    const bought = d.acquiredAt.slice(0, 10), sold = d.soldAt.slice(0, 10);
    if (!r.firstBuy || bought < r.firstBuy) r.firstBuy = bought;
    if (sold > r.lastSell) r.lastSell = sold;
    rows.set(d.ticker, r);
  }
  return [...rows.values()]
    .filter((r) => (open.get(r.ticker) ?? 0) <= 0.01 && r.sharesSold > 1e-6)
    .sort((a, b) => b.lastSell.localeCompare(a.lastSell));
}

const fmtDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(currentLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).replace(/\s/g, '');

const ClosedPositions = () => {
  const { t } = useTranslation();
  const { data: txs = [] } = useTransactions();
  const { format } = useCurrency();
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => computeClosed(txs), [txs]);
  const totalRealized = rows.reduce((s, r) => s + r.realized, 0);
  const winners = rows.filter((r) => r.realized > 0).length;
  const shown = expanded ? rows : rows.slice(0, 8);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 sm:p-6 animate-fade-in-up">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <Archive className="w-5 h-5 text-primary" /> {t('legacy.closedPositions.closedPositions')}<span className="text-xs font-normal text-muted-foreground">· {t('legacy.closedPositions.stockCount', { count: rows.length })}{" "}{winners} {t('legacy.closedPositions.profitable')}</span>
        </h2>
        <div className={`font-display font-bold ${totalRealized >= 0 ? 'text-profit' : 'text-loss'}`}>
          {totalRealized >= 0 ? '+' : ''}{format(totalRealized)}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border/60">
              <th className="py-2">{t('legacy.closedPositions.ticker')}</th>
              <th className="text-right">{t('legacy.closedPositions.sharesSold')}</th>
              <th className="text-right">{t('legacy.closedPositions.costBasis')}</th>
              <th className="text-right">{t('legacy.closedPositions.saleProceeds')}</th>
              <th className="text-right">{t('legacy.closedPositions.realizedGain')}</th>
              <th className="text-right">{t('legacy.closedPositions.heldFor')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ticker} className="border-b border-border/30 hover:bg-accent/20 transition-colors">
                <td className="py-2 font-mono font-bold">
                  <span className="inline-flex items-center gap-2"><TickerLogo ticker={r.ticker} size="xs" />{r.ticker}</span>
                  {r.unmatched > 1e-6 && (
                    <span className="ml-1 font-sans font-normal text-[10px] text-warning" title={t('legacy.closedPositions.sharesSoldWithoutAMatchingPurchaseExcludedFrom', { v0: r.unmatched.toLocaleString(currentLocale(), { maximumFractionDigits: 4 }) })}>⚠</span>
                  )}
                </td>
                <td className="text-right tabular-nums">{r.sharesSold.toLocaleString(currentLocale(), { maximumFractionDigits: 2 })}</td>
                <td className="text-right tabular-nums text-muted-foreground">{format(r.costSold)}</td>
                <td className="text-right tabular-nums">{format(r.proceeds)}</td>
                <td className={`text-right tabular-nums font-bold ${r.realized >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {r.realized >= 0 ? '+' : ''}{format(r.realized)}
                  <span className="ml-1 font-normal text-[10px] opacity-80">
                    ({formatPct(r.costSold > 0 ? (r.realized / r.costSold) * 100 : 0)})
                  </span>
                </td>
                <td className="text-right tabular-nums text-muted-foreground whitespace-nowrap">{fmtDate(r.firstBuy)} → {fmtDate(r.lastSell)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > 8 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1.5 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t('legacy.closedPositions.showLess') : t('legacy.closedPositions.showAll', { v0: rows.length })}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
      <p className="text-[10px] text-muted-foreground mt-2">
        {t('legacy.closedPositions.fifoWithinEachBrokerageAccountRealizedGainSale')}</p>
    </div>
  );
};

export default ClosedPositions;
