import { useState } from "react";
import { Plus, Minus, Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrency } from "@/contexts/CurrencyContext";
import { usePositions, useComputedPortfolio } from "@/hooks/usePortfolio";
import { useAddTransaction } from "@/hooks/useExtras";
import { useToast } from "@/hooks/use-toast";

/**
 * Manual cash deposit / withdrawal. A deposit is recorded as a CASH BUY and a
 * withdrawal as a CASH SELL (amount in USD, price 1) — the DB cash trigger then
 * moves the balance. Used because cash is partly automatic (trades move it) but
 * external deposits must be entered by hand.
 */
const CashAdjustDialog = () => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"DEPOSIT" | "WITHDRAW">("DEPOSIT");
  const [amount, setAmount] = useState("");
  const [ccy, setCcy] = useState<"USD" | "CZK">("USD");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [note, setNote] = useState("");

  const { format } = useCurrency();
  const { data: positions = [] } = usePositions();
  const { usdCzk } = useComputedPortfolio();
  const add = useAddTransaction();
  const { toast } = useToast();

  const cashRow = positions.find((p) => p.ticker === "CASH");
  const cash = cashRow ? Number(cashRow.shares) : 0; // stored in USD
  const inputN = parseFloat(amount) || 0;
  const amountN = ccy === "CZK" ? inputN / (usdCzk || 23) : inputN; // convert to USD for storage
  const cashAfter = mode === "DEPOSIT" ? cash + amountN : cash - amountN;

  const submit = async () => {
    if (!amountN || amountN <= 0) {
      toast({ title: "Zadej částku", variant: "destructive" });
      return;
    }
    try {
      await add.mutateAsync({
        ticker: "CASH",
        side: mode === "DEPOSIT" ? "BUY" : "SELL",
        shares: amountN,
        price_usd: 1,
        fee_usd: 0,
        executed_at: new Date(date).toISOString(),
        note: note || (mode === "DEPOSIT" ? "Vklad" : "Výběr"),
      });
      toast({
        title: mode === "DEPOSIT" ? "Vklad zaznamenán" : "Výběr zaznamenán",
        description: `${format(amountN)} → CASH ${format(cashAfter)}`,
      });
      setAmount(""); setNote(""); setDate(new Date().toISOString().slice(0, 16));
      setOpen(false);
    } catch (e: any) {
      toast({ title: "Chyba", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Wallet className="w-3.5 h-3.5" /> Hotovost
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Vklad / Výběr hotovosti</DialogTitle>
        </DialogHeader>

        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setMode("DEPOSIT")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              mode === "DEPOSIT" ? "bg-profit text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Plus className="w-4 h-4" /> Vklad
          </button>
          <button
            onClick={() => setMode("WITHDRAW")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              mode === "WITHDRAW" ? "bg-loss text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Minus className="w-4 h-4" /> Výběr
          </button>
        </div>

        <div className="grid gap-3">
          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Částka</label>
            <div className="flex gap-2">
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" className="flex-1" />
              <select value={ccy} onChange={(e) => setCcy(e.target.value as any)} className="px-2 rounded-md border border-border bg-background text-sm">
                <option value="USD">USD</option>
                <option value="CZK">CZK</option>
              </select>
            </div>
            {ccy === "CZK" && inputN > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1">≈ ${amountN.toFixed(2)} (kurz {(usdCzk || 23).toFixed(2)})</p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Datum</label>
            <Input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Poznámka</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="(volitelné)" />
          </div>

          <div className="rounded-lg border border-border bg-card/50 p-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">CASH před / po</span>
              <span className={`font-mono font-bold ${cashAfter < 0 ? "text-loss" : ""}`}>
                {format(cash)} → {format(cashAfter)}
              </span>
            </div>
          </div>

          <Button onClick={submit} disabled={add.isPending || !amountN} className="w-full">
            {add.isPending ? "Ukládám..." : mode === "DEPOSIT" ? "Připsat vklad" : "Odečíst výběr"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CashAdjustDialog;
