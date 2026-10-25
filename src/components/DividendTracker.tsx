import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useMemo, useState } from "react";
import { DollarSign, Plus, RefreshCw, ChevronDown, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDividends, useUpsertDividend, useDeleteDividend } from "@/hooks/useExtras";
import { usePositions, useTransactions, useComputedPortfolio } from "@/hooks/usePortfolio";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useDividendModel } from "@/hooks/useInsights";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { TickerLogo } from "@/components/TickerLogo";


const DividendTracker = () => {
  const { t } = useTranslation();
  const { data: divs = [] } = useDividends();
  const { data: positions = [] } = usePositions();
  const { data: txs = [] } = useTransactions();
  const upsert = useUpsertDividend();
  const del = useDeleteDividend();
  const { format } = useCurrency();
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const qc = useQueryClient();
  const [f, setF] = useState({ ticker: "", ex_date: "", pay_date: "", amount_per_share: "", status: "upcoming" as "upcoming" | "paid" });

  const sync = async () => {
    setSyncing(true);
    try {
      const { error } = await supabase.functions.invoke("sync-earnings");
      if (error) throw error;
      toast.success(t('legacy.dividendTracker.dividendsSynced'));
      qc.invalidateQueries({ queryKey: ["dividends"] });
      qc.invalidateQueries({ queryKey: ["earnings"] });
    } catch (error: unknown) {
      const e = error as { message?: string } | null;
      toast.error(e.message ? t('legacy.dividendTracker.errorDetail', { message: e.message }) : t('legacy.dividendTracker.syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  // Only tickers the user has ever held (so we never show dividends of stocks they never owned).
  const everHeld = useMemo(
    () => new Set((txs).filter((row) => row.ticker !== "CASH").map((row) => row.ticker.toUpperCase())),
    [txs],
  );

  const visible = useMemo(
    () => divs.filter((d) => everHeld.size === 0 || everHeld.has(d.ticker.toUpperCase())),
    [divs, everHeld],
  );

  const totals = useMemo(() => {
    const amt = (d: typeof divs[number]) => d.total_amount_usd ?? d.amount_per_share * (d.shares_held ?? 0);
    const sumPaid = visible.filter((d) => d.status === "paid").reduce((s, d) => s + amt(d), 0);
    const sumUpcoming = visible.filter((d) => d.status === "upcoming").reduce((s, d) => s + amt(d), 0);
    // Annual outlook: projected dividends with an ex-date in the next 365 days. The
    // sync-earnings projection covers ~12 months ahead, so this approximates the yearly
    // dividend income of the CURRENT holdings.
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const annualIncome = visible
      .filter((d) => d.status === "upcoming" && d.ex_date > today && d.ex_date <= horizon)
      .reduce((s, d) => s + amt(d), 0);
    return { sumPaid, sumUpcoming, annualIncome };
  }, [visible]);
  const { totalValue } = useComputedPortfolio();
  // The outlook shown here is the SAME as the Dividendy hero (by payment date, held stocks).
  const { annualTotal } = useDividendModel();
  const annualYield = totalValue > 0 ? (annualTotal / totalValue) * 100 : 0;

  const nowYear = new Date().getFullYear();

  // Group by year -> month. Newest year first; within a year newest month first.
  // Within a month, the SAME stock held on several brokers (incl. ticker variants like
  // META vs META.US) is merged into one row and its amounts summed — so a stock appears
  // once per dividend, not once per broker. A stock pays at most once a calendar month, so
  // month-level merge is safe. The summed total is identical to the unmerged sum.
  const norm = (row: string) => row.toUpperCase().split(".")[0];
  const amtOf = (d: typeof divs[number]) => d.total_amount_usd ?? d.amount_per_share * (d.shares_held ?? 0);
  const years = useMemo(() => {
    const byYear = new Map<number, Map<number, typeof divs>>();
    for (const d of visible) {
      const dt = new Date(d.ex_date);
      const y = dt.getFullYear(), m = dt.getMonth();
      if (!byYear.has(y)) byYear.set(y, new Map());
      const mm = byYear.get(y)!;
      if (!mm.has(m)) mm.set(m, []);
      mm.get(m)!.push(d);
    }
    const mergeItems = (items: typeof divs) => {
      const map = new Map<string, { ids: string[]; ticker: string; ex_date: string; status: string; amt: number; shares: number; _maxA: number }>();
      for (const d of items) {
        const key = norm(d.ticker);
        const a = amtOf(d), sh = Number(d.shares_held ?? 0);
        const e = map.get(key);
        if (e) {
          e.amt += a; e.shares += sh; e.ids.push(d.id);
          if (a > e._maxA) { e._maxA = a; e.ex_date = d.ex_date; e.status = d.status; }
        } else {
          map.set(key, { ids: [d.id], ticker: key, ex_date: d.ex_date, status: d.status, amt: a, shares: sh, _maxA: a });
        }
      }
      return [...map.values()].sort((a, b) => new Date(b.ex_date).getTime() - new Date(a.ex_date).getTime());
    };
    return [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, mm]) => {
        const months = [...mm.entries()].sort((a, b) => b[0] - a[0]).map(([month, items]) => ({
          month, items: mergeItems(items),
        }));
        const total = months.reduce((s, mo) => s + mo.items.reduce((x, d) => x + d.amt, 0), 0);
        return { year, months, total, count: months.reduce((s, mo) => s + mo.items.length, 0) };
      });
  }, [visible]);

  const [openYear, setOpenYear] = useState<number>(nowYear);

  const submit = async () => {
    if (!f.ticker || !f.ex_date || !f.amount_per_share) return;
    const pos = positions.find((p) => p.ticker === f.ticker.toUpperCase());
    const aps = parseFloat(f.amount_per_share);
    const shares = pos ? Number(pos.shares) : 0;
    await upsert.mutateAsync({
      ticker: f.ticker.toUpperCase(), ex_date: f.ex_date, pay_date: f.pay_date || null,
      amount_per_share: aps, shares_held: shares, total_amount_usd: aps * shares, status: f.status,
    });
    setF({ ticker: "", ex_date: "", pay_date: "", amount_per_share: "", status: "upcoming" });
    setOpen(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-primary" /> {t('legacy.dividendTracker.dividends')}</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={sync} disabled={syncing} className="gap-1.5 h-8 text-primary">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} /> {syncing ? t('legacy.dividendTracker.sync') : t('legacy.dividendTracker.syncAPI')}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5 h-8"><Plus className="w-3.5 h-3.5" /> {t('legacy.dividendTracker.add')}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm">
              <DialogHeader><DialogTitle>{t('legacy.dividendTracker.newDividend')}</DialogTitle></DialogHeader>
              <div className="grid gap-3">
                <Input placeholder={t('legacy.dividendTracker.ticker')} value={f.ticker} onChange={(e) => setF({ ...f, ticker: e.target.value.toUpperCase() })} className="font-mono uppercase" />
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="text-[10px] uppercase text-muted-foreground font-bold">{t('legacy.dividendTracker.exDate')}</label><Input type="date" value={f.ex_date} onChange={(e) => setF({ ...f, ex_date: e.target.value })} /></div>
                  <div><label className="text-[10px] uppercase text-muted-foreground font-bold">{t('legacy.dividendTracker.payDate')}</label><Input type="date" value={f.pay_date} onChange={(e) => setF({ ...f, pay_date: e.target.value })} /></div>
                </div>
                <Input placeholder={t('legacy.dividendTracker.usdPerShare')} type="number" step="0.0001" value={f.amount_per_share} onChange={(e) => setF({ ...f, amount_per_share: e.target.value })} />
                <select className="border border-input rounded-md h-10 px-2 bg-background text-sm" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })}>
                  <option value="upcoming">{t('legacy.dividendTracker.upcoming')}</option><option value="paid">{t('legacy.dividendTracker.paid')}</option>
                </select>
                <Button onClick={submit}>{t('legacy.dividendTracker.save')}</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border border-profit/20 bg-profit/5 p-3">
          <p className="text-[10px] uppercase text-muted-foreground font-bold">{t('legacy.dividendTracker.totalPaid')}</p>
          <p className="font-display text-xl font-bold text-profit">{format(totals.sumPaid)}</p>
        </div>
        <div className="rounded-lg border border-info/20 bg-info/5 p-3">
          <p className="text-[10px] uppercase text-muted-foreground font-bold">{t('legacy.dividendTracker.upcoming')}</p>
          <p className="font-display text-xl font-bold text-info">{format(totals.sumUpcoming)}</p>
        </div>
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 col-span-2 sm:col-span-1">
          <p className="text-[10px] uppercase text-muted-foreground font-bold">{t('legacy.dividendTracker.annualOutlook')}</p>
          <p className="font-display text-xl font-bold text-primary">{format(annualTotal)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t('legacy.dividendTracker.yield')}{" "}{annualYield.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.dividendTracker.ofPortfolio')}</p>
        </div>
      </div>

      {years.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">{t('legacy.dividendTracker.noDividendsRunSyncApi')}</p>
      ) : (
        <div className="space-y-2">
          {years.map((yr) => {
            const isOpen = openYear === yr.year;
            return (
              <div key={yr.year} className="rounded-lg border border-border bg-accent/20 overflow-hidden">
                <button onClick={() => setOpenYear(isOpen ? -1 : yr.year)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-accent/40 transition-colors">
                  <span className="font-display font-bold text-base">
                    {yr.year}{yr.year === nowYear && <span className="ml-2 text-[10px] font-normal text-primary">{t('legacy.dividendTracker.thisYear')}</span>}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">· {t('legacy.dividendTracker.dividendCount', { count: yr.count })}</span>
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-display font-bold text-profit">{format(yr.total)}</span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </div>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 space-y-3">
                    {yr.months.map((mo) => (
                      <div key={mo.month}>
                        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-1.5 mt-2">{new Date(2026, mo.month, 1).toLocaleDateString(currentLocale(), { month: "long" })}</p>
                        <div className="space-y-1.5">
                          {mo.items.map((d) => {
                            const dt = new Date(d.ex_date);
                            const paid = d.status === "paid";
                            const aps = d.shares > 0 ? d.amt / d.shares : 0;
                            return (
                              <div key={d.ids.join(",")} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${paid ? "border-profit/25 bg-profit/5" : "border-info/25 bg-info/5"}`}>
                                <span className="font-display text-sm font-bold w-7 text-center text-muted-foreground">{dt.getDate()}.</span>
                                <span className="inline-flex items-center gap-2"><TickerLogo ticker={d.ticker} size="xs" /><span className="font-mono font-bold text-sm">{d.ticker}</span></span>
                                <span className="text-xs text-muted-foreground">${aps.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{t('legacy.dividendTracker.share')}</span>
                                <span className="ml-auto font-display font-bold text-sm">{format(d.amt)}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${paid ? "bg-profit/20 text-profit" : "bg-info/20 text-info"}`}>
                                  {paid ? t('legacy.dividendTracker.paid') : t('legacy.dividendTracker.planned')}
                                </span>
                                <button aria-label={t('legacy.dividendTracker.deleteTicker', { ticker: d.ticker })} onClick={() => d.ids.forEach((id: string) => del.mutate(id))} className="text-muted-foreground/50 hover:text-loss"><Trash2 className="w-3 h-3" /></button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DividendTracker;
