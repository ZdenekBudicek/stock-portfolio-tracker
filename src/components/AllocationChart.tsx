import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useState } from 'react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';

const COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-6))',
  'hsl(var(--chart-7))',
  'hsl(var(--chart-8))',
  'hsl(var(--chart-9))',
  'hsl(var(--chart-5))',
];

const AllocationChart = () => {
  const { format } = useCurrency();
  const { positions, totalValue } = useComputedPortfolio();
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const data = positions
    .filter(p => p.allocation > 0)
    .sort((a, b) => b.allocation - a.allocation)
    .map(p => ({ name: p.ticker, fullName: p.name, value: p.value, allocation: p.allocation, type: p.type }));

  const active = activeIdx !== null ? data[activeIdx] : null;

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="glass-strong border border-border rounded-xl px-3.5 py-2.5 shadow-2xl">
        <p className="font-display font-bold text-sm text-foreground">{d.name}</p>
        <p className="text-xs text-muted-foreground mb-1">{d.fullName}</p>
        <p className="text-sm font-medium text-foreground tabular-nums">{format(d.value)}</p>
        <p className="text-xs text-primary font-semibold">{d.allocation}% portfolia</p>
      </div>
    );
  };

  return (
    <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6 animate-fade-in-up hover-lift">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="font-display font-bold text-lg sm:text-xl text-foreground">Alokace</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Rozložení podle hodnoty</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-2 py-1 rounded-md bg-background/60 border border-border">
          {data.length} pozic
        </span>
      </div>

      <div className="flex flex-col lg:flex-row items-center gap-5">
        <div className="relative w-full lg:w-1/2 h-[260px]">
          <ResponsiveContainer>
            <PieChart>
              <defs>
                {COLORS.map((c, i) => (
                  <linearGradient key={i} id={`pieGrad${i}`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={1} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.7} />
                  </linearGradient>
                ))}
              </defs>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={70}
                outerRadius={110}
                paddingAngle={3}
                dataKey="value"
                stroke="hsl(var(--background))"
                strokeWidth={2}
                onMouseEnter={(_, i) => setActiveIdx(i)}
                onMouseLeave={() => setActiveIdx(null)}
              >
                {data.map((_, i) => (
                  <Cell
                    key={i}
                    fill={`url(#pieGrad${i % COLORS.length})`}
                    style={{
                      filter: activeIdx === null || activeIdx === i ? 'none' : 'opacity(0.4)',
                      transition: 'filter 0.2s',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} wrapperStyle={{ outline: 'none', zIndex: 50 }} offset={20} />
            </PieChart>
          </ResponsiveContainer>
          {/* Center label */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <div className="font-display text-xl font-bold text-foreground tabular-nums">{format(totalValue)}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Celkem</div>
            </div>
          </div>
        </div>

        <div className="w-full lg:w-1/2 grid grid-cols-1 gap-1 max-h-[260px] overflow-y-auto pr-1">
          {data.map((d, i) => (
            <button
              key={d.name}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseLeave={() => setActiveIdx(null)}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all text-left ${
                activeIdx === i ? 'bg-accent' : 'hover:bg-accent/60'
              }`}
            >
              <div
                className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-background"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span className="font-display text-sm font-bold text-foreground">{d.name}</span>
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-muted-foreground tabular-nums">{format(d.value)}</span>
                <span className="text-xs font-bold text-foreground tabular-nums w-12 text-right">{d.allocation}%</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AllocationChart;
