import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Newspaper, ChevronDown } from 'lucide-react';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { useStockNews } from '@/hooks/useExtras';
import { formatPct, formatUsd } from '@/data/portfolio';

const relTime = (ts: number | null): string => {
  if (!ts) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 3600) return `před ${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `před ${Math.floor(s / 3600)} h`;
  return `před ${Math.floor(s / 86400)} dny`;
};

const StockDetail = () => {
  const { ticker = '' } = useParams();
  const sym = ticker.toUpperCase();
  const { format, currency } = useCurrency();
  const { positions } = useComputedPortfolio();
  const p = positions.find((x) => x.ticker === sym);
  const { data: news } = useStockNews(sym);
  const [openNews, setOpenNews] = useState<number | null>(null);

  const yahooUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
  const tvUrl = `https://www.tradingview.com/symbols/${encodeURIComponent(sym)}/`;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /> Zpět na portfolio
          </Link>
          <div className="flex gap-2">
            <a
              href={yahooUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-accent transition-colors"
            >
              Yahoo Finance <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href={tvUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-accent transition-colors"
            >
              TradingView <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        <div className="gradient-card rounded-2xl border border-border p-6">
          <div className="flex items-end justify-between flex-wrap gap-4">
            <div>
              <h1 className="font-display text-4xl font-bold tracking-tight">{sym}</h1>
              {p && <p className="text-sm text-muted-foreground mt-1">{p.name}</p>}
            </div>
            {p && (
              <div className="text-right">
                <div className="font-display text-3xl font-bold">{formatUsd(p.currentPrice)}</div>
                <div className={`text-sm font-medium ${p.dailyChangePct >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {formatPct(p.dailyChangePct)} dnes
                </div>
              </div>
            )}
          </div>

          {p && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
              {[
                { l: 'Akcie', v: p.shares.toLocaleString('en-US', { maximumFractionDigits: 4 }) },
                { l: 'Nákupka', v: formatUsd(p.avgPrice) },
                { l: 'Hodnota', v: format(p.value) },
                { l: 'Zisk', v: `${format(p.profitUsd)} (${formatPct(currency === 'CZK' ? p.profitPctCzk : p.profitPct)})`, accent: p.profitUsd >= 0 ? 'profit' : 'loss' },
              ].map((s) => (
                <div key={s.l} className="rounded-lg border border-border bg-card/40 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
                  <div className={`font-display text-sm font-bold mt-1 ${
                    s.accent === 'profit' ? 'text-profit' : s.accent === 'loss' ? 'text-loss' : 'text-foreground'
                  }`}>{s.v}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* News — Yahoo headlines translated to Czech */}
        {news && news.items.length > 0 && (
          <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <Newspaper className="w-4 h-4 text-primary" />
              <h2 className="font-display text-base font-bold">Novinky</h2>
              <span className="text-[11px] text-muted-foreground">· aktualizováno {relTime(Math.floor(new Date(news.fetchedAt).getTime() / 1000))}</span>
            </div>
            <div className="space-y-3">
              {news.items.map((n, i) => {
                const open = openNews === i;
                return (
                  <div key={i} className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setOpenNews(open ? null : i)}
                      className="w-full text-left p-3 flex items-start gap-2 hover:bg-accent/30 transition-colors"
                      aria-expanded={open}
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium leading-snug ${open ? 'text-primary' : ''}`}>{n.cs}</p>
                        <p className="text-[11px] text-muted-foreground mt-1.5">{n.publisher}{n.ts ? ` · ${relTime(n.ts)}` : ''}</p>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </button>
                    {open && (
                      <div className="px-3 pb-3 -mt-1">
                        <p className="text-[13px] text-muted-foreground leading-relaxed">
                          {n.sumCs || n.sumEn || 'Výtah není k dispozici.'}
                        </p>
                        {n.url && (
                          <a
                            href={n.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-accent transition-colors"
                          >
                            Otevřít článek <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground mt-3">Zdroj: Yahoo Finance · automaticky přeloženo</p>
          </div>
        )}

        {/* TradingView chart embed */}
        <div className="rounded-2xl border border-border overflow-hidden bg-card" style={{ height: 600 }}>
          <iframe
            title={`${sym} chart`}
            src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(sym)}&interval=D&theme=dark&style=1&hidetoptoolbar=0&withdateranges=1`}
            className="w-full h-full"
            frameBorder="0"
            allowTransparency
            scrolling="no"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Data jsou poskytována externími zdroji (TradingView, Yahoo Finance) a slouží pouze pro informativní účely.
        </p>
      </div>
    </div>
  );
};

export default StockDetail;
