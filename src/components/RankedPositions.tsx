import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGrid } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { formatPct, formatUsd } from '@/data/portfolio';
import { TickerLogo } from '@/components/TickerLogo';

// Ranked #1–#N grid of positions by value (3 columns), with a Dnes/Celkem toggle:
// Dnes  = today's move (USD + %), Celkem = total unrealized profit (USD + %).
const RankedPositions = () => {
  const { positions, loading } = useComputedPortfolio();
  const { format, currency } = useCurrency();
  const [mode, setMode] = useState<'today' | 'total'>('total');

  const stocks = positions
    .filter((p) => p.type !== 'Cash' && p.ticker !== 'CASH')
    .sort((a, b) => b.value - a.value);

  if (loading || stocks.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 sm:p-6 animate-fade-in-up">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <LayoutGrid className="w-5 h-5 text-primary" /> Pozice podle velikosti
        </h2>
        <div className="flex gap-1 p-1 rounded-lg bg-background/60 border border-border">
          {([['today', 'Dnes'], ['total', 'Celkem']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                mode === key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {stocks.map((p, i) => {
          const amt = mode === 'today' ? p.dailyChangeUsd : p.profitUsd;
          const pct = mode === 'today' ? p.dailyChangePct : (currency === 'CZK' ? p.profitPctCzk : p.profitPct);
          const pos = amt >= 0;
          return (
            <Link
              key={p.ticker}
              to={`/stock/${p.ticker}`}
              className="group/link flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 hover:border-primary/40 transition-colors"
            >
              <span className="text-[10px] font-bold text-muted-foreground w-7 shrink-0">#{i + 1}</span>
              <TickerLogo ticker={p.ticker} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="font-mono font-bold text-sm leading-tight">{p.ticker}</div>
                <div className="text-[10px] text-muted-foreground tabular-nums">{p.allocation.toFixed(1)} %</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-display text-sm font-bold tabular-nums">{formatUsd(p.currentPrice)}</div>
                <div className={`text-[11px] font-semibold tabular-nums ${pos ? 'text-profit' : 'text-loss'}`}>
                  {pos ? '+' : ''}{format(amt)} ({formatPct(pct)})
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
};

export default RankedPositions;
