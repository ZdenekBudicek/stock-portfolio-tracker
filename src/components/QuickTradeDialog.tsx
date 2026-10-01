import { useMemo, useState } from "react";
import { Plus, Minus, X, ArrowRightLeft } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrency } from "@/contexts/CurrencyContext";
import { usePositions, useLivePrices } from "@/hooks/usePortfolio";
import { useAddTransaction } from "@/hooks/useExtras";
import { useToast } from "@/hooks/use-toast";

const QuickTradeDialog = () => {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [fee, setFee] = useState("0");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [note, setNote] = useState("");

  const { format } = useCurrency();
  const { data: positions = [] } = usePositions();
  const { data: live } = useLivePrices();
  const add = useAddTransaction();
  const { toast } = useToast();

  const upper = ticker.toUpperCase().trim();
  const matched = useMemo(() => positions.find((p) => p.ticker === upper), [positions, upper]);
  const livePrice = live?.prices[upper]?.price;

  const cashRow = positions.find((p) => p.ticker === "CASH");
  const cash = cashRow ? Number(cashRow.shares) : 0;

  const sharesN = parseFloat(shares) || 0;
  const priceN = parseFloat(price) || 0;
  const feeN = parseFloat(fee) || 0;
  const total = sharesN * priceN + (side === "BUY" ? feeN : -feeN);
  const cashAfter = side === "BUY" ? cash - total : cash + total;
  const enoughCash = side === "SELL" || cash >= total;
  const enoughShares = side === "BUY" || (matched && Number(matched.shares) >= sharesN);

  const fillLive = () => {
    if (livePrice) setPrice(livePrice.toFixed(2));
  };

  const reset = () => {
    setTicker(""); setName(""); setShares(""); setPrice(""); setFee("0"); setNote("");
    setDate(new Date().toISOString().slice(0, 16));
  };

  const submit = async () => {
    if (!upper || !sharesN || !priceN) {
      toast({ title: "Vyplň ticker, počet a cenu", variant: "destructive" });
      return;
    }
    try {
      await add.mutateAsync({
        ticker: upper,
        side,
        shares: sharesN,
        price_usd: priceN,
        fee_usd: feeN,
        executed_at: new Date(date).toISOString(),
        note: note || null,
        name: name || matched?.name || upper,
      });
      toast({
        title: `${side === "BUY" ? "Nákup" : "Prodej"} zaznamenán`,
        description: `${sharesN} × ${upper} @ $${priceN}`,
      });
      reset();
      setOpen(false);
    } catch (e: any) {
      toast({ title: "Chyba", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 bg-primary hover:bg-primary/90 shadow-md shadow-primary/30">
          <ArrowRightLeft className="w-3.5 h-3.5" /> Buy / Sell
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rychlá transakce</DialogTitle>
        </DialogHeader>

        {/* Side toggle */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setSide("BUY")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              side === "BUY" ? "bg-profit text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Plus className="w-4 h-4" /> BUY
          </button>
          <button
            onClick={() => setSide("SELL")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              side === "SELL" ? "bg-loss text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Minus className="w-4 h-4" /> SELL
          </button>
        </div>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Ticker</label>
              <Input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="AAPL"
                className="font-mono uppercase"
                list="positions-list"
              />
              <datalist id="positions-list">
                {positions.filter((p) => p.ticker !== "CASH").map((p) => (
                  <option key={p.ticker} value={p.ticker}>{p.name}</option>
                ))}
              </datalist>
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Název (nová)</label>
              <Input
                value={matched?.name ?? name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Apple Inc."
                disabled={!!matched}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Počet</label>
              <Input type="number" step="0.0001" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="10" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Cena (USD)</label>
              <div className="relative">
                <Input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="150.00" />
                {livePrice && (
                  <button
                    type="button"
                    onClick={fillLive}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold hover:bg-primary/25"
                  >
                    LIVE ${livePrice.toFixed(2)}
                  </button>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Poplatek</label>
              <Input type="number" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Datum</label>
            <Input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Poznámka</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="(volitelné)" />
          </div>

          {/* Live preview of impact */}
          <div className="rounded-lg border border-border bg-card/50 p-3 text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hodnota transakce</span>
              <span className="font-mono font-bold">{format(sharesN * priceN)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{side === "BUY" ? "Cena celkem (s poplatky)" : "Výnos (po poplatcích)"}</span>
              <span className="font-mono font-bold">{format(side === "BUY" ? total : sharesN * priceN - feeN)}</span>
            </div>
            <div className="flex justify-between border-t border-border/60 pt-1.5">
              <span className="text-muted-foreground">CASH před / po</span>
              <span className={`font-mono font-bold ${cashAfter < 0 ? "text-loss" : ""}`}>
                {format(cash)} → {format(cashAfter)}
              </span>
            </div>
            {matched && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pozice {upper}</span>
                <span className="font-mono">
                  {Number(matched.shares).toFixed(2)} → {(Number(matched.shares) + (side === "BUY" ? sharesN : -sharesN)).toFixed(2)} ks
                </span>
              </div>
            )}
            {!enoughCash && <p className="text-loss text-[11px] flex items-center gap-1"><X className="w-3 h-3" /> Nedostatek CASH</p>}
            {!enoughShares && <p className="text-loss text-[11px] flex items-center gap-1"><X className="w-3 h-3" /> Nemáš tolik akcií</p>}
          </div>

          <Button onClick={submit} disabled={add.isPending || !sharesN || !priceN || !upper} className="w-full">
            {add.isPending ? "Ukládám..." : `Potvrdit ${side === "BUY" ? "nákup" : "prodej"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuickTradeDialog;
