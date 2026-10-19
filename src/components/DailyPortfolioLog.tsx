import { useTranslation } from "react-i18next";
import { currentLang, currentLocale } from "@/i18n";
import { useState, useMemo } from 'react';
import { useDailySnapshots, useTransactions, computeTradeFlows } from '@/hooks/usePortfolio';
import { useCurrency } from '@/contexts/CurrencyContext';
import { computeDailyChanges } from '@/lib/dailyChanges';
import { formatPct } from '@/data/portfolio';
import { formatMoney, symbolOf, wrapSymbol } from '@/lib/displayCurrency';
import { Database, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

const ITEMS_PER_PAGE = 30;

const DailyPortfolioLog = () => {
  const { t } = useTranslation();
  const { data: snapshots = [] } = useDailySnapshots();
  const { data: txs = [] } = useTransactions();
  const { hidden, local } = useCurrency();
  const lang = currentLang() === 'en' ? 'en' : 'cs';
  // The snapshots' value_czk is in the local currency (koruny or the chosen one).
  const czk = (n: number) => (hidden ? wrapSymbol('••••', local, lang) : formatMoney(n, local, lang));
  const usd = (n: number) => (hidden ? '$••••' : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const tradeFlows = useMemo(() => computeTradeFlows(txs), [txs]);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');

  const years = useMemo(() => {
    const yrs = new Set<number>(snapshots.map(s => parseInt(s.snapshot_date.split('-')[0])));
    return Array.from(yrs).sort((a, b) => b - a);
  }, [snapshots]);

  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const activeYear = selectedYear ?? years[0] ?? new Date().getFullYear();

  // Per-day change computed from consecutive snapshot values. The stored profit_* fields
  // are always 0 (both snapshot writers only store the holdings value), so showing them was
  // a column of zeros — the day-over-day delta is what a daily log should show anyway.
  // Net of that day's trades: a purchase is not a gain and a sale is not a loss.
  const filtered = useMemo(() => {
    const rows = computeDailyChanges(snapshots, tradeFlows);
    let data = rows.filter(s => s.snapshot_date.startsWith(`${activeYear}-`));
    if (search) data = data.filter(s => s.snapshot_date.includes(search));
    return data.reverse();
  }, [snapshots, tradeFlows, activeYear, search]);

  const displayed = showAll ? filtered : filtered.slice(0, ITEMS_PER_PAGE);

  const formatDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(currentLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).replace(/\s/g, '');

  return (
    <div className="gradient-card rounded-lg border border-border p-5 animate-fade-in space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h2 className="font-display font-bold text-lg text-foreground">{t('legacy.dailyPortfolioLog.dailyPortfolioRecords')}</h2>
          <span className="text-xs text-muted-foreground">{t('legacy.dailyPortfolioLog.recordCount', { count: filtered.length })}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder={t('legacy.dailyPortfolioLog.searchDate')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs w-36"
            />
          </div>
          <div className="flex rounded-md border border-border overflow-hidden">
            {years.map(y => (
              <button
                key={y}
                onClick={() => { setSelectedYear(y); setShowAll(false); }}
                className={`px-3 py-1.5 text-xs font-display font-medium transition-colors ${
                  activeYear === y
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-accent/30 text-muted-foreground hover:bg-accent/60'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('legacy.dailyPortfolioLog.date')}</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('legacy.dailyPortfolioLog.portfolioValue')}</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('legacy.dailyPortfolioLog.dailyChangeUsd')}</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('legacy.dailyPortfolioLog.dailyChange')}</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('legacy.dailyPortfolioLog.dailyChangeCzk', { currency: symbolOf(local, lang) })}</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((snap) => (
              <tr key={snap.snapshot_date} className="border-b border-border/30 hover:bg-accent/20 transition-colors">
                <td className="py-1.5 px-3 font-medium text-foreground">{formatDate(snap.snapshot_date)}</td>
                <td className="py-1.5 px-3 text-right font-display font-medium text-foreground">{czk(snap.value_czk)}</td>
                <td className={`py-1.5 px-3 text-right font-display font-medium ${snap.dayUsd >= 0 ? 'text-profit' : 'text-loss'}`}>{usd(snap.dayUsd)}</td>
                <td className={`py-1.5 px-3 text-right font-display font-bold ${snap.dayPct >= 0 ? 'text-profit' : 'text-loss'}`}>{formatPct(snap.dayPct)}</td>
                <td className={`py-1.5 px-3 text-right font-display font-medium ${snap.dayCzk >= 0 ? 'text-profit' : 'text-loss'}`}>{czk(snap.dayCzk)}</td>

              </tr>
            ))}
            {displayed.length === 0 && (
              <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">{t('legacy.dailyPortfolioLog.noRecords')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > ITEMS_PER_PAGE && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showAll ? (<>{t('legacy.dailyPortfolioLog.showLess')}{" "}<ChevronUp className="w-3.5 h-3.5" /></>)
                   : (<>{t('legacy.dailyPortfolioLog.showAllRecords', { count: filtered.length })}{" "}<ChevronDown className="w-3.5 h-3.5" /></>)}
        </button>
      )}
    </div>
  );
};

export default DailyPortfolioLog;
