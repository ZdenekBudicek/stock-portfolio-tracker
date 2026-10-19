// Přehled — docs/design/V2-Prehled.dc.html
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TrendingUp, LogOut } from 'lucide-react';
import { usePositions, useTransactions, useComputedPortfolio, useLivePrices } from '@/hooks/usePortfolio';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useAlerts, useDividendModel, useTaxModel } from '@/hooks/useInsights';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import QuickTradeDialog from '@/components/QuickTradeDialog';
import BrokerConnect from '@/components/BrokerConnect';
import StatementImport from '@/components/StatementImport';
import PerformanceChart from '@/components/PerformanceChart';
import { TickerLogo } from '@/components/TickerLogo';
import { AllocationCard, AttentionCard, MoversCard, UpcomingCard, fmtDate, holdingsOf, monthShort } from '@/components/v2/widgets';
import { Panel, Pill, Label, Footnote } from '@/components/v2/ui';
import { formatPct } from '@/data/portfolio';
import { cn } from '@/lib/utils';
import { currentLang, currentLocale } from '@/i18n';
import { fmtCzk, fmtNum, fmtPercent } from '@/i18n/format';
import { formatMoney, wrapSymbol } from '@/lib/displayCurrency';
import { useTaxResidence } from '@/hooks/useTaxResidence';
import { RealizedMini } from '@/components/RealizedGains';

const PageSkeleton = () => (
  <div className="space-y-4">
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Skeleton className="h-[420px] rounded-3xl lg:col-span-2" />
      <Skeleton className="h-[420px] rounded-3xl" />
    </div>
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-56 rounded-3xl" />)}
    </div>
  </div>
);

function Onboarding() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  return (
    <div className="max-w-3xl mx-auto py-6 space-y-6">
      <Panel className="text-center space-y-5">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 text-primary mx-auto">
          <TrendingUp className="w-7 h-7" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('overview.welcome.title')}</h1>
          <p className="text-sm text-muted-foreground mt-2">
            {t('overview.welcome.text')}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <QuickTradeDialog />
          <Button variant="ghost" size="sm" onClick={signOut} className="text-muted-foreground">
            <LogOut className="w-3 h-3 mr-1.5" /> {t('shell.signOut')} {user?.email}
          </Button>
        </div>
      </Panel>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BrokerConnect />
        <StatementImport />
      </div>
    </div>
  );
}

function Hero() {
  const { t } = useTranslation();
  const p = useComputedPortfolio();
  const { format, currency, local, hidden } = useCurrency();
  const lang = currentLang() === 'en' ? 'en' : 'cs';
  const prev = p.totalValue - p.dailyReturn;
  const dayPct = prev > 0 ? (p.dailyReturn / prev) * 100 : 0;
  const up = p.dailyReturn >= 0;
  // The other currency beside the big number: the local one (koruny or the chosen one) in USD mode.
  const other = currency === 'USD' ? p.totalValue * p.usdLocal : p.totalValue;
  return (
    <Panel className="lg:col-span-2 !pb-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Label>{t('overview.hero.value')}</Label>
          <div className="mt-1.5 text-5xl sm:text-[64px] font-semibold tracking-[-0.045em] leading-none tabular-nums">{format(p.totalValue)}</div>
          <div className="mt-3 flex items-center gap-2.5 flex-wrap">
            <Pill tone={up ? 'profit' : 'loss'} className="num">{up ? '▲' : '▼'} {up ? '+' : ''}{format(p.dailyReturn)} · {formatPct(dayPct)}</Pill>
            <span className="text-xs text-muted-foreground">{t('common.today')}</span>
            <span className="text-xs text-muted-foreground num">· {hidden ? (currency === 'USD' ? wrapSymbol('••••', local, lang) : '$••••') : currency === 'USD'
              ? formatMoney(other, local, lang)
              : `$${Math.round(p.totalValue).toLocaleString(currentLocale())}`}</span>
          </div>
        </div>
        <div className="sm:hidden"><QuickTradeDialog /></div>
      </div>
      <div className="mt-2"><PerformanceChart embedded /></div>
    </Panel>
  );
}

function ProfitCard() {
  const { t } = useTranslation();
  const p = useComputedPortfolio();
  const { formatAt, format, pick, currency } = useCurrency();
  const total = pick(p.totalProfit, p.totalProfitCzk);
  const realized = currency === 'USD' ? p.realizedProfit : p.realizedProfit * p.usdLocal;
  const unrealized = pick(p.unrealizedProfit, p.unrealizedProfitCzk);
  const rest = total - realized - unrealized;
  const parts = [
    { v: realized, c: 'hsl(var(--profit))', label: t('overview.profit.realized'), text: format(p.realizedProfit) },
    { v: unrealized, c: 'hsl(var(--cyan))', label: t('overview.profit.unrealized'), text: formatAt(p.unrealizedProfit, p.unrealizedProfitCzk) },
  ];
  const denom = parts.reduce((s, x) => s + Math.abs(x.v), 0) + Math.abs(rest);
  const deposits = p.netDepositsUsd != null ? formatAt(p.netDepositsUsd, p.netDepositsCzk ?? p.netDepositsUsd * p.usdLocal) : null;
  const pos = total >= 0;
  return (
    <Panel to="/vynosy" glow={pos ? 'profit' : 'loss'}>
      <div className="flex items-center justify-between">
        <Label className={pos ? 'text-profit/80' : 'text-loss/80'}>{t('overview.profit.title')}</Label>
        <Pill tone={pos ? 'profit' : 'loss'}>{formatPct(pick(p.totalReturnPct, p.totalReturnPctCzk))}</Pill>
      </div>
      <div className={cn('mt-2.5 text-[38px] font-semibold tracking-[-0.04em] tabular-nums leading-tight', pos ? 'text-profit' : 'text-loss')}>
        {pos ? '+' : ''}{formatAt(p.totalProfit, p.totalProfitCzk)}
      </div>
      {denom > 0 && (
        <div className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full bg-white/[0.08]">
          {parts.map((x) => <div key={x.label} style={{ width: `${(Math.abs(x.v) / denom) * 100}%`, background: x.c, opacity: x.v < 0 ? 0.45 : 1 }} />)}
          {Math.abs(rest) / denom > 0.005 && <div style={{ width: `${(Math.abs(rest) / denom) * 100}%`, background: 'hsl(var(--muted-foreground) / 0.5)' }} />}
        </div>
      )}
      <div className="mt-2.5 space-y-1 text-xs text-muted-foreground">
        {parts.map((x) => (
          <div key={x.label} className="flex justify-between"><span><span style={{ color: x.c }}>●</span> {x.label}</span><span className="num">{x.text}</span></div>
        ))}
        {Math.abs(rest) / Math.max(1, denom) > 0.005 && (
          <div className="flex justify-between" title={t('overview.profit.restTip')}>
            <span><span className="text-muted-foreground">●</span> {t('overview.profit.rest')}</span><span className="num">{format(currency === 'USD' ? rest : rest / p.usdLocal)}</span>
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-white/[0.08] pt-3.5 text-xs">
        <span className="text-muted-foreground">{deposits ? t('overview.profit.deposited', { amount: deposits }) : t('overview.profit.noDeposits')}</span>
        <span className="font-medium text-primary">{t('returns.title')} →</span>
      </div>
    </Panel>
  );
}

function PositionsPreview() {
  const { t } = useTranslation();
  const { positions } = useComputedPortfolio();
  const { format } = useCurrency();
  const rows = holdingsOf(positions).sort((a, b) => b.value - a.value);
  return (
    <Panel title={t('nav.positions')} action={<Link to="/pozice" className="text-xs font-medium text-primary">{t('overview.positions.all', { count: rows.length })} →</Link>} className="lg:col-span-2">
      <div className="space-y-1">
        {rows.slice(0, 6).map((p) => (
          <Link key={p.ticker} to={`/stock/${p.ticker}`} className="group/link grid grid-cols-[40px_1fr_auto_auto] sm:grid-cols-[40px_1fr_120px_90px] items-center gap-3 rounded-2xl px-2 py-2 hover:bg-white/[0.045]">
            <TickerLogo ticker={p.ticker} size="md" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{p.name || p.ticker}</div>
              <div className="text-xs text-muted-foreground num">{p.ticker} · {fmtPercent(p.allocation, 1)}</div>
            </div>
            <span className="text-right text-sm font-semibold num">{format(p.value)}</span>
            <span className={cn('text-right text-[13px] num', p.dailyChangePct >= 0 ? 'text-profit' : 'text-loss')}>{formatPct(p.dailyChangePct)}</span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

function DividendMini() {
  const { t } = useTranslation();
  const d = useDividendModel();
  const { format } = useCurrency();
  const max = Math.max(1e-9, ...d.forecast.map((m) => m.amountUsd));
  return (
    <Panel to="/dividendy" title={`${t('nav.dividends')} →`} action={<span className="text-xs text-muted-foreground">{t('overview.dividends.months')}</span>}>
      <div className="text-[28px] font-semibold tracking-[-0.03em] text-profit num">≈ {format(d.annualTotal)}</div>
      <div className="mt-3 flex h-14 items-end gap-1">
        {d.forecast.map((m) => (
          <div key={m.month} title={`${monthShort(m.month + '-01')}: ${format(m.amountUsd)}`} className="flex-1 rounded-[5px]"
            style={{ height: m.amountUsd > 0 ? `${Math.max(12, (m.amountUsd / max) * 100)}%` : 3, background: m.amountUsd === 0 ? 'hsl(0 0% 100% / 0.08)' : m.declared ? 'linear-gradient(180deg, hsl(var(--profit)), hsl(var(--profit) / 0.25))' : 'hsl(var(--profit) / 0.32)' }} />
        ))}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{t('overview.dividends.legend')}</div>
    </Panel>
  );
}

function TaxMini() {
  const { t } = useTranslation();
  const tax = useTaxModel();
  const { hidden } = useCurrency();
  const czk = (v: number) => (hidden ? (currentLang() === 'en' ? 'CZK ••••' : '•••• Kč') : fmtCzk(v));
  return (
    <Panel to="/dane" title={`${t('overview.tax.title', { year: tax.report.year })} →`} action={tax.overallState === 'over' ? <Pill tone="warning">{t('overview.tax.over')}</Pill> : tax.overallState === 'taxed' ? <Pill tone="warning">{t('overview.tax.taxed')}</Pill> : tax.overallState === 'under' ? <Pill tone="profit">{t('overview.tax.under')}</Pill> : <Pill>{t('overview.tax.unknown')}</Pill>}>
      <div className="text-[28px] font-semibold tracking-[-0.03em] text-warning num">{czk(tax.report.estTaxCzk)}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{t('overview.tax.est', { base: czk(tax.report.taxBaseCzk) })}</div>
      {(tax.report.crypto.rowCount > 0 || tax.report.crypto.unmatchedProceedsCzk > 0) && (
        <div className="text-xs text-muted-foreground mt-1">{t('overview.tax.kinds', {
          securities: t(`overview.tax.${tax.limitState}`),
          crypto: tax.cryptoLimitState === 'none' ? t('overview.tax.noExemption') : t(`overview.tax.${tax.cryptoLimitState}`),
        })}</div>
      )}
      <div className="mt-3.5 flex justify-between border-t border-white/[0.08] pt-3 text-xs">
        <span className="text-muted-foreground">{t('overview.tax.nextExempt')}</span>
        <span className="num">{tax.calendar[0] ? `${fmtDate(tax.calendar[0].firstDate)} · ${tax.calendar[0].tickers.join(', ')}` : '—'}</span>
      </div>
    </Panel>
  );
}

const Index = () => {
  const { t } = useTranslation();
  const { data: positions = [], isLoading } = usePositions();
  const { data: txs = [] } = useTransactions();
  const p = useComputedPortfolio();
  const live = useLivePrices();
  const alerts = useAlerts();
  const { jurisdiction, known: residenceKnown } = useTaxResidence();
  const hasData = positions.some((x) => x.ticker !== 'CASH') || txs.length > 0;

  if (isLoading || p.loading) return <PageSkeleton />;
  if (!hasData) return <Onboarding />;

  const fetched = live.data?.fetchedAt ? new Date(live.data.fetchedAt).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Hero />
        <div className="flex flex-col gap-4">
          <ProfitCard />
          <AttentionCard alerts={alerts} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MoversCard />
        <AllocationCard />
        <UpcomingCard />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PositionsPreview />
        <div className="flex flex-col gap-4">
          <DividendMini />
          {residenceKnown && (jurisdiction.caps.taxEstimate ? <TaxMini /> : <RealizedMini />)}
        </div>
      </div>
      <Footnote>
        <span className={p.stale ? 'text-warning' : 'text-profit'}>●</span> {t('overview.footer.prices', { time: fetched ?? '—' })}{p.stale ? ` ${t('overview.footer.cached')}` : ''} · USD/CZK {fmtNum(p.usdCzk, 3)}
      </Footnote>
    </div>
  );
};

export default Index;
