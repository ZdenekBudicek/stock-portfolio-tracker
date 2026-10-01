import { useState, useMemo } from 'react';
import { useDailySnapshots } from '@/hooks/usePortfolio';
import { formatCzk, formatUsd, formatPct } from '@/data/portfolio';
import { Database, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

const ITEMS_PER_PAGE = 30;

const DailyPortfolioLog = () => {
  const { data: snapshots = [] } = useDailySnapshots();
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
  const filtered = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const rows = sorted.map((s, i) => {
      const prev = i > 0 ? sorted[i - 1] : null;
      const dayUsd = prev ? s.value_usd - prev.value_usd : 0;
      const dayCzk = prev ? s.value_czk - prev.value_czk : 0;
      const dayPct = prev && prev.value_usd > 0 ? (dayUsd / prev.value_usd) * 100 : 0;
      return { ...s, dayUsd, dayCzk, dayPct };
    });
    let data = rows.filter(s => s.snapshot_date.startsWith(`${activeYear}-`));
    if (search) data = data.filter(s => s.snapshot_date.includes(search));
    return data.reverse();
  }, [snapshots, activeYear, search]);

  const displayed = showAll ? filtered : filtered.slice(0, ITEMS_PER_PAGE);

  const formatDate = (d: string) => {
    const [y, m, day] = d.split('-');
    return `${day}.${m}.${y}`;
  };

  return (
    <div className="gradient-card rounded-lg border border-border p-5 animate-fade-in space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h2 className="font-display font-bold text-lg text-foreground">Denní záznamy portfolia</h2>
          <span className="text-xs text-muted-foreground">({filtered.length} záznamů)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Hledat datum..."
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
              <th className="text-left py-2 px-3 text-muted-foreground font-medium">Datum</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">Hodnota portfolia</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">Změna dne (USD)</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">Změna dne %</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium">Změna dne (Kč)</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((snap) => (
              <tr key={snap.snapshot_date} className="border-b border-border/30 hover:bg-accent/20 transition-colors">
                <td className="py-1.5 px-3 font-medium text-foreground">{formatDate(snap.snapshot_date)}</td>
                <td className="py-1.5 px-3 text-right font-display font-medium text-foreground">{formatCzk(snap.value_czk)}</td>
                <td className={`py-1.5 px-3 text-right font-display font-medium ${snap.dayUsd >= 0 ? 'text-profit' : 'text-loss'}`}>{formatUsd(snap.dayUsd)}</td>
                <td className={`py-1.5 px-3 text-right font-display font-bold ${snap.dayPct >= 0 ? 'text-profit' : 'text-loss'}`}>{formatPct(snap.dayPct)}</td>
                <td className={`py-1.5 px-3 text-right font-display font-medium ${snap.dayCzk >= 0 ? 'text-profit' : 'text-loss'}`}>{formatCzk(snap.dayCzk)}</td>
              </tr>
            ))}
            {displayed.length === 0 && (
              <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">Žádné záznamy</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > ITEMS_PER_PAGE && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showAll ? (<>Zobrazit méně <ChevronUp className="w-3.5 h-3.5" /></>)
                   : (<>Zobrazit všech {filtered.length} záznamů <ChevronDown className="w-3.5 h-3.5" /></>)}
        </button>
      )}
    </div>
  );
};

export default DailyPortfolioLog;
