import { useTranslation } from "react-i18next";
import { currentLang, currentLocale } from "@/i18n";
import { formatMoney, wrapSymbol } from "@/lib/displayCurrency";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio } from '@/hooks/usePortfolio';
import { formatPct } from '@/data/portfolio';

const PortfolioPerformanceChart = () => {
  const { t } = useTranslation();
  const { formatAt, pick, currency, hidden } = useCurrency();
  const { positions } = useComputedPortfolio();
  // Amounts in the displayed currency. In the local one (koruny or the chosen one) the cost is
  // at the purchase-day rate, the same "Investováno" the Pozice table shows, and the profit and
  // % include the currency move.
  const lang = currentLang() === 'en' ? 'en' : 'cs';
  const money = (v: number, digits = 0) => hidden
    ? wrapSymbol('••••', currency, lang)
    : currency === 'USD' ? `$${v.toLocaleString(currentLocale(), { maximumFractionDigits: digits })}` : formatMoney(v, currency, lang, { decimals: digits });

  const data = positions
    .filter((p) => p.type !== 'Cash' && p.ticker !== 'CASH')
    .sort((a, b) => b.value - a.value)
    .map((p) => {
      const invested = pick(p.invested, p.investedCzk);
      const profit = pick(p.profitUsd, p.profitCzk);
      return {
        ticker: p.ticker,
        name: p.name,
        invested,
        profitPos: profit >= 0 ? profit : 0,
        profitNeg: profit < 0 ? profit : 0,
        profit,
        value: pick(p.value, p.valueCzk),
        profitPct: pick(p.profitPct, p.profitPctCzk),
      };
    });

  const totalInvested = data.reduce((s, d) => s + d.invested, 0);
  const totalProfit = data.reduce((s, d) => s + d.profit, 0);
  const yMin = Math.min(0, ...data.map((d) => d.profitNeg));
  const yMax = Math.max(0, ...data.map((d) => d.invested + d.profitPos));
  const yPadding = Math.max((yMax - yMin) * 0.08, 1);

  const tickFormatter = (v: number) => {
    if (hidden) return '••';
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1000) return currency !== 'USD' ? `${sign}${(abs / 1000).toLocaleString(currentLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}k` : `${sign}$${(abs / 1000).toLocaleString(currentLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}k`;
    return currency !== 'USD' ? `${sign}${abs.toLocaleString(currentLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : `${sign}$${abs.toLocaleString(currentLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
  const { t } = useTranslation();
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-card/95 backdrop-blur px-3 py-2 shadow-xl">
        <p className="font-display font-bold text-sm text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground mb-1">{d.name}</p>
        <div className="space-y-0.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-sm" style={{ background: 'hsl(var(--info))' }} />
            <span className="text-muted-foreground">{t('legacy.portfolioPerformanceChart.invested')}</span>
            <span className="font-mono tabular-nums font-medium ml-auto">
              {money(d.invested)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-sm" style={{ background: d.profit >= 0 ? 'hsl(var(--profit))' : 'hsl(var(--loss))' }} />
            <span className="text-muted-foreground">{t('legacy.portfolioPerformanceChart.profit')}</span>
            <div className={`font-mono tabular-nums font-medium ml-auto text-right ${d.profit >= 0 ? 'text-profit' : 'text-loss'}`}>
              <div>{formatPct(d.profitPct)}</div>
              <div className="text-[11px] opacity-90">{formatAt(d.profit, d.profit)}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-border/50 mt-1">
            <span className="text-muted-foreground">{t('legacy.portfolioPerformanceChart.value')}</span>
            <span className="font-mono tabular-nums font-bold ml-auto text-foreground">
              {money(d.value)}
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="gradient-card rounded-2xl border border-border p-5 sm:p-6 animate-fade-in-up min-w-0 overflow-hidden hover-lift">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
        <div>
          <h2 className="font-display font-bold text-lg sm:text-xl text-foreground">{t('legacy.portfolioPerformanceChart.portfolioPerformance')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('legacy.portfolioPerformanceChart.investedAmountVsUnrealizedGainByStock')}</p>
        </div>
        <div className="flex items-center gap-3 sm:gap-4 text-xs flex-wrap">
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-info/10 border border-info/20">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'linear-gradient(180deg, hsl(var(--info)), hsl(var(--info) / 0.7))' }} />
            <span className="text-muted-foreground">{t('legacy.portfolioPerformanceChart.invested2')}</span>
            <span className="font-mono tabular-nums font-bold text-foreground">
              {money(totalInvested)}
            </span>
          </div>
          <div className={`flex items-center gap-2 px-2.5 py-1 rounded-lg border ${
            totalProfit >= 0 ? 'bg-profit/10 border-profit/20' : 'bg-loss/10 border-loss/20'
          }`}>
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: totalProfit >= 0 ? 'linear-gradient(180deg, hsl(var(--profit)), hsl(var(--profit) / 0.7))' : 'linear-gradient(180deg, hsl(var(--loss)), hsl(var(--loss) / 0.7))' }} />
            <span className="text-muted-foreground">{t('legacy.portfolioPerformanceChart.profit2')}</span>
            <span className={`font-mono tabular-nums font-bold ${totalProfit >= 0 ? 'text-profit' : 'text-loss'}`}>
              {totalProfit >= 0 ? '+' : ''}{money(totalProfit)}

            </span>
          </div>
        </div>
      </div>

      <div className="h-[360px] min-w-0">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 16, right: 12, left: 0, bottom: 0 }} barCategoryGap="28%" barSize={36} stackOffset="sign">
            <defs>
              <linearGradient id="investedGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity={1} />
                <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity={0.65} />
              </linearGradient>
              <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--profit))" stopOpacity={1} />
                <stop offset="100%" stopColor="hsl(var(--profit))" stopOpacity={0.7} />
              </linearGradient>
              <linearGradient id="lossGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--loss))" stopOpacity={1} />
                <stop offset="100%" stopColor="hsl(var(--loss))" stopOpacity={0.7} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="ticker"
              tick={{ fontSize: 12, fill: 'hsl(var(--foreground))', fontFamily: 'JetBrains Mono', fontWeight: 600 }}
              axisLine={{ stroke: 'hsl(var(--border))' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={tickFormatter}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
              width={60}
              domain={[yMin - yPadding, yMax + yPadding]}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--accent) / 0.3)' }} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
            <Bar dataKey="invested" stackId="portfolio" fill="url(#investedGrad)" radius={[0, 0, 6, 6]} />
            <Bar dataKey="profitPos" stackId="portfolio" fill="url(#profitGrad)" radius={[6, 6, 0, 0]} />
            <Bar dataKey="profitNeg" stackId="portfolio" fill="url(#lossGrad)" radius={[0, 0, 6, 6]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default PortfolioPerformanceChart;
