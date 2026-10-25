import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useState, useMemo } from 'react';
import { Plus, Search, Loader2, Pencil, Trash2, X, Check } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useTransactions } from '@/hooks/usePortfolio';
import { useDividends } from '@/hooks/useExtras';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { TickerLogo } from '@/components/TickerLogo';

const TransactionHistory = () => {
  const { t } = useTranslation();
  const { format } = useCurrency();
  const { data: txns = [], isLoading } = useTransactions();
  const { data: dividends = [] } = useDividends();
  const qc = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [filterAction, setFilterAction] = useState<'All' | 'BUY' | 'SELL' | 'DIVIDEND'>('All');
  const [page, setPage] = useState(0);
  const perPage = 20;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    date: '', ticker: '', side: 'BUY' as 'BUY' | 'SELL', shares: '', price: '', note: '',
  });

  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    ticker: '', side: 'BUY' as 'BUY' | 'SELL', shares: '', price: '', note: '',
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['positions'] });
    qc.invalidateQueries({ queryKey: ['live-prices'] });
  };

  const addTx = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('transactions').insert({
        ticker: form.ticker.toUpperCase(),
        side: form.side,
        shares: parseFloat(form.shares),
        price_usd: parseFloat(form.price),
        executed_at: new Date(form.date + 'T12:00:00Z').toISOString(),
        note: form.note || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t('legacy.transactionHistory.transactionAdded'));
      invalidateAll();
      setShowForm(false);
      setForm({ date: new Date().toISOString().slice(0, 10), ticker: '', side: 'BUY', shares: '', price: '', note: '' });
    },
    onError: (e) => toast.error(t('legacy.transactionHistory.errorDetail', { message: e.message })),
  });

  const updateTx = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('transactions').update({
        ticker: editForm.ticker.toUpperCase(),
        side: editForm.side,
        shares: parseFloat(editForm.shares),
        price_usd: parseFloat(editForm.price),
        executed_at: new Date(editForm.date + 'T12:00:00Z').toISOString(),
        note: editForm.note || null,
      }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t('legacy.transactionHistory.transactionUpdatedHoldingsRecalculated'));
      invalidateAll();
      setEditingId(null);
    },
    onError: (e) => toast.error(t('legacy.transactionHistory.errorDetail', { message: e.message })),
  });

  const deleteTx = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('transactions').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t('legacy.transactionHistory.transactionDeletedHoldingsRecalculated'));
      invalidateAll();
    },
    onError: (e) => toast.error(t('legacy.transactionHistory.errorDetail', { message: e.message })),
  });

  const startEdit = (row: { executed_at: string; ticker: string; side: string; shares: number; price_usd: number; note?: string; id: string }) => {
    setEditingId(row.id);
    setEditForm({
      date: new Date(row.executed_at).toISOString().slice(0, 10),
      ticker: row.ticker,
      side: row.side as "BUY" | "SELL",
      shares: String(row.shares),
      price: String(row.price_usd),
      note: row.note ?? '',
    });
  };

  const filtered = useMemo(() => {
    // real trades (hide reconciliation/cash plumbing) + dividends shown as "Dividenda"
    const trades = txns
      .filter(row => {
        const ext = String(row.ext_id ?? '');
        if (ext.includes(':adj:') || ext.includes(':pos:')) return false;
        if (row.ticker === 'CASH') return false;
        return true;
      })
      .map(row => ({ id: row.id, executed_at: row.executed_at, ticker: row.ticker, side: row.side as string, shares: Number(row.shares), price_usd: Number(row.price_usd), total: Number(row.shares) * Number(row.price_usd), note: row.note ?? null, _div: false }));
    // Only PAID dividends belong in the transaction history (future/projected ones stay
    // in the Dividends section, not here).
    const divs = dividends.filter(d => d.status === 'paid').map(d => ({ id: 'div-' + d.id, executed_at: d.pay_date ?? d.ex_date, ticker: d.ticker, side: 'DIVIDEND', shares: Number(d.shares_held ?? 0), price_usd: Number(d.amount_per_share ?? 0), total: Number(d.total_amount_usd ?? 0), note: t('legacy.transactionHistory.dividend'), _div: true }));
    return [...trades, ...divs]
      .filter(row => {
        if (search && !row.ticker.toLowerCase().includes(search.toLowerCase())) return false;
        if (filterAction !== 'All' && row.side !== filterAction) return false;
        return true;
      })
      .sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime());
  }, [txns, dividends, search, filterAction]);

  const paged = filtered.slice(page * perPage, (page + 1) * perPage);
  const totalPages = Math.ceil(filtered.length / perPage);

  const formatDate = (d: string) => new Date(d).toLocaleDateString(currentLocale());

  return (
    <div className="gradient-card rounded-lg border border-border animate-fade-in overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display font-bold text-lg text-foreground">{t('legacy.transactionHistory.transactions')}</h2>
          {isLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input type="text" placeholder={t('legacy.transactionHistory.searchTicker')} value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} className="pl-8 pr-3 py-1.5 text-xs rounded-md bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-32" />
          </div>
          <select value={filterAction} onChange={e => { setFilterAction(e.target.value as typeof filterAction); setPage(0); }} className="px-2 py-1.5 text-xs rounded-md bg-input border border-border text-foreground focus:outline-none">
            <option value="All">{t('legacy.transactionHistory.all')}</option>
            <option value="BUY">{t('legacy.transactionHistory.buy')}</option>
            <option value="SELL">{t('legacy.transactionHistory.sell')}</option>
            <option value="DIVIDEND">{t('legacy.transactionHistory.dividend')}</option>
          </select>
          <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
            <Plus className="w-3.5 h-3.5" />
            {t('legacy.transactionHistory.add')}</button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={e => { e.preventDefault(); addTx.mutate(); }} className="px-5 py-4 border-b border-border bg-accent/30">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <input type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="px-2 py-1.5 text-xs rounded-md bg-input border border-border text-foreground" />
            <input type="text" required placeholder={t('legacy.transactionHistory.ticker')} value={form.ticker} onChange={e => setForm({ ...form, ticker: e.target.value })} className="px-2 py-1.5 text-xs rounded-md bg-input border border-border text-foreground placeholder:text-muted-foreground" />
            <select value={form.side} onChange={e => setForm({ ...form, side: e.target.value as "BUY" | "SELL" })} className="px-2 py-1.5 text-xs rounded-md bg-input border border-border text-foreground">
              <option value="BUY">{t('legacy.transactionHistory.buy')}</option>
              <option value="SELL">{t('legacy.transactionHistory.sell')}</option>
            </select>
            <input type="number" step="any" required placeholder={t('legacy.transactionHistory.quantity')} value={form.shares} onChange={e => setForm({ ...form, shares: e.target.value })} className="px-2 py-1.5 text-xs rounded-md bg-input border border-border text-foreground placeholder:text-muted-foreground" />
            <input type="number" step="any" required placeholder={t('legacy.transactionHistory.price')} value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} className="px-2 py-1.5 text-xs rounded-md bg-input border border-border text-foreground placeholder:text-muted-foreground" />
            <button type="submit" disabled={addTx.isPending} className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
              {addTx.isPending ? t('legacy.transactionHistory.saving') : t('legacy.transactionHistory.save')}
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left">{t('legacy.transactionHistory.date')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left">{t('legacy.transactionHistory.ticker')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left">{t('legacy.transactionHistory.action')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">{t('legacy.transactionHistory.quantity')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">{t('legacy.transactionHistory.price2')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">{t('legacy.transactionHistory.total')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left">{t('legacy.transactionHistory.note')}</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right w-24">{t('legacy.transactionHistory.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((row) => editingId === row.id ? (
              <tr key={row.id} className="border-b border-border/50 bg-accent/20">
                <td className="px-2 py-2"><input type="date" value={editForm.date} onChange={e => setEditForm({ ...editForm, date: e.target.value })} className="w-full px-1.5 py-1 text-xs rounded bg-input border border-border" /></td>
                <td className="px-2 py-2"><input type="text" value={editForm.ticker} onChange={e => setEditForm({ ...editForm, ticker: e.target.value.toUpperCase() })} className="w-20 px-1.5 py-1 text-xs rounded bg-input border border-border font-mono uppercase" /></td>
                <td className="px-2 py-2">
                  <select value={editForm.side} onChange={e => setEditForm({ ...editForm, side: e.target.value as "BUY" | "SELL" })} className="px-1.5 py-1 text-xs rounded bg-input border border-border">
                    <option value="BUY">{t('legacy.transactionHistory.buy')}</option>
                    <option value="SELL">{t('legacy.transactionHistory.sell')}</option>
                  </select>
                </td>
                <td className="px-2 py-2 text-right"><input type="number" step="any" value={editForm.shares} onChange={e => setEditForm({ ...editForm, shares: e.target.value })} className="w-24 px-1.5 py-1 text-xs rounded bg-input border border-border text-right" /></td>
                <td className="px-2 py-2 text-right"><input type="number" step="any" value={editForm.price} onChange={e => setEditForm({ ...editForm, price: e.target.value })} className="w-24 px-1.5 py-1 text-xs rounded bg-input border border-border text-right" /></td>
                <td className="px-2 py-2 text-right text-xs text-muted-foreground tabular-nums">
                  {format((parseFloat(editForm.shares) || 0) * (parseFloat(editForm.price) || 0))}
                </td>
                <td className="px-2 py-2"><input type="text" value={editForm.note} onChange={e => setEditForm({ ...editForm, note: e.target.value })} placeholder="—" className="w-full px-1.5 py-1 text-xs rounded bg-input border border-border" /></td>
                <td className="px-2 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => updateTx.mutate(row.id)} disabled={updateTx.isPending} className="p-1 rounded hover:bg-profit/15 text-profit disabled:opacity-50" title={t('legacy.transactionHistory.save')}><Check className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setEditingId(null)} className="p-1 rounded hover:bg-accent text-muted-foreground" title={t('legacy.transactionHistory.cancel')}><X className="w-3.5 h-3.5" /></button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={row.id} className="border-b border-border/50 hover:bg-card-hover transition-colors">
                <td className="px-3 py-2.5 text-xs text-secondary-foreground">{formatDate(row.executed_at)}</td>
                <td className="px-3 py-2.5 text-xs font-display font-bold text-foreground"><span className="inline-flex items-center gap-2">{row.ticker !== 'CASH' && <TickerLogo ticker={row.ticker} size="xs" />}{row.ticker}</span></td>
                <td className="px-3 py-2.5">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${row.side === 'BUY' ? 'bg-profit/15 text-profit' : row.side === 'SELL' ? 'bg-loss/15 text-loss' : 'bg-info/15 text-info'}`}>
                    {row.side === 'BUY' ? t('legacy.transactionHistory.buy') : row.side === 'SELL' ? t('legacy.transactionHistory.sell') : t('legacy.transactionHistory.dividend')}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-right text-secondary-foreground">{row.shares.toLocaleString(currentLocale(), { maximumFractionDigits: 4 })}</td>
                <td className="px-3 py-2.5 text-xs text-right text-secondary-foreground">{format(row.price_usd)}</td>
                <td className="px-3 py-2.5 text-xs text-right font-medium text-foreground">{format(row.total)}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.note || '—'}</td>
                <td className="px-3 py-2.5">
                  {!row._div && (
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => startEdit(row)} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground" title={t('legacy.transactionHistory.edit')}><Pencil className="w-3.5 h-3.5" /></button>
                    <button
                      onClick={() => {
                        if (confirm(t('legacy.transactionHistory.deleteTransactionHoldingsWillBeRecalculated', { v0: row.side, v1: row.shares, v2: row.ticker }))) {
                          deleteTx.mutate(row.id);
                        }
                      }}
                      className="p-1 rounded hover:bg-loss/15 text-muted-foreground hover:text-loss"
                      title={t('legacy.transactionHistory.delete')}
                    ><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                  )}
                </td>
              </tr>
            ))}
            {paged.length === 0 && !isLoading && (
              <tr><td colSpan={8} className="text-center py-6 text-muted-foreground text-sm">{t('legacy.transactionHistory.noTransactions')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{t('legacy.transactionHistory.transactionCount', { count: filtered.length })}</span>
          <div className="flex gap-1">
            <button aria-label={t('legacy.transactionHistory.previousPage')} disabled={page === 0} onClick={() => setPage(p => p - 1)} className="px-3 py-1 text-xs rounded-md bg-secondary text-secondary-foreground disabled:opacity-30 hover:bg-accent transition-colors">←</button>
            <span className="px-3 py-1 text-xs text-muted-foreground">{page + 1}/{totalPages}</span>
            <button aria-label={t('legacy.transactionHistory.nextPage')} disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} className="px-3 py-1 text-xs rounded-md bg-secondary text-secondary-foreground disabled:opacity-30 hover:bg-accent transition-colors">→</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TransactionHistory;
