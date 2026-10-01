import { useMemo, useState } from "react";
import { CalendarClock, RefreshCw, ChevronDown, Scissors, Mic } from "lucide-react";
import { useEarnings, useSplits, useWatchlist } from "@/hooks/useExtras";
import { usePositions } from "@/hooks/usePortfolio";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const MONTHS_CS = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const MONTHS_SHORT = ["led","úno","bře","dub","kvě","čvn","čvc","srp","zář","říj","lis","pro"];

type Item = { key: string; date: Date; ticker: string; title: string; subtitle: string; kind: "earnings" | "split"; owned: boolean };

const EarningsCalendar = () => {
  const { data: earnings = [] } = useEarnings();
  const { data: splits = [] } = useSplits();
  const { data: positions = [] } = usePositions();
  const { data: watchlist = [] } = useWatchlist();
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const owned = useMemo(() => new Set(positions.filter((p) => p.ticker !== "CASH" && Number(p.shares) > 0).map((p) => p.ticker)), [positions]);
  const watched = useMemo(() => new Set(watchlist.map((w) => w.ticker)), [watchlist]);
  const relevant = useMemo(() => new Set([...owned, ...watched]), [owned, watched]);
  const nameMap = useMemo(() => new Map(positions.map((p) => [p.ticker, p.name])), [positions]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { error } = await supabase.functions.invoke("sync-earnings");
      if (error) throw error;
      toast.success("Události synchronizovány");
      qc.invalidateQueries({ queryKey: ["earnings"] });
      qc.invalidateQueries({ queryKey: ["splits"] });
    } catch (e: any) {
      toast.error(e.message || "Sync selhal");
    } finally {
      setSyncing(false);
    }
  };

  // Only important, FUTURE/current events (earnings + stock splits) for stocks the user
  // owns or watches. Past events are not shown.
  const grouped = useMemo(() => {
    const today = new Date(new Date().toDateString());
    const items: Item[] = [];

    for (const e of earnings) {
      if (!relevant.has(e.ticker)) continue;
      const d = new Date(e.earnings_date);
      if (d < today) continue;
      items.push({ key: `e-${e.id}`, date: d, ticker: e.ticker, title: nameMap.get(e.ticker) || e.ticker, subtitle: "Prezentace výsledků", kind: "earnings", owned: owned.has(e.ticker) });
    }
    for (const s of splits) {
      if (!relevant.has(s.ticker)) continue;
      const d = new Date(s.split_date);
      if (d < today) continue;
      const ratio = Number(s.ratio) || 1;
      const label = ratio >= 1 ? `Akciový split ${ratio}:1` : `Reverzní split 1:${Math.round(1 / ratio)}`;
      items.push({ key: `s-${s.id}`, date: d, ticker: s.ticker, title: nameMap.get(s.ticker) || s.ticker, subtitle: label, kind: "split", owned: owned.has(s.ticker) });
    }
    items.sort((a, b) => a.date.getTime() - b.date.getTime());

    const map = new Map<string, { label: string; year: number; month: number; items: Item[] }>();
    for (const it of items) {
      const y = it.date.getFullYear(), m = it.date.getMonth();
      const key = `${y}-${m}`;
      if (!map.has(key)) map.set(key, { label: MONTHS_CS[m], year: y, month: m, items: [] });
      map.get(key)!.items.push(it);
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }, [earnings, splits, relevant, owned, nameMap]);

  const now = new Date();
  const currentKey = `${now.getFullYear()}-${now.getMonth()}`;
  // Always open the current month; if it has no events, open the nearest upcoming one.
  const defaultKey = grouped.some((g) => g.key === currentKey) ? currentKey : (grouped[0]?.key ?? null);
  const [openKey, setOpenKey] = useState<string | null>(defaultKey);
  const [touched, setTouched] = useState(false);
  const effectiveOpen = touched ? openKey : defaultKey;

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <CalendarClock className="w-5 h-5 text-primary" /> Firemní události
        </h2>
        <button onClick={sync} disabled={syncing} className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase rounded-md bg-primary/10 hover:bg-primary/20 text-primary disabled:opacity-50 transition-colors">
          <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Synchronizuji…" : "Sync API"}
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-6">Žádné nadcházející události pro tvé akcie. Spusť synchronizaci.</p>
      ) : (
        <div className="space-y-3">
          {grouped.map((group) => {
            const isOpen = effectiveOpen === group.key;
            const yearSuffix = group.year !== now.getFullYear() ? ` ${group.year}` : "";
            return (
              <div key={group.key}>
                <button onClick={() => { setTouched(true); setOpenKey(isOpen ? null : group.key); }} className="w-full flex items-center justify-between mb-2 group">
                  <span className="font-display text-xl font-bold lowercase">
                    {group.label}{yearSuffix}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">({group.items.length})</span>
                  </span>
                  <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                {isOpen && (
                  <div className="space-y-2">
                    {group.items.map((it) => {
                      const isSplit = it.kind === "split";
                      return (
                        <div key={it.key} className={`flex items-stretch rounded-xl overflow-hidden border ${isSplit ? "border-warning/30" : "border-info/25"}`}>
                          <div className="flex flex-col items-center justify-center px-4 py-3 min-w-[60px] bg-background/40">
                            <span className="font-display text-xl font-bold leading-none">{it.date.getDate()}</span>
                            <span className="text-[10px] uppercase text-muted-foreground mt-1">{MONTHS_SHORT[it.date.getMonth()]}</span>
                          </div>
                          <div className={`flex-1 px-4 py-3 flex items-center gap-3 ${isSplit ? "bg-warning/8" : "bg-info/8"}`}>
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isSplit ? "bg-warning/20 text-warning" : "bg-info/20 text-info"}`}>
                              {isSplit ? <Scissors className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-sm truncate"><span className="font-mono">{it.ticker}</span> · {it.title}</p>
                              <p className="text-xs text-muted-foreground truncate">{it.subtitle}</p>
                            </div>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${it.owned ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
                              {it.owned ? "V portfoliu" : "Watchlist"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
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

export default EarningsCalendar;
