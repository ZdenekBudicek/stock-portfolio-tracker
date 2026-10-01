import { useMemo, useState } from 'react';
import { Archive, ChevronDown } from 'lucide-react';
import { useTransactions, type DbTransaction } from '@/hooks/usePortfolio';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatPct } from '@/data/portfolio';

interface ClosedRow {
  ticker: string;
  sharesSold: number;
  proceeds: number;   // USD received on sells (net of fees)
  costSold: number;   // FIFO cost of the sold shares
  realized: number;   // proceeds − costSold
  firstBuy: string;
  lastSell: string;
}

/** FIFO across each ticker's real trades; a ticker whose net shares end at ~0 is closed. */
function computeClosed(txs: DbTransaction[]): ClosedRow[] {
  const byTicker = new Map<string, DbTransaction[]>();
  for (const t of txs) {
    if (t.ticker === 'CASH') continue;
    const ext = String((t as any).ext_id ?? '');
    if (ext.includes(':adj:') || ext.includes(':pos:')) continue; // reconcile artifacts
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker)!.push(t);
  }
  const out: ClosedRow[] = [];
  for (const [ticker, list] of byTicker) {
    const sorted = [...list].sort((a, b) => a.executed_at.localeCompare(b.executed_at));
    const open: { shares: number; cost: number }[] = [];
    let sharesSold = 0, proceeds = 0, costSold = 0, net = 0;
    let firstBuy = '', lastSell = '';
    for (const t of sorted) {
      if (t.side === 'BUY') {
        open.push({ shares: t.shares, cost: t.price_usd });
        if (!firstBuy) firstBuy = t.executed_at.slice(0, 10);
        net += t.shares;
      } else {
        let toSell = t.shares;
        while (toSell > 1e-9 && open.length > 0) {
          const lot = open[0];
          const take = Math.min(toSell, lot.shares);
          costSold += take * lot.cost;
          lot.shares -= take;
          toSell -= take;
          if (lot.shares <= 1e-9) open.shift();
        }
        proceeds += t.shares * t.price_usd - (t.fee_usd || 0);
        sharesSold += t.shares;
        lastSell = t.executed_at.slice(0, 10);
        net -= t.shares;
      }
    }
    // Fully closed = nothing (beyond dust) left AND something was actually sold.
    if (Math.abs(net) <= 0.01 && sharesSold > 1e-6 && lastSell) {
      out.push({ ticker, sharesSold, proceeds, costSold, realized: proceeds - costSold, firstBuy, lastSell });
    }
  }
  return out.sort((a, b) => b.lastSell.localeCompare(a.lastSell));
}

const fmtDate = (d: string) => { const [y, m, day] = d.split('-'); return `${day}.${m}.${y}`; };

const ClosedPositions = () => {
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
          <Archive className="w-5 h-5 text-primary" /> Uzavřené pozice
          <span className="text-xs font-normal text-muted-foreground">· {rows.length} akcií · {winners} v zisku</span>
        </h2>
        <div className={`font-display font-bold ${totalRealized >= 0 ? 'text-profit' : 'text-loss'}`}>
          {totalRealized >= 0 ? '+' : ''}{format(totalRealized)}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border/60">
              <th className="py-2">Ticker</th>
              <th className="text-right">Prodáno ks</th>
              <th className="text-right">Náklady</th>
              <th className="text-right">Výnos z prodeje</th>
              <th className="text-right">Realizovaný zisk</th>
              <th className="text-right">Drženo</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ticker} className="border-b border-border/30 hover:bg-accent/20 transition-colors">
                <td className="py-2 font-mono font-bold">{r.ticker}</td>
                <td className="text-right tabular-nums">{r.sharesSold.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })}</td>
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
          {expanded ? 'Zobrazit méně' : `Zobrazit všech ${rows.length}`}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
      <p className="text-[10px] text-muted-foreground mt-2">
        FIFO — realizovaný zisk = výnos z prodeje − pořizovací cena prodaných kusů. Bez reconcile korekcí.
      </p>
    </div>
  );
};

export default ClosedPositions;
