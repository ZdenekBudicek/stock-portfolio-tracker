import { useMemo, useState } from "react";
import { Target, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGoals, useUpsertGoal, useDeleteGoal } from "@/hooks/useExtras";
import { useComputedPortfolio, useDailySnapshots, useTransactions, computeTradeFlows } from "@/hooks/usePortfolio";
import { monthlyGrowthNetOfFlows } from "@/lib/dailyChanges";
import { useCurrency } from "@/contexts/CurrencyContext";

const PortfolioGoal = () => {
  const { data: goals = [] } = useGoals();
  const upsert = useUpsertGoal();
  const del = useDeleteGoal();
  const { totalValue } = useComputedPortfolio();
  const { data: snaps = [] } = useDailySnapshots();
  const { data: txs = [] } = useTransactions();
  const { format } = useCurrency();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", target_amount_usd: "", target_date: "" });

  const submit = async () => {
    if (!f.name || !f.target_amount_usd) return;
    await upsert.mutateAsync({
      name: f.name,
      target_amount_usd: parseFloat(f.target_amount_usd),
      target_date: f.target_date || null,
    });
    setF({ name: "", target_amount_usd: "", target_date: "" });
    setOpen(false);
  };

  // Estimate growth rate from the last ~90 days of snapshots: the market's own return, with
  // the money bought in taken out (a month of purchases is not growth), over the REAL
  // calendar span — with gaps in the series the row count understates the elapsed time.
  const monthlyGrowth = useMemo(() => {
    if (snaps.length < 30) return 0;
    return monthlyGrowthNetOfFlows(snaps.slice(-90), computeTradeFlows(txs));
  }, [snaps, txs]);


  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" /> Cíle portfolia
        </h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5 h-8"><Plus className="w-3.5 h-3.5" /> Cíl</Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Nový cíl</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <Input placeholder="Název (např. 1M USD do 2030)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <Input placeholder="Cílová částka USD" type="number" value={f.target_amount_usd} onChange={(e) => setF({ ...f, target_amount_usd: e.target.value })} />
              <Input type="date" value={f.target_date} onChange={(e) => setF({ ...f, target_date: e.target.value })} />
              <Button onClick={submit}>Uložit</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {goals.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-6">Žádné cíle. Přidej, kam směřuješ.</p>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => {
            const progress = Math.min(100, (totalValue / g.target_amount_usd) * 100);
            const remaining = Math.max(0, g.target_amount_usd - totalValue);
            // Months to goal at current growth
            let etaMonths: number | null = null;
            if (monthlyGrowth > 0 && remaining > 0) {
              etaMonths = Math.log(g.target_amount_usd / totalValue) / Math.log(1 + monthlyGrowth);
            }
            return (
              <div key={g.id} className="rounded-lg border border-border/60 bg-background/40 p-3.5">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-bold text-sm">{g.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {format(totalValue)} / {format(g.target_amount_usd)}
                      {g.target_date && ` · do ${new Date(g.target_date).toLocaleDateString("cs-CZ")}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-display text-xl font-bold tabular-nums">{progress.toFixed(1)}%</span>
                    <button onClick={() => del.mutate(g.id)} className="text-muted-foreground hover:text-loss"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
                <div className="h-2 rounded-full bg-border/50 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-primary via-info to-profit transition-all" style={{ width: `${progress}%` }} />
                </div>
                {etaMonths !== null && etaMonths > 0 && etaMonths < 600 && (
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Při současném růstu {(monthlyGrowth * 100).toFixed(2)}% / měs. dosáhneš za <span className="font-bold text-foreground">~{etaMonths.toFixed(0)} měsíců</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PortfolioGoal;
