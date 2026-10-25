import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Layers } from "lucide-react";
import { useComputedPortfolio, usePositions } from "@/hooks/usePortfolio";
import { useTickerProfiles } from "@/hooks/useTickerProfiles";
import { useCurrency } from "@/contexts/CurrencyContext";

import { computeAllocationModel } from "@/lib/allocationModel";

const PALETTE = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#84cc16", "#a855f7", "#f97316"];

const SectorAllocation = () => {
  const { data: dbPositions = [] } = usePositions();
  // Not gated on isLoading (and deliberately not `?? new Map()` inline, which would be a
  // new identity every render): while the profiles are in flight — or if the query fails
  // outright — resolveSector falls through to the manual override and the static map, so
  // the chart renders immediately and re-slices once the API answer arrives.
  const { data: profiles } = useTickerProfiles();
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();

  const data = useMemo(() => computeAllocationModel({ positions, dbPositions,
    profiles: profiles ?? new Map(), quoteCurrencies: {} }).sectors, [positions, dbPositions, profiles]);

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <h2 className="font-display text-lg font-bold flex items-center gap-2 mb-3">
        <Layers className="w-5 h-5 text-primary" /> Alokace dle sektorů
      </h2>
      <p className="text-[10px] text-muted-foreground -mt-2 mb-3">Podíl na investovaných penězích, bez hotovosti</p>

      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-12">Pro pozice doplň sektor v databázi.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
          <div className="h-56">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data} dataKey="value" innerRadius={50} outerRadius={85} paddingAngle={2}>
                  {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number, _n, p: { payload?: { pct: number; name: string } }) => [`${format(v)} (${p.payload.pct.toFixed(1)}%)`, p.payload.name]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-1.5">
            {data.map((d, i) => (
              <div key={d.name} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                  <span className="truncate">{d.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="tabular-nums text-muted-foreground">{format(d.value)}</span>
                  <span className="tabular-nums font-bold w-12 text-right">{d.pct.toFixed(1)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SectorAllocation;
