import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useState } from "react";
import { Split, Check, X, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSplits, useApplySplit, useDismissSplit, useAddSplitManual } from "@/hooks/useExtras";
import { useToast } from "@/hooks/use-toast";

const SplitsBanner = () => {
  const { t } = useTranslation();
  const { data: pending = [] } = useSplits("pending");
  const apply = useApplySplit();
  const dismiss = useDismissSplit();
  const addManual = useAddSplitManual();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [m, setM] = useState({ ticker: "", split_date: new Date().toISOString().slice(0, 10), ratio: "2" });

  const submitManual = async () => {
    const ratio = parseFloat(m.ratio);
    if (!m.ticker || !ratio) return;
    await addManual.mutateAsync({ ticker: m.ticker.toUpperCase(), split_date: m.split_date, ratio });
    toast({ title: t('legacy.splitsBanner.splitAddedForConfirmation') });
    setOpen(false);
    setM({ ticker: "", split_date: new Date().toISOString().slice(0, 10), ratio: "2" });
  };

  if (pending.length === 0) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <Split className="w-3 h-3" /> {t('legacy.splitsBanner.addSplitManually')}</button>
        </DialogTrigger>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('legacy.splitsBanner.manualSplit')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div>
              <label className="text-xs uppercase text-muted-foreground font-semibold">{t('legacy.splitsBanner.ticker')}</label>
              <Input value={m.ticker} onChange={(e) => setM({ ...m, ticker: e.target.value.toUpperCase() })} className="font-mono uppercase" />
            </div>
            <div>
              <label className="text-xs uppercase text-muted-foreground font-semibold">{t('legacy.splitsBanner.splitDate')}</label>
              <Input type="date" value={m.split_date} onChange={(e) => setM({ ...m, split_date: e.target.value })} />
            </div>
            <div>
              <label className="text-xs uppercase text-muted-foreground font-semibold">{t('legacy.splitsBanner.ratioEG441')}</label>
              <Input type="number" step="0.5" value={m.ratio} onChange={(e) => setM({ ...m, ratio: e.target.value })} />
              <p className="text-[10px] text-muted-foreground mt-1">{t('legacy.splitsBanner.forAReverseSplitUse1EG')}</p>
            </div>
            <Button onClick={submitManual}>{t('legacy.splitsBanner.createForApproval')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="rounded-2xl border border-warning/40 bg-warning/5 p-4 animate-fade-in-up">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-warning/15 text-warning shrink-0">
          <Split className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-bold text-sm flex items-center gap-2">
            {t('legacy.splitsBanner.detectedCount', { count: pending.length })}<span className="text-[10px] font-normal text-muted-foreground">{t('legacy.splitsBanner.reviewAndConfirmToKeepHistoryConsistent')}</span>
          </h3>
          <div className="mt-3 space-y-2">
            {pending.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-card/60 border border-border/60 px-3 py-2">
                <div className="text-xs">
                  <span className="font-mono font-bold text-base">{s.ticker}</span>
                  <span className="text-muted-foreground"> • {s.split_date} • </span>
                  <span className="font-bold">{s.ratio >= 1 ? `${s.ratio}:1` : `1:${(1 / s.ratio).toLocaleString(currentLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}</span>
                  {s.detected_price && s.prev_close && (
                    <span className="text-muted-foreground ml-2">${s.prev_close.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → ${s.detected_price.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-loss hover:text-loss"
                    onClick={() => dismiss.mutate(s.id)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" className="h-7 px-2 bg-profit hover:bg-profit/90 text-background"
                    onClick={async () => {
                      await apply.mutateAsync(s.id);
                      toast({ title: t('legacy.splitsBanner.splitApplied'), description: t('legacy.splitsBanner.1Recalculated', { v0: s.ticker, v1: s.ratio }) });
                    }}>
                    <Check className="w-3.5 h-3.5" /> {t('legacy.splitsBanner.confirm')}</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SplitsBanner;
