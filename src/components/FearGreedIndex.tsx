import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";

const fetchFG = async () => {
  const r = await fetch("https://api.alternative.me/fng/?limit=2");
  const j = await r.json();
  const today = j.data[0];
  const yesterday = j.data[1];
  return {
    value: parseInt(today.value),
    classification: today.value_classification,
    prev: parseInt(yesterday.value),
  };
};

const colorFor = (v: number) =>
  v < 25 ? "text-loss" : v < 45 ? "text-warning" : v < 55 ? "text-muted-foreground" : v < 75 ? "text-info" : "text-profit";
const bgFor = (v: number) =>
  v < 25 ? "from-loss/20" : v < 45 ? "from-warning/20" : v < 55 ? "from-muted" : v < 75 ? "from-info/20" : "from-profit/20";
const labelCs = (c: string) =>
  ({
    "Extreme Fear": "Extrémní strach",
    "Fear": "Strach",
    "Neutral": "Neutrální",
    "Greed": "Chamtivost",
    "Extreme Greed": "Extrémní chamtivost",
  })[c] || c;

const FearGreedIndex = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["fear-greed"],
    queryFn: fetchFG,
    refetchInterval: 60 * 60 * 1000,
    staleTime: 30 * 60 * 1000,
  });

  if (isLoading || !data) {
    return <div className="rounded-2xl border border-border bg-card/60 p-5 h-32 animate-pulse" />;
  }

  const delta = data.value - data.prev;

  return (
    <div className={`rounded-2xl border border-border bg-gradient-to-br ${bgFor(data.value)} to-card backdrop-blur p-5 animate-fade-in-up`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-display text-sm font-bold flex items-center gap-2 mb-1">
            <Activity className="w-4 h-4 text-primary" /> Fear & Greed
          </h3>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Nálada na trhu</p>
        </div>
        <div className="text-right">
          <p className={`font-display text-4xl font-bold tabular-nums ${colorFor(data.value)}`}>{data.value}</p>
          <p className={`text-xs font-bold ${colorFor(data.value)}`}>{labelCs(data.classification)}</p>
          <p className="text-[10px] text-muted-foreground">
            {delta >= 0 ? "+" : ""}{delta} vs včera
          </p>
        </div>
      </div>
      {/* Gauge bar */}
      <div className="mt-3 h-2 rounded-full bg-gradient-to-r from-loss via-warning via-info to-profit relative">
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-foreground border-2 border-background shadow"
          style={{ left: `calc(${data.value}% - 6px)` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground mt-1 uppercase font-bold">
        <span>0</span><span>50</span><span>100</span>
      </div>
    </div>
  );
};

export default FearGreedIndex;
