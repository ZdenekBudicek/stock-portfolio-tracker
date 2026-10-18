import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useState } from "react";
import { Eye, Plus, Trash2, Bell } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWatchlist, useAddWatch, useRemoveWatch } from "@/hooks/useExtras";
import { useLivePrices } from "@/hooks/usePortfolio";
import { TickerLogo } from '@/components/TickerLogo';

const Watchlist = () => {
  const { t } = useTranslation();
  const { data: items = [] } = useWatchlist();
  const { data: live } = useLivePrices();
  const add = useAddWatch();
  const remove = useRemoveWatch();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ticker: "", name: "", target: "", note: "" });

  const submit = async () => {
    if (!f.ticker || !f.name) return;
    await add.mutateAsync({
      ticker: f.ticker.toUpperCase(),
      name: f.name,
      target_price_usd: f.target ? parseFloat(f.target) : null,
      note: f.note || null,
    });
    setF({ ticker: "", name: "", target: "", note: "" });
    setOpen(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <Eye className="w-5 h-5 text-primary" /> {t('legacy.watchlist.watchlist')}</h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5 h-8"><Plus className="w-3.5 h-3.5" /> {t('legacy.watchlist.add')}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>{t('legacy.watchlist.addToWatchlist')}</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <Input placeholder={t('legacy.watchlist.tickerNvda')} value={f.ticker} onChange={(e) => setF({ ...f, ticker: e.target.value.toUpperCase() })} className="font-mono uppercase" />
              <Input placeholder={t('legacy.watchlist.companyName')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <Input placeholder={t('legacy.watchlist.targetPriceInUsdOptional')} type="number" step="0.01" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
              <Input placeholder={t('legacy.watchlist.note')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
              <Button onClick={submit}>{t('legacy.watchlist.add')}</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8">{t('legacy.watchlist.noWatchedStocksAddATickerYouAre')}</p>
      ) : (
        <div className="space-y-2">
          {items.map((w) => {
            const price = live?.prices[w.ticker]?.price;
            const pct = live?.prices[w.ticker]?.changePct ?? 0;
            const hit = w.target_price_usd && price && price <= w.target_price_usd;
            return (
              <div key={w.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-2"><TickerLogo ticker={w.ticker} size="sm" /><span className="font-mono font-bold">{w.ticker}</span></span>
                    <span className="text-xs text-muted-foreground truncate">{w.name}</span>
                    {hit && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-profit/20 text-profit font-bold flex items-center gap-0.5"><Bell className="w-2.5 h-2.5" /> {t('legacy.watchlist.target')}</span>}
                  </div>
                  {w.note && <p className="text-[10px] text-muted-foreground truncate">{w.note}</p>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <div className="font-mono text-sm font-bold tabular-nums">{price ? `$${price.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</div>
                    <div className={`text-[10px] tabular-nums ${pct >= 0 ? "text-profit" : "text-loss"}`}>
                      {pct >= 0 ? "+" : ""}{pct.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%
                    </div>
                  </div>
                  {w.target_price_usd && (
                    <div className="text-right text-[10px] text-muted-foreground">
                      <div>{t('legacy.watchlist.target2')}</div>
                      <div className="font-mono">${w.target_price_usd.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                  )}
                  <button onClick={() => remove.mutate(w.id)} className="text-muted-foreground hover:text-loss">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Watchlist;
