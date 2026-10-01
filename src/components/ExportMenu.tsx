import { Download, Printer } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useComputedPortfolio, useTransactions } from '@/hooks/usePortfolio';
import { useDividends } from '@/hooks/useExtras';

// Excel needs the UTF-8 BOM to open Czech characters correctly.
const downloadCsv = (name: string, header: string[], rows: (string | number)[][]) => {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(';')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

const ExportMenu = () => {
  const portfolio = useComputedPortfolio();
  const { data: txs = [] } = useTransactions();
  const { data: divs = [] } = useDividends();

  const exportPositions = () => {
    const rate = portfolio.usdCzk || 21;
    downloadCsv('pozice',
      ['Ticker', 'Název', 'Kusy', 'Prům. cena USD', 'Aktuální cena USD', 'Hodnota USD', 'Hodnota CZK', 'Zisk USD', 'Zisk %', 'Alokace %'],
      portfolio.positions.map((p) => [
        p.ticker, p.name ?? '', p.shares.toFixed(4), p.avgPrice.toFixed(2), p.currentPrice.toFixed(2),
        p.value.toFixed(2), (p.value * rate).toFixed(0), p.profitUsd.toFixed(2), p.profitPct.toFixed(2), p.allocation.toFixed(1),
      ]));
  };

  const exportTransactions = () => {
    downloadCsv('transakce',
      ['Datum', 'Ticker', 'Směr', 'Kusy', 'Cena USD', 'Poplatek USD', 'Broker'],
      (txs as any[])
        .filter((t) => { const e = String(t.ext_id ?? ''); return !e.includes(':adj:') && !e.includes(':pos:'); })
        .map((t) => [t.executed_at.slice(0, 10), t.ticker, t.side, t.shares, t.price_usd, t.fee_usd ?? 0, t.broker ?? '']));
  };

  const exportDividends = () => {
    downloadCsv('dividendy',
      ['Ex-date', 'Pay-date', 'Ticker', 'USD/akcii', 'Kusů', 'Celkem USD', 'Stav', 'Zdroj'],
      (divs as any[]).map((d) => [
        d.ex_date, d.pay_date ?? '', d.ticker, d.amount_per_share, d.shares_held ?? '', d.total_amount_usd ?? '', d.status, d.broker ?? '',
      ]));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <Download className="w-3.5 h-3.5" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={exportPositions}>Pozice (CSV)</DropdownMenuItem>
        <DropdownMenuItem onClick={exportTransactions}>Transakce (CSV)</DropdownMenuItem>
        <DropdownMenuItem onClick={exportDividends}>Dividendy (CSV)</DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.print()}>
          <Printer className="w-3.5 h-3.5 mr-1.5" /> Tisk / PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ExportMenu;
