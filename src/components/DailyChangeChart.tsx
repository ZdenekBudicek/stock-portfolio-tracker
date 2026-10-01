import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';

const DailyChangeChart = () => {
  const { format, convert, currency } = useCurrency();
  const { positions } = useComputedPortfolio();
  const data = positions
    .filter(p => p.type !== 'Cash' && p.ticker !== 'CASH')
    .sort((a, b) => b.dailyChangeUsd - a.dailyChangeUsd)
    .map(p => ({ name: p.ticker, change: p.dailyChangeUsd, pct: p.dailyChangePct, displayChange: convert(p.dailyChangeUsd) }));

  const totalChange = data.reduce((s, d) => s + d.change, 0);

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="glass-strong border border-border rounded-xl px-3.5 py-2.5 shadow-2xl">
        <p className="font-display font-bold text-sm text-foreground">{d.name}</p>
        <p className={`text-xs font-medium tabular-nums ${d.change >= 0 ? 'text-profit' : 'text-loss'}`}>
          {format(d.change)} ({d.pct >= 0 ? '+' : ''}{d.pct.toFixed(2)}%)
        </p>
      </div>
    );
  };

  const tickFormatter = (v: number) => currency === 'CZK' ? `${v.toFixed(0)}` : `$${v}`;

  return (
    <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6 animate-fade-in-up hover-lift">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-2">
        <div>
          <h2 className="font-display font-bold text-lg sm:text-xl text-foreground">Denní změna</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Příspěvek pozic za dnešní den</p>
        </div>
        <span className={`font-display font-bold text-base tabular-nums ${totalChange >= 0 ? 'text-profit' : 'text-loss'}`}>
          {totalChange >= 0 ? '+' : ''}{format(totalChange)}
        </span>
      </div>
      <div className="h-[260px] min-w-0">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="dcProfit" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--profit-glow))" stopOpacity={1} />
                <stop offset="100%" stopColor="hsl(var(--profit))" stopOpacity={0.75} />
              </linearGradient>
              <linearGradient id="dcLoss" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--loss))" stopOpacity={0.75} />
                <stop offset="100%" stopColor="hsl(var(--loss-glow))" stopOpacity={1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: 'hsl(var(--foreground))', fontFamily: 'JetBrains Mono', fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={tickFormatter}
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
              width={42}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--accent) / 0.3)' }} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Bar dataKey="displayChange" radius={[6, 6, 6, 6]}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.change >= 0 ? 'url(#dcProfit)' : 'url(#dcLoss)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default DailyChangeChart;
