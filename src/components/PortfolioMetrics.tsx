import { useMemo } from "react";
import { Activity, TrendingDown, Gauge, Shuffle, AlertTriangle } from "lucide-react";
import { useDailySnapshots, useComputedPortfolio, useTransactions } from "@/hooks/usePortfolio";
import { useCurrency } from "@/contexts/CurrencyContext";
import { currentLang } from "@/i18n";
import { wrapSymbol } from "@/lib/displayCurrency";

const PortfolioMetrics = () => {
  const { data: snaps = [] } = useDailySnapshots();
  const { data: txs = [] } = useTransactions();
  const { positions, totalValue } = useComputedPortfolio();
  const { currency, hidden } = useCurrency();

  const { sharpe, vol, drawdown, peak, peakCzk } = useMemo(() => {
    if (snaps.length < 5) return { sharpe: 0, vol: 0, drawdown: 0, peak: 0, peakCzk: 0 };

    // Net trade value injected per day (buys add value, sells remove it). Daily RETURNS
    // must exclude this — otherwise a deposit/buy day looks like a huge market move and
    // wrecks volatility/Sharpe (e.g. the first buys turned into a +4541% "return").
    const flowByDate = new Map<string, number>();
    for (const t of txs as any[]) {
      if (t.ticker === "CASH") continue;
      const ext = String(t.ext_id ?? "");
      if (ext.includes(":adj:") || ext.includes(":pos:")) continue;
      const d = t.executed_at.slice(0, 10);
      flowByDate.set(d, (flowByDate.get(d) ?? 0) + (t.side === "BUY" ? 1 : -1) * t.shares * t.price_usd);
    }

    // Use PURE market days only: skip days with a deposit/trade (flow) and skip
    // carried-forward no-change days (weekends/holidays). This removes the execution-
    // price vs close bias and the zero-return dilution, giving a clean daily return.
    const returns: number[] = [];
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1].value_usd;
      const cur = snaps[i].value_usd;
      if (prev < 500) continue; // ignore tiny-base early days (noise)
      if (Math.abs(flowByDate.get(snaps[i].snapshot_date) ?? 0) > 1) continue; // skip deposit/trade days
      const r = (cur - prev) / prev;
      if (Math.abs(r) < 1e-7) continue; // skip non-trading carried days
      if (Math.abs(r) < 0.5) returns.push(r); // drop residual data glitches (>50%/day)
    }
    if (returns.length < 5) return { sharpe: 0, vol: 0, drawdown: 0, peak: 0, peakCzk: 0 };

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const sd = Math.sqrt(variance);
    const annVol = sd * Math.sqrt(252) * 100;
    const annReturn = mean * 252;
    const sharpe = sd > 0 ? (annReturn - 0.05) / (sd * Math.sqrt(252)) : 0;

    // Drawdown on the deposit-adjusted cumulative return index (deposits don't count as
    // recovery; a market fall is measured purely as performance). Pure market days only.
    let idx = 1, peakIdx = 1, maxDd = 0, peakVal = 0, peakValCzk = 0;
    const first = snaps.find((s) => s.value_usd >= 500) ?? snaps[0];
    let runVal = first.value_usd, runValCzk = first.value_czk;
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1].value_usd;
      if (prev < 500) continue;
      if (Math.abs(flowByDate.get(snaps[i].snapshot_date) ?? 0) > 1) continue;
      const r = (snaps[i].value_usd - prev) / prev;
      if (Math.abs(r) < 1e-7 || Math.abs(r) >= 0.5) continue;
      idx *= 1 + r;
      runVal = snaps[i].value_usd;
      runValCzk = snaps[i].value_czk;
      if (idx > peakIdx) { peakIdx = idx; peakVal = runVal; peakValCzk = runValCzk; }
      const dd = (idx - peakIdx) / peakIdx;
      if (dd < maxDd) maxDd = dd;
    }
    return { sharpe, vol: annVol, drawdown: maxDd * 100, peak: peakVal || runVal, peakCzk: peakValCzk || runValCzk };
  }, [snaps, txs]);

  const concentration = useMemo(() => {
    if (totalValue <= 0) return { top: null as any, hhi: 0 };
    const sorted = [...positions].filter((p) => p.ticker !== "CASH").sort((a, b) => b.value - a.value);
    const top = sorted[0];
    const hhi = sorted.reduce((s, p) => s + ((p.value / totalValue) * 100) ** 2, 0);
    return { top, hhi };
  }, [positions, totalValue]);

  const concentrationRisk = (concentration.top?.allocation ?? 0) > 25;

  const Card = ({ icon, label, value, sub, accent }: any) => (
    <div className={`rounded-xl border p-4 ${
      accent === "warning" ? "border-warning/30 bg-warning/5" :
      accent === "loss" ? "border-loss/30 bg-loss/5" :
      "border-border bg-background/40"
    }`}>
      <div className="flex items-center gap-1.5 mb-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <p className={`font-display text-2xl font-bold tabular-nums ${
        accent === "warning" ? "text-warning" : accent === "loss" ? "text-loss" : "text-foreground"
      }`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <h2 className="font-display text-lg font-bold flex items-center gap-2 mb-4">
        <Gauge className="w-5 h-5 text-primary" /> Pokročilé metriky
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card
          icon={<Activity className="w-3.5 h-3.5" />}
          label="Sharpe ratio"
          value={sharpe.toFixed(2)}
          sub={sharpe > 1 ? "Výborné" : sharpe > 0 ? "Solidní" : "Nízké"}
          accent={sharpe < 0 ? "loss" : undefined}
        />
        <Card
          icon={<Shuffle className="w-3.5 h-3.5" />}
          label="Volatilita (roční)"
          value={`${vol.toFixed(1)}%`}
          sub={vol < 15 ? "Nízká" : vol < 25 ? "Střední" : "Vysoká"}
        />
        <Card
          icon={<TrendingDown className="w-3.5 h-3.5" />}
          label="Max drawdown"
          value={`${drawdown.toFixed(1)}%`}
          sub={hidden ? "Peak ••••" : currency === "USD" ? `Peak $${(peak / 1000).toFixed(1)}k` : `Peak ${wrapSymbol(`${(peakCzk / 1000).toFixed(currency === "CZK" ? 0 : 1)}k`, currency, currentLang() === "en" ? "en" : "cs")}`}

          accent="loss"
        />
        <Card
          icon={<AlertTriangle className="w-3.5 h-3.5" />}
          label="Koncentrace"
          value={concentration.top ? `${(concentration.top.allocation ?? 0).toFixed(1)}%` : "—"}
          sub={concentration.top ? `Top: ${concentration.top.ticker}` : ""}
          accent={concentrationRisk ? "warning" : undefined}
        />
      </div>
      {concentrationRisk && (
        <div className="mt-3 text-[11px] text-warning flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" />
          {concentration.top.ticker} tvoří {(concentration.top.allocation ?? 0).toFixed(1)}% portfolia — zvaž diverzifikaci.
        </div>
      )}
    </div>
  );
};

export default PortfolioMetrics;
