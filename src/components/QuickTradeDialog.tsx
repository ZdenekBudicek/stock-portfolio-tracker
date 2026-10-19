import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useMemo, useState } from "react";
import { Plus, Minus, X, ArrowRightLeft } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrency } from "@/contexts/CurrencyContext";
import { usePositions, useLivePrices } from "@/hooks/usePortfolio";
import { useAddTransaction } from "@/hooks/useExtras";
import { useToast } from "@/hooks/use-toast";

/**
 * A quick trade needs a positive, finite quantity and price and a non-negative fee. Only zero
 * used to be rejected, so "-5" shares went in as a BUY and inverted the position and cash.
 * (Splits, transfers and broker corrections never go through this dialog — they come from
 * statement imports and the broker sync.)
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isValidQuickTrade(ticker: string, shares: number, price: number, fee: number): boolean {
  return !!ticker.trim()
    && Number.isFinite(shares) && shares > 0
    && Number.isFinite(price) && price > 0
    && Number.isFinite(fee) && fee >= 0;
}

const QuickTradeDialog = () => {
  const { t } = useTranslation();
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
    if (!isValidQuickTrade(upper, sharesN, priceN, feeN)) {
      toast({ title: t('legacy.quickTradeDialog.enterTickerQuantityAndPrice'), variant: "destructive" });
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
        title: side === "BUY" ? t('legacy.quickTradeDialog.recordedBuy') : t('legacy.quickTradeDialog.recordedSell'),
        description: t('legacy.quickTradeDialog.tradeDetail', { shares: sharesN.toLocaleString(currentLocale(), { maximumFractionDigits: 8 }), ticker: upper, price: priceN.toLocaleString(currentLocale(), { maximumFractionDigits: 8 }) }),
      });
      reset();
      setOpen(false);
    } catch (e: any) {
      toast({ title: t('legacy.quickTradeDialog.error'), description: t('legacy.quickTradeDialog.errorDetail', { message: e.message }), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 bg-primary hover:bg-primary/90 shadow-md shadow-primary/30">
          <ArrowRightLeft className="w-3.5 h-3.5" /> {t('legacy.quickTradeDialog.buySell')}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('legacy.quickTradeDialog.quickTrade')}</DialogTitle>
        </DialogHeader>

        {/* Side toggle */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setSide("BUY")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              side === "BUY" ? "bg-profit text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Plus className="w-4 h-4" /> {t('legacy.quickTradeDialog.buy')}</button>
          <button
            onClick={() => setSide("SELL")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              side === "SELL" ? "bg-loss text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Minus className="w-4 h-4" /> {t('legacy.quickTradeDialog.sell')}</button>
        </div>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.ticker')}</label>
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
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.newName')}</label>
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
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.quantity')}</label>
              <Input type="number" step="0.0001" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="10" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.priceUsd')}</label>
              <div className="relative">
                <Input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="150.00" />
                {livePrice && (
                  <button
                    type="button"
                    onClick={fillLive}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold hover:bg-primary/25"
                  >
                    {t('legacy.quickTradeDialog.live')}{livePrice.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </button>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.fee')}</label>
              <Input type="number" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.date')}</label>
            <Input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.quickTradeDialog.note')}</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('legacy.quickTradeDialog.optional')} />
          </div>

          {/* Live preview of impact */}
          <div className="rounded-lg border border-border bg-card/50 p-3 text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('legacy.quickTradeDialog.tradeValue')}</span>
              <span className="font-mono font-bold">{format(sharesN * priceN)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{side === "BUY" ? t('legacy.quickTradeDialog.totalCostIncludingFees') : t('legacy.quickTradeDialog.proceedsAfterFees')}</span>
              <span className="font-mono font-bold">{format(side === "BUY" ? total : sharesN * priceN - feeN)}</span>
            </div>
            <div className="flex justify-between border-t border-border/60 pt-1.5">
              <span className="text-muted-foreground">{t('legacy.quickTradeDialog.cashBeforeAfter')}</span>
              <span className={`font-mono font-bold ${cashAfter < 0 ? "text-loss" : ""}`}>
                {format(cash)} → {format(cashAfter)}
              </span>
            </div>
            {matched && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('legacy.quickTradeDialog.holding')}{" "}{upper}</span>
                <span className="font-mono">
                  {Number(matched.shares).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → {(Number(matched.shares) + (side === "BUY" ? sharesN : -sharesN)).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.quickTradeDialog.shares')}</span>
              </div>
            )}
            {!enoughCash && <p className="text-loss text-[11px] flex items-center gap-1"><X className="w-3 h-3" /> {t('legacy.quickTradeDialog.insufficientCash')}</p>}
            {!enoughShares && <p className="text-loss text-[11px] flex items-center gap-1"><X className="w-3 h-3" /> {t('legacy.quickTradeDialog.notEnoughShares')}</p>}
          </div>

          <Button onClick={submit} disabled={add.isPending || !sharesN || !priceN || !upper} className="w-full">
            {add.isPending ? t('legacy.quickTradeDialog.saving') : side === "BUY" ? t('legacy.quickTradeDialog.confirmBuy') : t('legacy.quickTradeDialog.confirmSell')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuickTradeDialog;
