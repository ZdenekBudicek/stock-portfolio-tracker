import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const portfolio = useComputedPortfolio();
  const { data: txs = [] } = useTransactions();
  const { data: divs = [] } = useDividends();

  const exportPositions = () => {
    const rate = portfolio.usdCzk || 21;
    downloadCsv('pozice',
      [t('legacy.exportMenu.ticker'), t('legacy.exportMenu.name'), t('legacy.exportMenu.shareQuantity'), t('legacy.exportMenu.avgPriceUsd'), t('legacy.exportMenu.currentPriceUsd'), t('legacy.exportMenu.valueUSD'), t('legacy.exportMenu.valueCZK'), t('legacy.exportMenu.profitUSD'), t('legacy.exportMenu.profit'), t('legacy.exportMenu.allocation')],
      portfolio.positions.map((p) => [
        p.ticker, p.name ?? '', p.shares.toFixed(4), p.avgPrice.toFixed(2), p.currentPrice.toFixed(2),
        p.value.toFixed(2), (p.value * rate).toFixed(0), p.profitUsd.toFixed(2), p.profitPct.toFixed(2), p.allocation.toFixed(1),
      ]));
  };

  const exportTransactions = () => {
    downloadCsv('transakce',
      [t('legacy.exportMenu.date'), t('legacy.exportMenu.ticker'), t('legacy.exportMenu.side'), t('legacy.exportMenu.shareQuantity'), t('legacy.exportMenu.priceUSD'), t('legacy.exportMenu.feeUSD'), t('legacy.exportMenu.broker')],
      (txs as any[])
        .filter((row) => { const e = String(row.ext_id ?? ''); return !e.includes(':adj:') && !e.includes(':pos:'); })
        .map((row) => [row.executed_at.slice(0, 10), row.ticker, row.side, row.shares, row.price_usd, row.fee_usd ?? 0, row.broker ?? '']));
  };

  const exportDividends = () => {
    downloadCsv('dividendy',
      [t('legacy.exportMenu.exDate'), t('legacy.exportMenu.payDate'), t('legacy.exportMenu.ticker'), t('legacy.exportMenu.uSDShare'), t('legacy.exportMenu.shares'), t('legacy.exportMenu.totalUSD'), t('legacy.exportMenu.status'), t('legacy.exportMenu.source')],
      (divs as any[]).map((d) => [
        d.ex_date, d.pay_date ?? '', d.ticker, d.amount_per_share, d.shares_held ?? '', d.total_amount_usd ?? '', d.status, d.broker ?? '',
      ]));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <Download className="w-3.5 h-3.5" /> {t('legacy.exportMenu.export')}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={exportPositions}>{t('legacy.exportMenu.holdingsCsv')}</DropdownMenuItem>
        <DropdownMenuItem onClick={exportTransactions}>{t('legacy.exportMenu.transactionsCsv')}</DropdownMenuItem>
        <DropdownMenuItem onClick={exportDividends}>{t('legacy.exportMenu.dividendsCsv')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.print()}>
          <Printer className="w-3.5 h-3.5 mr-1.5" /> {t('legacy.exportMenu.printPdf')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ExportMenu;
