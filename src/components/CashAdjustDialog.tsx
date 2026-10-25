import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useState } from "react";
import { Plus, Minus, Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrency } from "@/contexts/CurrencyContext";
import { usePositions } from "@/hooks/usePortfolio";
import { useAddTransaction } from "@/hooks/useExtras";
import { useToast } from "@/hooks/use-toast";

/**
 * Manual cash deposit / withdrawal. A deposit is recorded as a CASH BUY and a
 * withdrawal as a CASH SELL (amount in USD, price 1) — the DB cash trigger then
 * moves the balance. Used because cash is partly automatic (trades move it) but
 * external deposits must be entered by hand.
 */
const CashAdjustDialog = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"DEPOSIT" | "WITHDRAW">("DEPOSIT");
  const [amount, setAmount] = useState("");
  // "LOCAL" = the user's local currency (koruny or the chosen one), converted at today's rate.
  const [ccy, setCcy] = useState<"USD" | "LOCAL">("USD");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [note, setNote] = useState("");

  const { format, local, usdLocal } = useCurrency();
  const { data: positions = [] } = usePositions();
  const add = useAddTransaction();
  const { toast } = useToast();

  const cashRow = positions.find((p) => p.ticker === "CASH");
  const cash = cashRow ? Number(cashRow.shares) : 0; // stored in USD
  const inputN = parseFloat(amount) || 0;
  const amountN = ccy === "LOCAL" ? inputN / (usdLocal || 23) : inputN; // convert to USD for storage
  const cashAfter = mode === "DEPOSIT" ? cash + amountN : cash - amountN;

  const submit = async () => {
    if (!amountN || amountN <= 0) {
      toast({ title: t('legacy.cashAdjustDialog.enterAnAmount'), variant: "destructive" });
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
        note: note || (mode === "DEPOSIT" ? t('legacy.cashAdjustDialog.deposit') : t('legacy.cashAdjustDialog.withdrawal')),
      });
      toast({
        title: mode === "DEPOSIT" ? t('legacy.cashAdjustDialog.depositRecorded') : t('legacy.cashAdjustDialog.withdrawalRecorded'),
        description: t('legacy.cashAdjustDialog.cashDetail', { amount: format(amountN), balance: format(cashAfter) }),
      });
      setAmount(""); setNote(""); setDate(new Date().toISOString().slice(0, 16));
      setOpen(false);
    } catch (error: unknown) {
      const e = error as { message?: string } | null;
      toast({ title: t('legacy.cashAdjustDialog.error'), description: t('legacy.cashAdjustDialog.errorDetail', { message: e.message }), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Wallet className="w-3.5 h-3.5" /> {t('legacy.cashAdjustDialog.cash')}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('legacy.cashAdjustDialog.cashDepositWithdrawal')}</DialogTitle>
        </DialogHeader>

        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setMode("DEPOSIT")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              mode === "DEPOSIT" ? "bg-profit text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Plus className="w-4 h-4" /> {t('legacy.cashAdjustDialog.deposit')}</button>
          <button
            onClick={() => setMode("WITHDRAW")}
            className={`flex-1 py-2 text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              mode === "WITHDRAW" ? "bg-loss text-background" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Minus className="w-4 h-4" /> {t('legacy.cashAdjustDialog.withdrawal')}</button>
        </div>

        <div className="grid gap-3">
          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.cashAdjustDialog.amount')}</label>
            <div className="flex gap-2">
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" className="flex-1" />
              <select value={ccy} onChange={(e) => setCcy(e.target.value as typeof ccy)} className="px-2 rounded-md border border-border bg-background text-sm">
                <option value="USD">USD</option>
                <option value="LOCAL">{local}</option>
              </select>
            </div>
            {ccy === "LOCAL" && inputN > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1">≈ ${amountN.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.cashAdjustDialog.rate')}{" "}{(usdLocal || 23).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.cashAdjustDialog.date')}</label>
            <Input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t('legacy.cashAdjustDialog.note')}</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('legacy.cashAdjustDialog.optional')} />
          </div>

          <div className="rounded-lg border border-border bg-card/50 p-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('legacy.cashAdjustDialog.cashBeforeAfter')}</span>
              <span className={`font-mono font-bold ${cashAfter < 0 ? "text-loss" : ""}`}>
                {format(cash)} → {format(cashAfter)}
              </span>
            </div>
          </div>

          <Button onClick={submit} disabled={add.isPending || !amountN} className="w-full">
            {add.isPending ? t('legacy.cashAdjustDialog.saving') : mode === "DEPOSIT" ? t('legacy.cashAdjustDialog.addDeposit') : t('legacy.cashAdjustDialog.deductWithdrawal')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CashAdjustDialog;
