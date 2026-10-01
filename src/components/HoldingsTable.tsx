import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, Loader2, Check, X, Pencil, Search, TrendingUp, TrendingDown, Wallet, Briefcase, DollarSign } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio, type LivePosition } from '@/hooks/usePortfolio';
import { formatPct } from '@/data/portfolio';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TickerLogo } from '@/components/TickerLogo';

type SortKey = keyof LivePosition;

const HoldingsTable = () => {
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortAsc, setSortAsc] = useState(false);
  const [query, setQuery] = useState('');
  const { format, currency } = useCurrency();
  const { positions, loading } = useComputedPortfolio();
  // return in the displayed currency: CZK includes the USD/CZK move (matches T212),
  // USD is the pure stock return (matches Revolut).
  const pctOf = (p: { profitPct: number; profitPctCzk: number }) => (currency === 'CZK' ? p.profitPctCzk : p.profitPct);
  const qc = useQueryClient();

  const cash = positions.find((p) => p.type === 'Cash' || p.ticker === 'CASH');
  const stocks = positions.filter((p) => p !== cash);

  const filtered = stocks.filter((p) =>
    !query.trim() || p.ticker.toLowerCase().includes(query.trim().toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return sortAsc ? av - bv : bv - av;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const SortHeader = ({ label, field, className = '' }: { label: string; field: SortKey; className?: string }) => {
    const active = sortKey === field;
    return (
      <th
        className={`px-4 py-3.5 text-[10px] font-semibold uppercase tracking-[0.12em] cursor-pointer select-none transition-colors ${
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        } ${className}`}
        onClick={() => handleSort(field)}
      >
        <div className={`flex items-center gap-1.5 ${className.includes('text-right') ? 'justify-end' : ''}`}>
          {label}
          <ArrowUpDown className={`w-3 h-3 transition-opacity ${active ? 'opacity-100 text-primary' : 'opacity-40'}`} />
        </div>
      </th>
    );
  };

  // Editable cash state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing && cash) setDraft(String(cash.value));
  }, [cash?.value, editing]);

  const saveCash = async () => {
    const amount = parseFloat(draft.replace(',', '.'));
    if (isNaN(amount) || amount < 0) { toast.error('Neplatná částka'); return; }
    setSaving(true);
    const { error } = await supabase.from('positions').update({ shares: amount, avg_cost_usd: 1 }).eq('ticker', 'CASH');
    setSaving(false);
    if (error) { toast.error('Uložení selhalo'); return; }
    setEditing(false);
    qc.invalidateQueries({ queryKey: ['positions'] });
    toast.success('Cash aktualizován');
  };

  const totalInvested = positions.reduce((s, p) => s + p.invested, 0);
  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  const totalProfit = stocks.reduce((s, p) => s + p.profitUsd, 0);
  const totalProfitPct = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

  const { winners, losers, bestPct, worstPct } = useMemo(() => {
    const w = stocks.filter((p) => p.profitUsd > 0).length;
    const l = stocks.filter((p) => p.profitUsd < 0).length;
    const sortedPct = [...stocks].sort((a, b) => b.profitPct - a.profitPct);
    return { winners: w, losers: l, bestPct: sortedPct[0], worstPct: sortedPct[sortedPct.length - 1] };
  }, [stocks]);

  const maxAllocation = Math.max(...stocks.map((p) => p.allocation), 1);
  const dash = <span className="text-muted-foreground/50">—</span>;

  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-card via-card/80 to-background animate-fade-in-up">
      {/* Decorative glow */}
      <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-96 h-96 rounded-full bg-info/5 blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="relative px-6 sm:px-8 pt-6 pb-5 border-b border-border/50">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center">
              <Briefcase className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="font-display font-bold text-2xl tracking-tight text-foreground">Pozice</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {stocks.length} aktivních pozic{cash ? ' + cash' : ''} {loading && <Loader2 className="inline w-3 h-3 animate-spin ml-1" />}
              </p>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Hledat ticker..."
              className="h-10 w-56 rounded-xl border border-border bg-background/60 pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 transition-all"
            />
          </div>
        </div>

        {/* Stat strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <StatPill icon={<Wallet className="w-3.5 h-3.5" />} label="Hodnota" value={format(totalValue)} />
          <StatPill icon={<DollarSign className="w-3.5 h-3.5" />} label="Investováno" value={format(totalInvested)} />
          <StatPill
            icon={totalProfit >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            label="Celkový P/L"
            value={format(totalProfit)}
            sub={formatPct(totalProfitPct)}
            tone={totalProfit >= 0 ? 'profit' : 'loss'}
          />
          <StatPill
            icon={<TrendingUp className="w-3.5 h-3.5" />}
            label="Vítězů / Ztrát"
            value={`${winners} / ${losers}`}
            sub={bestPct ? `Top: ${bestPct.ticker} ${formatPct(pctOf(bestPct))}` : ''}
          />
        </div>
      </div>

      {/* Table */}
      <div className="relative overflow-x-auto">
        <table className="w-full">
          <thead className="bg-background/30 border-b border-border/50">
            <tr>
              <SortHeader label="Pozice" field="ticker" />
              <SortHeader label="Akcie" field="shares" className="text-right" />
              <SortHeader label="Nákupka" field="avgPrice" className="text-right" />
              <SortHeader label="Cena" field="currentPrice" className="text-right" />
              <SortHeader label="Denní" field="dailyChangePct" className="text-right" />
              <SortHeader label="Investováno" field="invested" className="text-right" />
              <SortHeader label="Hodnota" field="value" className="text-right" />
              <SortHeader label="Zisk" field="profitUsd" className="text-right" />
              <SortHeader label="Alokace" field="allocation" className="text-right pr-6" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, idx) => {
              const allocBar = (p.allocation / maxAllocation) * 100;
              const isProfit = p.profitUsd >= 0;
              const dailyProfit = p.dailyChangePct >= 0;
              return (
                <tr
                  key={p.ticker}
                  className="group border-b border-border/30 hover:bg-primary/[0.03] transition-all duration-200"
                  style={{ animationDelay: `${idx * 20}ms` }}
                >
                  {/* Ticker cell */}
                  <td className="px-4 py-4">
                    <Link to={`/stock/${p.ticker}`} className="flex items-center gap-3 group/link">
                      <TickerLogo ticker={p.ticker} />
                      <div className="min-w-0">
                        <div className="font-display font-bold text-sm text-foreground group-hover/link:text-primary transition-colors">
                          {p.ticker}
                        </div>
                        {p.type && (
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">
                            {p.type}
                          </div>
                        )}
                      </div>
                    </Link>
                  </td>

                  <td className="px-4 py-4 text-right text-sm tabular-nums text-secondary-foreground">
                    {p.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                  </td>
                  <td className="px-4 py-4 text-right text-sm tabular-nums text-muted-foreground">{format(p.avgPrice)}</td>
                  <td className="px-4 py-4 text-right text-sm font-semibold tabular-nums text-foreground">{format(p.currentPrice)}</td>

                  {/* Daily % chip */}
                  <td className="px-4 py-4 text-right">
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold tabular-nums ${
                      dailyProfit ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'
                    }`}>
                      {dailyProfit ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {formatPct(p.dailyChangePct)}
                    </span>
                  </td>

                  <td className="px-4 py-4 text-right text-sm tabular-nums text-muted-foreground">{format(p.invested)}</td>
                  <td className="px-4 py-4 text-right text-sm font-semibold tabular-nums text-foreground">{format(p.value)}</td>

                  {/* Profit (combined $ + %) */}
                  <td className="px-4 py-4 text-right">
                    <div className={`font-display font-bold text-sm tabular-nums ${isProfit ? 'text-profit' : 'text-loss'}`}>
                      {format(p.profitUsd)}
                    </div>
                    <div className={`text-[11px] tabular-nums ${isProfit ? 'text-profit/80' : 'text-loss/80'}`}>
                      {formatPct(pctOf(p))}
                    </div>
                  </td>

                  {/* Allocation with bar */}
                  <td className="px-4 py-4 pr-6">
                    <div className="flex items-center justify-end gap-2.5 min-w-[110px]">
                      <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden max-w-[80px]">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary/80 to-primary transition-all duration-500"
                          style={{ width: `${allocBar}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-foreground w-10 text-right">
                        {p.allocation.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}

            {/* CASH row */}
            {cash && (
              <tr className="border-b border-border/30 bg-info/[0.03] hover:bg-info/[0.06] transition-colors">
                <td className="px-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-info/30 to-info/10 ring-1 ring-info/30 flex items-center justify-center">
                      <Wallet className="w-4 h-4 text-info" />
                    </div>
                    <div>
                      <div className="font-display font-bold text-sm text-foreground">CASH</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">Hotovost</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4 text-right text-sm">{dash}</td>
                <td className="px-4 py-4 text-right text-sm">{dash}</td>
                <td className="px-4 py-4 text-right text-sm">{dash}</td>
                <td className="px-4 py-4 text-right text-sm">{dash}</td>
                <td className="px-4 py-4 text-right text-sm">{dash}</td>
                <td className="px-4 py-4 text-right text-sm font-semibold text-foreground">
                  {editing ? (
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number"
                        step="0.01"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveCash();
                          if (e.key === 'Escape') setEditing(false);
                        }}
                        autoFocus
                        className="w-28 h-8 rounded-lg border border-border bg-background px-2 text-right text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      />
                      <button onClick={saveCash} disabled={saving} className="p-1.5 rounded-lg hover:bg-profit/10 text-profit" aria-label="Uložit">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditing(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground" aria-label="Zrušit">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 hover:text-primary transition-colors group">
                      <span className="tabular-nums">{format(cash.value)}</span>
                      <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  )}
                </td>
                <td className="px-4 py-4 text-right text-sm">{dash}</td>
                <td className="px-4 py-4 pr-6">
                  <div className="flex items-center justify-end gap-2.5 min-w-[110px]">
                    <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden max-w-[80px]">
                      <div className="h-full rounded-full bg-info/60" style={{ width: `${(cash.allocation / maxAllocation) * 100}%` }} />
                    </div>
                    <span className="text-xs font-semibold tabular-nums text-foreground w-10 text-right">
                      {cash.allocation.toFixed(1)}%
                    </span>
                  </div>
                </td>
              </tr>
            )}

            {sorted.length === 0 && !cash && !loading && (
              <tr><td colSpan={9} className="text-center py-12 text-sm text-muted-foreground">Žádné pozice</td></tr>
            )}
          </tbody>

          {(sorted.length > 0 || cash) && (
            <tfoot>
              <tr className="bg-background/40 border-t-2 border-border/60">
                <td className="px-4 py-4 font-display font-bold text-sm text-foreground uppercase tracking-wider">Celkem</td>
                <td colSpan={4}></td>
                <td className="px-4 py-4 text-right text-sm font-bold tabular-nums text-foreground">{format(totalInvested)}</td>
                <td className="px-4 py-4 text-right text-sm font-bold tabular-nums text-foreground">{format(totalValue)}</td>
                <td className="px-4 py-4 text-right">
                  <div className={`font-display font-bold text-sm tabular-nums ${totalProfit >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {format(totalProfit)}
                  </div>
                  <div className={`text-[11px] tabular-nums ${totalProfit >= 0 ? 'text-profit/80' : 'text-loss/80'}`}>
                    {formatPct(totalProfitPct)}
                  </div>
                </td>
                <td className="px-4 py-4 pr-6 text-right text-sm font-bold tabular-nums text-foreground">100%</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
};

const StatPill = ({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'profit' | 'loss' }) => (
  <div className="rounded-2xl border border-border/50 bg-background/40 backdrop-blur-sm px-4 py-3 hover:border-border transition-colors">
    <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
      {icon}
      <span className="text-[10px] uppercase tracking-[0.12em] font-semibold">{label}</span>
    </div>
    <div className={`font-display font-bold text-lg tabular-nums leading-tight ${
      tone === 'profit' ? 'text-profit' : tone === 'loss' ? 'text-loss' : 'text-foreground'
    }`}>{value}</div>
    {sub && <div className={`text-[11px] mt-0.5 tabular-nums ${
      tone === 'profit' ? 'text-profit/80' : tone === 'loss' ? 'text-loss/80' : 'text-muted-foreground'
    }`}>{sub}</div>}
  </div>
);

export default HoldingsTable;
