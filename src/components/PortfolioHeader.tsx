import { useEffect, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { TrendingUp, TrendingDown, RefreshCw, AlertCircle, Circle, Sparkles, LogOut, History, Eye, EyeOff } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useAuth } from '@/contexts/AuthContext';
import { useComputedPortfolio, useDailySnapshots, useLivePrices } from '@/hooks/usePortfolio';
import { formatPct } from '@/data/portfolio';
import QuickTradeDialog from '@/components/QuickTradeDialog';
import CashAdjustDialog from '@/components/CashAdjustDialog';
import ExportMenu from '@/components/ExportMenu';
import SplitsBanner from '@/components/SplitsBanner';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/** US stock market open between 13:30–20:00 UTC, Mon–Fri (simplified, ignores holidays). */
const isMarketOpen = (now: Date) => {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60;
};

const useNow = () => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
};

const Stat = ({ label, value, sub, accent, icon }: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'profit' | 'loss' | 'neutral';
  icon?: React.ReactNode;
}) => (
  <div className={`group relative flex flex-col gap-1.5 px-4 py-3.5 rounded-xl border transition-all hover-lift ${
    accent === 'profit' ? 'bg-profit/5 border-profit/20 hover:border-profit/40' :
    accent === 'loss' ? 'bg-loss/5 border-loss/20 hover:border-loss/40' :
    'bg-card/40 border-border/60 hover:border-border'
  } backdrop-blur`}>
    <div className="flex items-center gap-1.5">
      {icon && <span className={`${
        accent === 'profit' ? 'text-profit' : accent === 'loss' ? 'text-loss' : 'text-muted-foreground'
      }`}>{icon}</span>}
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">{label}</span>
    </div>
    <span className={`font-display text-base sm:text-lg font-bold leading-tight tabular-nums ${
      accent === 'profit' ? 'text-profit' : accent === 'loss' ? 'text-loss' : 'text-foreground'
    }`}>{value}</span>
    {sub && <span className="text-[11px] text-muted-foreground tabular-nums">{sub}</span>}
  </div>
);

const PortfolioHeader = () => {
  const { currency, setCurrency, format, hidden, toggleHidden } = useCurrency();
  const { user, signOut } = useAuth();
  const live = useLivePrices();
  const p = useComputedPortfolio();
  const { data: snapshots = [] } = useDailySnapshots();
  const now = useNow();
  const marketOpen = isMarketOpen(now);
  const qc = useQueryClient();

  const dailyPositive = p.dailyReturn >= 0;
  // Total profit = current value − net deposits (honest "how much more I have than I put
  // in", includes realized gains from sold positions). Falls back to realized+unrealized.
  const totalProfit = p.totalProfit;
  const prevValue = p.totalValue - p.dailyReturn;
  const dailyPctTotal = prevValue > 0 ? (p.dailyReturn / prevValue) * 100 : 0;

  const updatedAt = live.data?.fetchedAt ? new Date(live.data.fetchedAt).toLocaleTimeString('cs-CZ') : '—';

  // Sparkline from last 60 snapshots. Colour it by the DAILY change shown right next to it
  // (not the 60-day trend) — otherwise the line is red while "+x % dnes" is green, which
  // reads as a bug. The shape still reflects the 60-day history.
  const spark = snapshots.slice(-60).map((s) => ({ v: currency === 'USD' ? s.value_usd : s.value_czk }));
  const sparkColor = dailyPositive ? 'hsl(var(--profit))' : 'hsl(var(--loss))';

  const [backfilling, setBackfilling] = useState(false);

  // "Doplnit historii" runs the server-side rebuild. That rebuild is a SECOND engine beside
  // the nightly worker, and the two only agree when both are deployed from the same commit —
  // a stale edge function silently replaces a good history with a worse one, which is exactly
  // how this chart got wrecked once already. So the button is only offered when there is
  // actually a gap to fill. With history already reaching yesterday there is nothing to add:
  // the nightly job rebuilds every day from scratch anyway.
  const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  const historyComplete = snapshots.length > 0 && snapshots[snapshots.length - 1].snapshot_date >= yesterday;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['live-prices'] });
    qc.invalidateQueries({ queryKey: ['positions'] });
    qc.invalidateQueries({ queryKey: ['daily-snapshots'] });
  };

  const backfill = async () => {
    if (backfilling) return;
    setBackfilling(true);
    const t = toast.loading('Doplňuji historii portfolia…');
    try {
      let done = false, rounds = 0;
      while (!done && rounds < 60) {
        rounds++;
        const { data, error } = await supabase.functions.invoke('backfill-snapshots', { method: 'POST' });
        if (error) throw error;
        const d = data as any;
        if (d?.error) throw new Error(d.error);
        done = !!d.done;
        if (!done) toast.loading(`Stahuji historii cen… (zbývá ${d.remaining})`, { id: t });
        else toast.success(`Historie doplněna (${d.snapshots ?? 0} dní).`, { id: t, duration: 7000 });
      }
      qc.invalidateQueries({ queryKey: ['daily-snapshots'] });
    } catch (e: any) {
      toast.error(`Backfill selhal: ${e?.message ?? 'neznámá chyba'}`, { id: t });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-card via-card to-background p-6 sm:p-8 animate-fade-in-up">
      {/* glow accents */}
      <div
        className="pointer-events-none absolute -top-32 -right-32 h-80 w-80 rounded-full blur-3xl opacity-25 pulse-glow"
        style={{ background: dailyPositive ? 'hsl(var(--profit))' : 'hsl(var(--loss))' }}
      />
      <div className="pointer-events-none absolute -bottom-40 -left-20 h-72 w-72 rounded-full blur-3xl opacity-15"
        style={{ background: 'hsl(var(--info))' }}
      />
      {/* subtle grid */}
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-[0.15]" />

      <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT — Hero number */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${
              marketOpen
                ? 'bg-profit/10 border-profit/30'
                : 'bg-loss/10 border-loss/30'
            }`}>
              <Circle className={`w-2 h-2 fill-current ${marketOpen ? 'text-profit animate-pulse' : 'text-loss'}`} strokeWidth={0} />
              <span className={`text-[10px] font-bold uppercase tracking-wider ${marketOpen ? 'text-profit' : 'text-loss'}`}>
                {marketOpen ? 'Market Open' : 'Market Closed'}
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground/70 font-mono tabular-nums">
              {now.toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-primary" /> Hodnota portfolia
            </p>
            <h1 className="font-display text-4xl sm:text-5xl xl:text-6xl font-bold text-foreground tracking-tight leading-none tabular-nums">
              {format(p.totalValue)}
            </h1>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center gap-1 font-display text-lg font-bold tabular-nums ${dailyPositive ? 'text-profit glow-profit' : 'text-loss glow-loss'}`}>
                {dailyPositive ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                {dailyPositive ? '+' : ''}{format(p.dailyReturn)}
              </span>
              <span className={`px-2 py-0.5 rounded-md text-xs font-bold ${dailyPositive ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss'}`}>
                {formatPct(dailyPctTotal)}
              </span>
              <span className="text-xs text-muted-foreground">dnes</span>
            </div>
          </div>

          {/* Sparkline */}
          {spark.length > 1 && (
            <div className="h-16 -mx-1">
              <ResponsiveContainer>
                <AreaChart data={spark}>
                  <defs>
                    <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={sparkColor} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={sparkColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke={sparkColor} strokeWidth={2.5} fill="url(#sparkFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* RIGHT — Stats grid */}
        <div className="lg:col-span-7 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center flex-wrap gap-2 text-xs text-muted-foreground">
              <button
                onClick={refresh}
                disabled={live.isFetching}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50"
                title="Obnovit ceny"
              >
                <RefreshCw className={`w-3 h-3 ${live.isFetching ? 'animate-spin text-primary' : ''}`} />
                <span className="font-medium">Obnovit</span>
              </button>
              <button
                onClick={backfill}
                disabled={backfilling || historyComplete}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:hover:border-border disabled:cursor-not-allowed"
                title={historyComplete
                  ? 'Historie je kompletní až do včerejška. Přepočítává se automaticky každou noc — ruční doplňování by ji jen přepsalo horším výpočtem.'
                  : 'Doplnit historii portfolia z transakcí'}
              >
                <History className={`w-3 h-3 ${backfilling ? 'animate-spin text-primary' : ''}`} />
                <span className="font-medium">{backfilling ? 'Doplňuji…' : historyComplete ? 'Historie je kompletní' : 'Doplnit historii'}</span>
              </button>
              <span className="hidden sm:inline text-[10px] text-muted-foreground/70">{updatedAt}</span>
              <span className="text-border hidden sm:inline">·</span>
              <span className="font-mono tabular-nums text-[10px] text-muted-foreground/70">USD/CZK {p.usdCzk.toFixed(2)}</span>
              {p.stale && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <AlertCircle className="w-3 h-3" /> Cached
                </span>
              )}
            </div>
            <div className="flex items-center flex-wrap gap-2 justify-start sm:justify-end w-full sm:w-auto">
              <button
                onClick={toggleHidden}
                className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
                  hidden ? 'bg-primary/10 border-primary/40 text-primary' : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/50'
                }`}
                title={hidden ? 'Zobrazit částky' : 'Skrýt částky (pro sdílení obrazovky)'}
                aria-label={hidden ? 'Zobrazit částky' : 'Skrýt částky'}
              >
                {hidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <QuickTradeDialog />
              <CashAdjustDialog />
              <ExportMenu />
              <div className="flex items-center rounded-lg border border-border overflow-hidden bg-background/40">
              <button
                onClick={() => setCurrency('USD')}
                className={`px-3 py-1 text-xs font-semibold transition-all ${
                  currency === 'USD' ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >USD</button>
              <button
                onClick={() => setCurrency('CZK')}
                className={`px-3 py-1 text-xs font-semibold transition-all ${
                  currency === 'CZK' ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >CZK</button>
              </div>
              {user && (
                <button
                  onClick={signOut}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
                  title={user.email ?? 'Odhlásit'}
                >
                  <LogOut className="w-3 h-3" /> Odhlásit
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-3">
            <Stat label="Vloženo" value={format(p.netDepositsUsd ?? p.totalInvested)} />
            <Stat
              label="Nerealiz. zisk"
              value={format(p.unrealizedProfit)}
              sub={formatPct(p.totalProfitPct)}
              accent={p.unrealizedProfit >= 0 ? 'profit' : 'loss'}
            />
            <Stat
              label="Realiz. zisk"
              value={format(p.realizedProfit)}
              accent={p.realizedProfit >= 0 ? 'profit' : 'loss'}
            />
            <Stat
              label="Celkový zisk"
              value={format(totalProfit)}
              sub={formatPct(p.totalReturnPct)}
              accent={totalProfit >= 0 ? 'profit' : 'loss'}
            />
          </div>
        </div>
      </div>
      <div className="relative mt-4">
        <SplitsBanner />
      </div>
    </div>
  );
};

export default PortfolioHeader;
