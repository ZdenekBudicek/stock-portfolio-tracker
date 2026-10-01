import { useMemo, useState } from "react";
import { FileText, Calendar, Download, Shield, Clock, Layers, ChevronDown } from "lucide-react";
import { useCurrency } from "@/contexts/CurrencyContext";
import { usePositions, useTransactions, useComputedPortfolio, type DbTransaction } from "@/hooks/usePortfolio";

const DAY_MS = 86_400_000;
// Český 3-letý časový test = 3 roky kalendářní (počítáme s průměrem 365.25 dne)
const DAYS_IN_3Y = Math.round(3 * 365.25); // 1096

/** Format days as "X let Y měs. Z dní" or shorter variants */
function formatDuration(days: number): string {
  if (days <= 0) return "0 dní";
  const years = Math.floor(days / 365.25);
  const afterYears = days - Math.floor(years * 365.25);
  const months = Math.floor(afterYears / 30.4375);
  const remDays = Math.max(0, Math.round(afterYears - months * 30.4375));
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} ${years === 1 ? "rok" : years < 5 ? "roky" : "let"}`);
  if (months > 0) parts.push(`${months} měs.`);
  if (years === 0 && remDays > 0) parts.push(`${remDays} dní`);
  if (parts.length === 0) parts.push(`${days} dní`);
  return parts.join(" ");
}

interface Lot {
  ticker: string;
  name: string;
  buyDate: Date;
  shares: number;        // remaining shares from this lot (after FIFO sells)
  originalShares: number;
  costPerShare: number;
  days: number;
  remainingDays: number;
  exempt: boolean;
  exemptDate: Date;
  progress: number;
}

/** Build FIFO lots from transactions: each BUY = lot, SELLs reduce earliest lots first */
function buildLots(txs: DbTransaction[], nameMap: Map<string, string>): Lot[] {
  const byTicker = new Map<string, DbTransaction[]>();
  for (const t of txs) {
    if (t.ticker === "CASH") continue;
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker)!.push(t);
  }
  const now = Date.now();
  const lots: Lot[] = [];
  for (const [ticker, list] of byTicker) {
    // sort ascending by date
    const sorted = [...list].sort(
      (a, b) => new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
    );
    const open: { date: Date; shares: number; cost: number }[] = [];
    for (const t of sorted) {
      if (t.side === "BUY") {
        open.push({ date: new Date(t.executed_at), shares: t.shares, cost: t.price_usd });
      } else {
        // SELL — consume FIFO
        let toSell = t.shares;
        while (toSell > 1e-9 && open.length > 0) {
          const lot = open[0];
          const take = Math.min(toSell, lot.shares);
          lot.shares -= take;
          toSell -= take;
          if (lot.shares <= 1e-9) open.shift();
        }
      }
    }
    for (const o of open) {
      if (o.shares <= 1e-9) continue;
      const days = Math.floor((now - o.date.getTime()) / DAY_MS);
      const remainingDays = Math.max(0, DAYS_IN_3Y - days);
      const exempt = days >= DAYS_IN_3Y;
      const exemptDate = new Date(o.date.getTime() + DAYS_IN_3Y * DAY_MS);
      lots.push({
        ticker,
        name: nameMap.get(ticker) ?? ticker,
        buyDate: o.date,
        shares: o.shares,
        originalShares: o.shares,
        costPerShare: o.cost,
        days,
        remainingDays,
        exempt,
        exemptDate,
        progress: Math.min(100, (days / DAYS_IN_3Y) * 100),
      });
    }
  }
  return lots;
}

const TaxReport = () => {
  const { format } = useCurrency();
  const { data: positions = [] } = usePositions();
  const { data: allTxs = [] } = useTransactions();
  const { usdCzk, positions: livePositions } = useComputedPortfolio();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [openTickers, setOpenTickers] = useState<Set<string>>(new Set());
  const toggleTicker = (ticker: string) =>
    setOpenTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker); else next.add(ticker);
      return next;
    });

  // Only real money-moving trades — exclude reconciliation adjustments and cash plumbing.
  const txs = useMemo(
    () => allTxs.filter((t) => { const e = String((t as any).ext_id ?? ""); return !e.includes(":adj:") && !e.includes(":pos:") && t.ticker !== "CASH"; }),
    [allTxs],
  );

  const nameMap = useMemo(() => new Map(positions.map((p) => [p.ticker, p.name])), [positions]);
  const priceMap = useMemo(() => new Map(livePositions.map((p) => [p.ticker, p.currentPrice])), [livePositions]);

  /** All open lots across all positions (FIFO) */
  const lots = useMemo(() => buildLots(txs, nameMap), [txs, nameMap]);

  /** Minimum lot current value (USD) to display — filters out tiny dust positions like residual LRCX */
  const MIN_LOT_VALUE_USD = 90;

  /** Group lots by ticker for display, filtering out dust lots (< $90 current value) */
  const lotsByTicker = useMemo(() => {
    const map = new Map<string, Lot[]>();
    for (const l of lots) {
      const price = priceMap.get(l.ticker) ?? l.costPerShare;
      const value = l.shares * price;
      if (value < MIN_LOT_VALUE_USD) continue;
      if (!map.has(l.ticker)) map.set(l.ticker, []);
      map.get(l.ticker)!.push(l);
    }
    // sort lots within each ticker by buy date asc
    for (const arr of map.values()) arr.sort((a, b) => a.buyDate.getTime() - b.buyDate.getTime());
    return map;
  }, [lots, priceMap]);

  /** Tickers that had a SELL during the selected year — mark as "already realized this year" */
  const soldInYear = useMemo(() => {
    const set = new Set<string>();
    for (const t of txs) {
      if (t.side === "SELL" && new Date(t.executed_at).getFullYear() === year) {
        set.add(t.ticker);
      }
    }
    return set;
  }, [txs, year]);

  /** Summary: how much of current portfolio value is already tax-exempt vs taxable */
  const exemptionSummary = useMemo(() => {
    let exemptCost = 0;
    let taxableCost = 0;
    let exemptValue = 0;
    let taxableValue = 0;
    let exemptShares = 0;
    let taxableShares = 0;
    for (const l of lots) {
      const price = priceMap.get(l.ticker) ?? l.costPerShare;
      const cost = l.shares * l.costPerShare;
      const value = l.shares * price;
      if (l.exempt) {
        exemptCost += cost; exemptValue += value; exemptShares += l.shares;
      } else {
        taxableCost += cost; taxableValue += value; taxableShares += l.shares;
      }
    }
    const totalValue = exemptValue + taxableValue;
    return {
      exemptCost, taxableCost, exemptValue, taxableValue,
      exemptShares, taxableShares,
      exemptPct: totalValue > 0 ? (exemptValue / totalValue) * 100 : 0,
      taxableProfitIfSoldNow: taxableValue - taxableCost,
    };
  }, [lots, priceMap]);

  /** Realized profit/loss split by exempt vs taxable for the selected year (FIFO matched) */
  const realized = useMemo(() => {
    // Re-run FIFO and capture realized rows for the year
    const byTicker = new Map<string, DbTransaction[]>();
    for (const t of txs) {
      if (t.ticker === "CASH") continue;
      if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
      byTicker.get(t.ticker)!.push(t);
    }
    let taxableProfit = 0;
    let exemptProfit = 0;
    const rows: Array<{
      ticker: string;
      date: string;
      shares: number;
      price: number;
      cost: number;
      profit: number;
      heldDays: number;
      exempt: boolean;
    }> = [];

    for (const [ticker, list] of byTicker) {
      const sorted = [...list].sort(
        (a, b) => new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
      );
      const open: { date: Date; shares: number; cost: number }[] = [];
      for (const t of sorted) {
        if (t.side === "BUY") {
          open.push({ date: new Date(t.executed_at), shares: t.shares, cost: t.price_usd });
        } else {
          const sellDate = new Date(t.executed_at);
          let toSell = t.shares;
          let costAccum = 0;
          let oldestLotDate: Date | null = null;
          while (toSell > 1e-9 && open.length > 0) {
            const lot = open[0];
            const take = Math.min(toSell, lot.shares);
            costAccum += take * lot.cost;
            if (!oldestLotDate || lot.date < oldestLotDate) oldestLotDate = lot.date;
            lot.shares -= take;
            toSell -= take;
            if (lot.shares <= 1e-9) open.shift();
          }
          if (sellDate.getFullYear() === year && oldestLotDate) {
            const heldDays = Math.floor((sellDate.getTime() - oldestLotDate.getTime()) / DAY_MS);
            const proceeds = t.price_usd * t.shares - (t.fee_usd || 0);
            const profit = proceeds - costAccum;
            const exempt = heldDays >= DAYS_IN_3Y;
            if (exempt) exemptProfit += profit; else taxableProfit += profit;
            rows.push({
              ticker,
              date: t.executed_at.slice(0, 10),
              shares: t.shares,
              price: t.price_usd,
              cost: costAccum,
              profit,
              heldDays,
              exempt,
            });
          }
        }
      }
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { taxableProfit, exemptProfit, rows };
  }, [txs, year]);

  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    txs.forEach((t) => set.add(new Date(t.executed_at).getFullYear()));
    return Array.from(set).sort((a, b) => b - a);
  }, [txs]);

  const exportCsv = () => {
    const head = "Datum,Ticker,Počet,Cena USD,Náklady USD,Zisk USD,Zisk CZK,Drženo dní,Status";
    const lines = realized.rows.map((r) =>
      [r.date, r.ticker, r.shares, r.price.toFixed(2), r.cost.toFixed(2), r.profit.toFixed(2),
        (r.profit * usdCzk).toFixed(2), r.heldDays, r.exempt ? "Osvobozeno" : "Zdanitelné"].join(",")
    );
    const blob = new Blob([[head, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `danovy-report-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const estTax = realized.taxableProfit > 0 ? realized.taxableProfit * 0.15 : 0;

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 sm:p-6 animate-fade-in-up">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
        <div>
          <h2 className="font-display text-xl font-bold flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" /> Daňový report
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Český 3-letý časový test (FIFO) — každý nákup se sleduje samostatně. Po 3 letech držení je zisk z prodeje osvobozen (§ 4/1/x ZDP)
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value))}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-background"
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={exportCsv} className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-accent inline-flex items-center gap-1.5">
            <Download className="w-3 h-3" /> CSV
          </button>
        </div>
      </div>

      {/* Yearly realized summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="rounded-xl border border-loss/20 bg-loss/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Zdanitelný zisk {year}</p>
          <p className="font-display text-2xl font-bold text-loss mt-1">{format(realized.taxableProfit)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Realizováno, lot &lt; 3 roky</p>
        </div>
        <div className="rounded-xl border border-profit/20 bg-profit/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Osvobozený zisk {year}</p>
          <p className="font-display text-2xl font-bold text-profit mt-1">{format(realized.exemptProfit)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><Shield className="w-3 h-3" /> Lot ≥ 3 roky</p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Odhad daně (15 %)</p>
          <p className="font-display text-2xl font-bold text-warning mt-1">{format(estTax)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Pouze ze zdanitelné části</p>
        </div>
      </div>

      {/* Open portfolio: exempt vs taxable hypothetical */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="rounded-xl border border-profit/30 bg-profit/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
            <Shield className="w-3 h-3" /> Aktuálně osvobozeno (≥ 3 roky)
          </p>
          <p className="font-display text-2xl font-bold text-profit mt-1">{format(exemptionSummary.exemptValue)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {exemptionSummary.exemptShares.toFixed(2)} ks · náklady {format(exemptionSummary.exemptCost)} · {exemptionSummary.exemptPct.toFixed(1)} % portfolia
          </p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
            <Clock className="w-3 h-3" /> Zatím zdanitelné (&lt; 3 roky)
          </p>
          <p className="font-display text-2xl font-bold text-warning mt-1">{format(exemptionSummary.taxableValue)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {exemptionSummary.taxableShares.toFixed(2)} ks · náklady {format(exemptionSummary.taxableCost)} · zisk by činil {format(exemptionSummary.taxableProfitIfSoldNow)}
          </p>
        </div>
      </div>

      {/* Lots timeline grouped by ticker */}
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2"><Layers className="w-4 h-4" /> Časový test jednotlivých nákupů (FIFO loty)</h3>
      <div className="space-y-4 mb-6">
        {lotsByTicker.size === 0 && <p className="text-xs text-muted-foreground">Žádné otevřené nákupy.</p>}
        {Array.from(lotsByTicker.entries()).map(([ticker, tickerLots]) => {
          const totalShares = tickerLots.reduce((s, l) => s + l.shares, 0);
          const exemptShares = tickerLots.filter((l) => l.exempt).reduce((s, l) => s + l.shares, 0);
          const price = priceMap.get(ticker) ?? 0;
          const exemptValue = exemptShares * price;
          const partiallySold = soldInYear.has(ticker);
          const isOpen = openTickers.has(ticker);
          return (
            <div key={ticker} className="rounded-xl border border-border/60 bg-background/30 p-4">
              <button
                type="button"
                onClick={() => toggleTicker(ticker)}
                aria-expanded={isOpen}
                className={`w-full flex items-center justify-between flex-wrap gap-2 text-left ${isOpen ? "mb-3" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`} />
                  <span className="font-mono font-bold text-sm">{ticker}</span>
                  <span className="text-xs text-muted-foreground">· {tickerLots[0].name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                    {totalShares.toFixed(2)} ks
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                    {tickerLots.length} {tickerLots.length === 1 ? "nákup" : tickerLots.length < 5 ? "nákupy" : "nákupů"}
                  </span>
                  {partiallySold && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-semibold uppercase tracking-wider">
                      Část prodána v {year}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {exemptShares > 0 ? (
                    <>Osvobozeno: <span className="font-bold text-profit tabular-nums">{exemptShares.toFixed(2)} ks</span> ({format(exemptValue)})</>
                  ) : (
                    <>Žádný lot zatím není osvobozen</>
                  )}
                </div>
              </button>
              {isOpen && (
              <div className="space-y-2">
                {tickerLots.map((l, i) => {
                  const lotValue = l.shares * (price || l.costPerShare);
                  const lotCost = l.shares * l.costPerShare;
                  const lotPnl = lotValue - lotCost;
                  return (
                  <div key={i} className="rounded-lg border border-border/40 bg-background/40 p-2.5">
                    <div className="flex items-center justify-between mb-1.5 text-xs flex-wrap gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-muted-foreground">#{i + 1}</span>
                        <span className="tabular-nums">
                          <span className="font-bold">{l.shares.toFixed(4)}</span> ks @ ${l.costPerShare.toFixed(2)}
                        </span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Calendar className="w-2.5 h-2.5" /> {l.buyDate.toLocaleDateString("cs-CZ")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {l.exempt ? (
                          <span className="px-2 py-0.5 rounded-full bg-profit/15 text-profit text-[10px] font-bold uppercase flex items-center gap-1">
                            <Shield className="w-3 h-3" /> Osvobozeno
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            Zbývá <span className="font-bold text-foreground">{formatDuration(l.remainingDays)}</span>
                            <span className="text-muted-foreground"> · do {l.exemptDate.toLocaleDateString("cs-CZ")}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between mb-1.5 text-[11px] flex-wrap gap-1">
                      <span className="text-muted-foreground">
                        Aktuální hodnota: <span className={`font-bold tabular-nums ${l.exempt ? "text-profit" : "text-foreground"}`}>{format(lotValue)}</span>
                        <span className="text-muted-foreground"> · náklady {format(lotCost)}</span>
                      </span>
                      <span className={`tabular-nums font-bold ${lotPnl >= 0 ? "text-profit" : "text-loss"}`}>
                        {lotPnl >= 0 ? "+" : ""}{format(lotPnl)}
                        {l.exempt && lotPnl > 0 && <span className="ml-1 text-[10px] font-normal text-profit/80">(bez daně)</span>}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
                      <div
                        className={`h-full transition-all ${l.exempt ? "bg-profit" : "bg-gradient-to-r from-warning to-primary"}`}
                        style={{ width: `${l.progress}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] text-muted-foreground tabular-nums">
                      <span>Drženo {formatDuration(l.days)}</span>
                      <span>{l.progress.toFixed(1)} %</span>
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

      {/* Realized rows */}
      {realized.rows.length > 0 && (
        <>
          <h3 className="text-sm font-bold mb-3">Realizované prodeje {year} (FIFO)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/60">
                  <th className="py-2">Datum</th><th>Ticker</th><th className="text-right">Počet</th>
                  <th className="text-right">Cena</th><th className="text-right">Zisk</th>
                  <th className="text-right">Drženo</th><th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {realized.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="py-1.5">{r.date}</td>
                    <td className="font-mono font-bold">{r.ticker}</td>
                    <td className="text-right tabular-nums">{r.shares}</td>
                    <td className="text-right tabular-nums">${r.price.toFixed(2)}</td>
                    <td className={`text-right tabular-nums font-bold ${r.profit >= 0 ? "text-profit" : "text-loss"}`}>
                      {format(r.profit)}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">{formatDuration(r.heldDays)}</td>
                    <td className="text-right">
                      {r.exempt ? (
                        <span className="text-profit font-bold">Osvobozeno</span>
                      ) : (
                        <span className="text-loss font-bold">Zdanitelné</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default TaxReport;
