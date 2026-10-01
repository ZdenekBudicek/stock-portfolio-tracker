import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Layers } from "lucide-react";
import { useComputedPortfolio, usePositions } from "@/hooks/usePortfolio";
import { useTickerProfiles, resolveSector } from "@/hooks/useTickerProfiles";
import { useCurrency } from "@/contexts/CurrencyContext";

const PALETTE = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#84cc16", "#a855f7", "#f97316"];

const SectorAllocation = () => {
  const { data: dbPositions = [] } = usePositions();
  // Not gated on isLoading (and deliberately not `?? new Map()` inline, which would be a
  // new identity every render): while the profiles are in flight — or if the query fails
  // outright — resolveSector falls through to the manual override and the static map, so
  // the chart renders immediately and re-slices once the API answer arrives.
  const { data: profiles } = useTickerProfiles();
  const { positions, totalValue } = useComputedPortfolio();
  const { format } = useCurrency();

  // Manual overrides only. The autofill trigger that used to stuff this column from the
  // hardcoded map is dropped in 20260809100000_ticker_profiles.sql, so a non-empty value
  // here is a human's deliberate choice and outranks the API.
  const manualSectors = useMemo(
    () => new Map(dbPositions.map((p) => [p.ticker.toUpperCase(), p.sector])),
    [dbPositions],
  );

  const data = useMemo(() => {
    const groups = new Map<string, number>();
    for (const p of positions) {
      if (p.ticker === "CASH") continue;
      const sector = resolveSector(p.ticker, manualSectors.get(p.ticker.toUpperCase()), profiles);
      groups.set(sector, (groups.get(sector) || 0) + p.value);
    }
    return Array.from(groups.entries())
      .map(([name, value]) => ({ name, value, pct: totalValue > 0 ? (value / totalValue) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [positions, manualSectors, profiles, totalValue]);

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <h2 className="font-display text-lg font-bold flex items-center gap-2 mb-3">
        <Layers className="w-5 h-5 text-primary" /> Alokace dle sektorů
      </h2>
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
                  formatter={(v: any, _n, p: any) => [`${format(v)} (${p.payload.pct.toFixed(1)}%)`, p.payload.name]}
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
