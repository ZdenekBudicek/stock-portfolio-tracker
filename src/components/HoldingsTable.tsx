import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, Loader2, Check, X, Pencil, Search, TrendingUp, TrendingDown, Wallet, Briefcase, DollarSign } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio, isCashPosition, type LivePosition } from '@/hooks/usePortfolio';
import { formatPct } from '@/data/portfolio';
import { decimalsOf } from '@/lib/displayCurrency';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TickerLogo } from '@/components/TickerLogo';

type SortKey = keyof LivePosition;

const HoldingsTable = () => {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortAsc, setSortAsc] = useState(false);
  const [query, setQuery] = useState('');
  const { formatAt, pick, currency, rate } = useCurrency();
  const portfolio = useComputedPortfolio();
  const { positions, loading } = portfolio;
  // Everything in the displayed currency. Local (koruny or the chosen one): cost at the
  // purchase-day rate, value at today's, so amount, % and colour all include the currency move
  // (matches T212); USD is the pure stock
  // return (matches Revolut). Mixing them showed "−156 Kč (+3,89 %)".
  const pctOf = (p: LivePosition) => pick(p.profitPct, p.profitPctCzk);
  const pnlOf = (p: LivePosition) => pick(p.profitUsd, p.profitCzk);
  const qc = useQueryClient();

  const cash = positions.find(isCashPosition);
  const stocks = positions.filter((p) => p !== cash);

  const filtered = stocks.filter((p) =>
    !query.trim() || p.ticker.toLowerCase().includes(query.trim().toLowerCase())
  );

  // In the local currency the cost columns sort by their local figures, which don't follow the USD order.
  const czkKey: Partial<Record<SortKey, SortKey>> = { avgPrice: 'avgPriceCzk', invested: 'investedCzk', profitUsd: 'profitCzk', profitPct: 'profitPctCzk' };
  const sortField = (currency !== 'USD' && czkKey[sortKey]) || sortKey;
  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortField] as number;
    const bv = b[sortField] as number;
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

  // The field is edited in the displayed currency; the balance is stored in USD. Saving the
  // typed koruny as dollars turned 25 000 Kč into $25 000.
  useEffect(() => {
    if (!editing && cash) setDraft(currency !== 'USD' ? (cash.value * rate).toFixed(decimalsOf(currency)) : cash.value.toFixed(2));
  }, [cash?.value, editing, currency, rate]);

  const saveCash = async () => {
    const amount = parseFloat(draft.replace(',', '.'));
    if (isNaN(amount) || amount < 0) { toast.error(t('legacy.holdingsTable.invalidAmount')); return; }
    if (currency !== 'USD' && !(rate > 0)) { toast.error(t('legacy.holdingsTable.usdCzkExchangeRateMissing', { currency })); return; }
    const amountUsd = currency !== 'USD' ? amount / rate : amount;
    setSaving(true);
    const { error } = await supabase.from('positions').update({ shares: amountUsd, avg_cost_usd: 1 }).eq('ticker', 'CASH');
    setSaving(false);
    if (error) { toast.error(t('legacy.holdingsTable.saveFailed')); return; }
    setEditing(false);
    qc.invalidateQueries({ queryKey: ['positions'] });
    toast.success(t('legacy.holdingsTable.cashUpdated'));
  };

  // Totals of the positions. Cash has no cost and no return, so it stays out of Investováno
  // and the P/L % — it only adds to Hodnota.
  // Model totals include dust even though the shared display list hides it.
  const totalInvested = pick(portfolio.totalInvested, portfolio.totalInvestedCzk);
  const totalValue = pick(portfolio.totalValue, portfolio.totalValue * portfolio.usdLocal);
  const totalProfit = pick(portfolio.unrealizedProfit, portfolio.unrealizedProfitCzk);
  const totalProfitPct = pick(portfolio.totalProfitPct, portfolio.totalProfitPctCzk);
  const money = (v: number) => formatAt(v, v); // v is already in the displayed currency

  const { winners, losers, bestPct } = useMemo(() => {
    const w = stocks.filter((p) => pnlOf(p) > 0).length;
    const l = stocks.filter((p) => pnlOf(p) < 0).length;
    const sortedPct = [...stocks].sort((a, b) => pctOf(b) - pctOf(a));
    return { winners: w, losers: l, bestPct: sortedPct[0] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocks, currency]);

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
              <h2 className="font-display font-bold text-2xl tracking-tight text-foreground">{t('legacy.holdingsTable.holdings')}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('legacy.holdingsTable.activeCount', { count: stocks.length })}{cash ? t('legacy.holdingsTable.cashSuffix') : ''} {loading && <Loader2 className="inline w-3 h-3 animate-spin ml-1" />}
              </p>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('legacy.holdingsTable.searchTicker')}
              className="h-10 w-56 rounded-xl border border-border bg-background/60 pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 transition-all"
            />
          </div>
        </div>

        {/* Stat strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <StatPill icon={<Wallet className="w-3.5 h-3.5" />} label={t('legacy.holdingsTable.value')} value={money(totalValue)} />
          <StatPill icon={<DollarSign className="w-3.5 h-3.5" />} label={t('legacy.holdingsTable.invested')} value={money(totalInvested)} />
          <StatPill
            icon={totalProfit >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            label={t('legacy.holdingsTable.totalPL')}
            value={money(totalProfit)}
            sub={formatPct(totalProfitPct)}
            tone={totalProfit >= 0 ? 'profit' : 'loss'}
          />
          <StatPill
            icon={<TrendingUp className="w-3.5 h-3.5" />}
            label={t('legacy.holdingsTable.winnersLosers')}
            value={`${winners} / ${losers}`}
            sub={bestPct ? t('legacy.holdingsTable.topHolding', { ticker: bestPct.ticker, percent: formatPct(pctOf(bestPct)) }) : ''}
          />
        </div>
      </div>

      {/* Table */}
      <div className="relative overflow-x-auto">
        <table className="w-full">
          <thead className="bg-background/30 border-b border-border/50">
            <tr>
              <SortHeader label={t('legacy.holdingsTable.holdings')} field="ticker" />
              <SortHeader label={t('legacy.holdingsTable.shares')} field="shares" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.costBasis')} field="avgPrice" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.price')} field="currentPrice" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.daily')} field="dailyChangePct" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.invested')} field="invested" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.value')} field="value" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.profit')} field="profitUsd" className="text-right" />
              <SortHeader label={t('legacy.holdingsTable.allocation')} field="allocation" className="text-right pr-6" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, idx) => {
              const allocBar = (p.allocation / maxAllocation) * 100;
              const isProfit = pnlOf(p) >= 0;
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
                            {t(`common.assetType.${p.type}`, { defaultValue: p.type })}
                          </div>
                        )}
                      </div>
                    </Link>
                  </td>

                  <td className="px-4 py-4 text-right text-sm tabular-nums text-secondary-foreground">
                    {p.shares.toLocaleString(currentLocale(), { maximumFractionDigits: 4 })}
                  </td>
                  <td className="px-4 py-4 text-right text-sm tabular-nums text-muted-foreground">{formatAt(p.avgPrice, p.avgPriceCzk)}</td>
                  <td className="px-4 py-4 text-right text-sm font-semibold tabular-nums text-foreground">{formatAt(p.currentPrice, p.currentPrice * rate)}</td>

                  {/* Daily % chip */}
                  <td className="px-4 py-4 text-right">
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold tabular-nums ${
                      dailyProfit ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'
                    }`}>
                      {dailyProfit ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {formatPct(p.dailyChangePct)}
                    </span>
                  </td>

                  <td className="px-4 py-4 text-right text-sm tabular-nums text-muted-foreground">{formatAt(p.invested, p.investedCzk)}</td>
                  <td className="px-4 py-4 text-right text-sm font-semibold tabular-nums text-foreground">{formatAt(p.value, p.valueCzk)}</td>

                  {/* Profit (combined $ + %) */}
                  <td className="px-4 py-4 text-right">
                    <div className={`font-display font-bold text-sm tabular-nums ${isProfit ? 'text-profit' : 'text-loss'}`}>
                      {formatAt(p.profitUsd, p.profitCzk)}
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
                        {p.allocation.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
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
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">{t('legacy.holdingsTable.cash')}</div>
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
                      <button onClick={saveCash} disabled={saving} className="p-1.5 rounded-lg hover:bg-profit/10 text-profit" aria-label={t('legacy.holdingsTable.save')}>
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditing(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground" aria-label={t('legacy.holdingsTable.cancel')}>
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 hover:text-primary transition-colors group">
                      <span className="tabular-nums">{formatAt(cash.value, cash.valueCzk)}</span>
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
                      {cash.allocation.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                    </span>
                  </div>
                </td>
              </tr>
            )}

            {sorted.length === 0 && !cash && !loading && (
              <tr><td colSpan={9} className="text-center py-12 text-sm text-muted-foreground">{t('legacy.holdingsTable.noHoldings')}</td></tr>
            )}
          </tbody>

          {(sorted.length > 0 || cash) && (
            <tfoot>
              <tr className="bg-background/40 border-t-2 border-border/60">
                <td className="px-4 py-4 font-display font-bold text-sm text-foreground uppercase tracking-wider">{t('legacy.holdingsTable.total')}</td>
                <td colSpan={4}></td>
                <td className="px-4 py-4 text-right text-sm font-bold tabular-nums text-foreground">{money(totalInvested)}</td>
                <td className="px-4 py-4 text-right text-sm font-bold tabular-nums text-foreground">{money(totalValue)}</td>
                <td className="px-4 py-4 text-right">
                  <div className={`font-display font-bold text-sm tabular-nums ${totalProfit >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {money(totalProfit)}
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
