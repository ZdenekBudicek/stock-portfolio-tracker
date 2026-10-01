import { TrendingUp, TrendingDown, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatPct } from '@/data/portfolio';

const TopMovers = () => {
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();

  const stocks = positions.filter((p) => p.type !== 'Cash' && p.ticker !== 'CASH');
  const gainers = [...stocks].sort((a, b) => b.dailyChangePct - a.dailyChangePct).slice(0, 3);
  const losers = [...stocks].sort((a, b) => a.dailyChangePct - b.dailyChangePct).slice(0, 3);

  const Card = ({
    title,
    items,
    type,
  }: {
    title: string;
    items: typeof stocks;
    type: 'gain' | 'loss';
  }) => {
    const isGain = type === 'gain';
    const Icon = isGain ? TrendingUp : TrendingDown;
    return (
      <div className="gradient-card rounded-2xl border border-border p-5 hover-lift animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <div className={`p-1.5 rounded-lg ${isGain ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss'}`}>
            <Icon className="w-4 h-4" />
          </div>
          <h3 className="font-display font-bold text-sm sm:text-base text-foreground">{title}</h3>
        </div>
        <div className="space-y-1">
          {items.length === 0 && (
            <p className="text-xs text-muted-foreground py-3">Žádná data</p>
          )}
          {items.map((p) => {
            const positive = p.dailyChangePct >= 0;
            return (
              <Link
                key={p.ticker}
                to={`/stock/${p.ticker}`}
                className="group flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-accent transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-display font-bold text-sm text-foreground">{p.ticker}</span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{format(p.currentPrice)}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{p.name}</p>
                </div>
                <div className="text-right">
                  <div className={`font-display font-bold text-sm tabular-nums ${positive ? 'text-profit' : 'text-loss'}`}>
                    {formatPct(p.dailyChangePct)}
                  </div>
                  <div className={`text-[11px] tabular-nums ${positive ? 'text-profit/80' : 'text-loss/80'}`}>
                    {format(p.dailyChangeUsd)}
                  </div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card title="Top růst dnes" items={gainers} type="gain" />
      <Card title="Top pokles dnes" items={losers} type="loss" />
    </div>
  );
};

export default TopMovers;
