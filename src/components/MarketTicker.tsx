import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatPct } from '@/data/portfolio';

const MarketTicker = () => {
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();

  const items = positions
    .filter((p) => p.type !== 'Cash' && p.ticker !== 'CASH')
    .sort((a, b) => Math.abs(b.dailyChangePct) - Math.abs(a.dailyChangePct));

  if (items.length === 0) return null;

  // Duplicate for seamless infinite scroll
  const loop = [...items, ...items];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card/40 backdrop-blur py-2.5 group">
      {/* gradient mask edges */}
      <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-16 z-10 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-16 z-10 bg-gradient-to-l from-background to-transparent" />

      <div className="flex animate-ticker-tape group-hover:[animation-play-state:paused] whitespace-nowrap">
        {loop.map((p, i) => {
          const positive = p.dailyChangePct > 0;
          const flat = p.dailyChangePct === 0;
          const Icon = flat ? Minus : positive ? TrendingUp : TrendingDown;
          const color = flat ? 'text-muted-foreground' : positive ? 'text-profit' : 'text-loss';
          return (
            <Link
              key={`${p.ticker}-${i}`}
              to={`/stock/${p.ticker}`}
              className="inline-flex items-center gap-2 px-5 py-1 border-r border-border/60 hover:bg-accent/40 transition-colors"
            >
              <span className="font-display font-bold text-sm text-foreground">{p.ticker}</span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{format(p.currentPrice)}</span>
              <span className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${color}`}>
                <Icon className="w-3 h-3" />
                {formatPct(p.dailyChangePct)}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
};

export default MarketTicker;
