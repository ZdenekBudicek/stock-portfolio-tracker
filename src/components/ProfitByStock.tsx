import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { formatPct } from '@/data/portfolio';

const ProfitByStock = () => {
  const { formatAt, pick, currency, hidden } = useCurrency();
  const { positions } = useComputedPortfolio();
  // `profit` is in the displayed currency: in CZK the koruna profit against the purchase-day
  // cost, so the bar, its colour and the % all say the same thing.
  const data = positions
    .filter(p => p.type !== 'Cash' && p.ticker !== 'CASH')
    .map(p => ({ name: p.ticker, profit: pick(p.profitUsd, p.profitCzk), pct: pick(p.profitPct, p.profitPctCzk) }))
    .sort((a, b) => b.profit - a.profit);

  const totalProfit = data.reduce((s, d) => s + d.profit, 0);
  const money = (v: number) => formatAt(v, v);

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="glass-strong border border-border rounded-xl px-3.5 py-2.5 shadow-2xl">
        <p className="font-display font-bold text-sm text-foreground">{d.name}</p>
        <p className={`text-xs font-medium tabular-nums ${d.profit >= 0 ? 'text-profit' : 'text-loss'}`}>
          {money(d.profit)} ({formatPct(d.pct)})
        </p>
      </div>
    );
  };

  const tickFormatter = (v: number) => hidden ? '••' : currency === 'CZK' ? `${(v / 1000).toFixed(0)}k` : `$${(v / 1000).toFixed(0)}k`;

  return (
    <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6 animate-fade-in-up hover-lift">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-2">
        <div>
          <h2 className="font-display font-bold text-lg sm:text-xl text-foreground">Nerealizovaný zisk</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Podle jednotlivých pozic</p>
        </div>
        <span className={`font-display font-bold text-base tabular-nums ${totalProfit >= 0 ? 'text-profit' : 'text-loss'}`}>
          {totalProfit >= 0 ? '+' : ''}{money(totalProfit)}
        </span>
      </div>
      <div className="h-[300px] min-w-0">
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pbProfit" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="hsl(var(--profit))" stopOpacity={0.7} />
                <stop offset="100%" stopColor="hsl(var(--profit-glow))" stopOpacity={1} />
              </linearGradient>
              <linearGradient id="pbLoss" x1="1" y1="0" x2="0" y2="0">
                <stop offset="0%" stopColor="hsl(var(--loss))" stopOpacity={0.7} />
                <stop offset="100%" stopColor="hsl(var(--loss-glow))" stopOpacity={1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
            <XAxis type="number" tickFormatter={tickFormatter} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: 'hsl(var(--foreground))', fontFamily: 'JetBrains Mono', fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--accent) / 0.3)' }} />
            <ReferenceLine x={0} stroke="hsl(var(--border))" />
            <Bar dataKey="profit" radius={[6, 6, 6, 6]}>

              {data.map((d, i) => (
                <Cell key={i} fill={d.profit >= 0 ? 'url(#pbProfit)' : 'url(#pbLoss)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default ProfitByStock;
