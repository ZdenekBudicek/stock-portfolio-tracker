// Daně — docs/design/V2-Dane.dc.html
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useComputedPortfolio, useTransactions } from '@/hooks/usePortfolio';
import { useTaxModel, todayPrague } from '@/hooks/useInsights';
import TaxReport from '@/components/TaxReport';
import type { FxMethod } from '@/lib/cnbRates';
import { TickerLogo } from '@/components/TickerLogo';
import { fmtDate } from '@/components/v2/widgets';
import { EmptyNote, Footnote, Kpi, Label, PageTitle, Panel, Pill } from '@/components/v2/ui';
import { Input } from '@/components/ui/input';
import { isRealTradeTx } from '@/lib/fifo';
import { SALE_INCOME_LIMIT_CZK } from '@/lib/czTax';
import { simulateSale } from '@/lib/saleSimulation';
import { currentLang } from '@/i18n';
import { fmtCzk, fmtNum, fmtPercent } from '@/i18n/format';
import { cn } from '@/lib/utils';
import { proceedsBreakdown, type Bucket } from '@/lib/taxBreakdown';
import { useTaxPrefs } from '@/hooks/useTaxPrefs';
import { useTaxResidence } from '@/hooks/useTaxResidence';
import { RealizedGainsView } from '@/components/RealizedGains';
import { ResidenceLoadError } from '@/components/TaxResidence';

function useCzk() {
  const { hidden } = useCurrency();
  return (v: number | null | undefined) => (v == null ? '—' : hidden ? (currentLang() === 'en' ? 'CZK ••••' : '•••• Kč') : fmtCzk(v));
}

type TaxModel = ReturnType<typeof useTaxModel>;

const BUCKET_COLOR: Record<Bucket, string> = {
  gain: 'hsl(var(--profit))',
  loss: 'hsl(var(--loss))',
  exempt: 'hsl(194 85% 62%)',
  unknown: 'hsl(0 0% 100% / 0.25)',
};

/**
 * Where the year's sale proceeds — the figure the 100 000 Kč limit is measured on — come from:
 * sold at a gain, at a loss (the loss lowers the tax base but the proceeds still count towards
 * the limit), tax-free after the time test, and per stock.
 */
function ProceedsBreakdownPanel({ report }: { report: TaxModel['report'] }) {
  const { t } = useTranslation();
  const czk = useCzk();
  const [all, setAll] = useState(false);
  const b = useMemo(() => proceedsBreakdown(report), [report]);
  if (b.byTicker.length === 0) return null;
  const order: Bucket[] = ['gain', 'loss', 'exempt', 'unknown'];
  const shown = order.filter((k) => b.buckets[k].lots > 0);
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${czk(Math.abs(v))}`;
  const rows = all ? b.byTicker : b.byTicker.slice(0, 10);
  const maxShare = Math.max(...b.byTicker.map((x) => x.share), 1e-9);
  return (
    <Panel className="lg:col-span-12" title={t('taxes.brk.title', { year: report.year })} action={<span className="text-xs text-muted-foreground">{t('taxes.brk.total', { total: czk(b.totalCzk) })}</span>}>
      <p className="-mt-2 mb-4 text-xs text-muted-foreground">{t('taxes.brk.intro')}</p>
      {/* One bar = all proceeds, split by what kind of sale they came from. */}
      <div className="flex h-4 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {shown.map((k) => (
          <div key={k} title={`${t(`taxes.brk.b.${k}`)}: ${czk(b.buckets[k].proceedsCzk)}`}
            style={{ width: `${(b.buckets[k].proceedsCzk / Math.max(b.totalCzk, 1e-9)) * 100}%`, background: BUCKET_COLOR[k] }} />
        ))}
      </div>
      <div className={cn('mt-4 grid gap-2.5', shown.length >= 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3')}>
        {shown.map((k) => {
          const x = b.buckets[k];
          return (
            <div key={k} className="rounded-2xl bg-white/[0.04] p-3.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="h-2.5 w-2.5 rounded-full" style={{ background: BUCKET_COLOR[k] }} />{t(`taxes.brk.b.${k}`)}</div>
              <div className="mt-1.5 text-xl font-semibold tracking-tight num">{czk(x.proceedsCzk)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground num">
                {t('taxes.brk.lots', { count: x.lots })} · {fmtPercent((x.proceedsCzk / Math.max(b.totalCzk, 1e-9)) * 100, 0)}
              </div>
              {k !== 'unknown' && (
                <div className={cn('mt-1.5 text-xs font-semibold num', x.resultCzk >= 0 ? 'text-profit' : 'text-loss')}>
                  {t(k === 'loss' ? 'taxes.brk.lossResult' : k === 'exempt' ? 'taxes.brk.exemptResult' : 'taxes.brk.gainResult', { value: signed(x.resultCzk) })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-5 -mx-2 overflow-x-auto px-2">
        <table className="w-full min-w-[340px] text-[13px]">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th className="py-2 text-left font-medium">{t('taxes.brk.col.stock')}</th>
              <th className="py-2 text-left font-medium">{t('taxes.brk.col.proceeds')}</th>
              <th className="py-2 text-right font-medium">{t('taxes.brk.col.lots')}</th>
              <th className="py-2 text-right font-medium">{t('taxes.brk.col.result')}</th>
            </tr>
          </thead>
          <tbody className="focus-list">
            {rows.map((x) => (
              <tr key={x.ticker} className="border-t border-white/[0.06]">
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2"><TickerLogo ticker={x.ticker} size="xs" />{x.ticker}</span>
                  {(x.lossLots > 0 || x.exemptLots > 0) && (
                    <div className="mt-0.5 pl-7 text-[11px] leading-snug">
                      {x.lossLots ? <span className="text-loss">{t('taxes.brk.lossLots', { count: x.lossLots })}</span> : null}
                      {x.lossLots && x.exemptLots ? <span className="text-muted-foreground"> · </span> : null}
                      {x.exemptLots ? <span className="text-[hsl(194_85%_62%)]">{t('taxes.brk.exemptLots', { count: x.exemptLots })}</span> : null}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2.5">
                    <div className="hidden h-2 w-28 rounded-full bg-white/[0.06] sm:block lg:w-40"><div className="h-2 rounded-full bg-primary/70" style={{ width: `${(x.share / maxShare) * 100}%` }} /></div>
                    <span className="num whitespace-nowrap">{czk(x.proceedsCzk)}</span>
                    <span className="whitespace-nowrap text-[11px] text-muted-foreground num">{fmtPercent(x.share * 100, 0)}</span>
                  </div>
                </td>
                <td className="py-2 pl-2 text-right num text-muted-foreground">
                  {x.lots}
                </td>
                <td className={cn('py-2 pl-2 text-right font-semibold num whitespace-nowrap', x.resultCzk >= 0 ? 'text-profit' : 'text-loss')}>{signed(x.resultCzk)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {b.byTicker.length > 10 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-xs font-medium text-primary hover:underline">
          {all ? t('taxes.brk.less') : t('taxes.brk.more', { count: b.byTicker.length - 10 })}
        </button>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{t('taxes.brk.note')}</p>
    </Panel>
  );
}

function Simulator({ model }: { model: TaxModel }) {
  const { t } = useTranslation();
  const { data: txs = [] } = useTransactions();
  const { positions, usdCzk } = useComputedPortfolio();
  const { formatAt, currency } = useCurrency();
  const czk = useCzk();
  const tickers = useMemo(() => [...new Set(model.lots.map((l) => l.ticker))].sort(), [model.lots]);
  const [ticker, setTicker] = useState<string>('');
  const sym = ticker || tickers[0] || '';
  // FIFO runs per broker account: the user picks whose lots are sold (default: the most shares).
  const accounts = useMemo(() => {
    const m = new Map<string, { key: string; broker: string; account: string; shares: number }>();
    for (const l of model.lots) if (l.ticker === sym) {
      const k = `${l.broker}|${l.account}`;
      const e = m.get(k) ?? { key: k, broker: l.broker, account: l.account, shares: 0 };
      e.shares += l.shares; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.shares - a.shares);
  }, [model.lots, sym]);
  const [accountKey, setAccountKey] = useState('');
  const account = accounts.find((a) => a.key === accountKey) ?? accounts[0] ?? null;
  const price = positions.find((p) => p.ticker === sym)?.currentPrice ?? 0;
  const [sharesText, setSharesText] = useState('');
  const [priceText, setPriceText] = useState('');
  const shares = Number(sharesText.replace(',', '.')) || Math.min(10, account?.shares ?? 0);
  const salePrice = Number(priceText.replace(',', '.')) || price;
  const real = useMemo(() => txs.filter(isRealTradeTx) as any[], [txs]);
  const sim = useMemo(() => (account && shares > 0 && salePrice > 0
    ? simulateSale(real, model.report, { ticker: sym, broker: account.broker, account: account.account, shares, priceUsd: salePrice, feeUsd: 0, at: new Date().toISOString(), saleFx: usdCzk }, model.settings, model.kindOf)
    : null), [real, model.report, model.settings, model.kindOf, sym, account, shares, salePrice, usdCzk]);
  const sh = (v: number) => fmtNum(v, 4);

  return (
    <Panel className="lg:col-span-5" glow="primary" title={t('taxes.sim.title')} action={<Pill tone="primary">{t('common.simulation')}</Pill>}>
      {!account ? <EmptyNote>{t('taxes.sim.noLots')}</EmptyNote> : (
        <>
          <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-2.5">
            <label className="text-xs text-muted-foreground">{t('taxes.sim.stock')}
              <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2.5">
                <TickerLogo ticker={sym} size="xs" />
                <select value={sym} onChange={(e) => { setTicker(e.target.value); setAccountKey(''); setSharesText(''); setPriceText(''); }} className="h-10 w-full bg-transparent text-sm text-foreground outline-none">
                  {tickers.map((x) => <option key={x} value={x} className="bg-popover">{x}</option>)}
                </select>
              </div>
            </label>
            <label className="text-xs text-muted-foreground">{t('taxes.sim.shares')}
              <Input inputMode="decimal" className="mt-1.5 h-10 rounded-xl num" placeholder={String(Math.min(10, Number(account.shares.toFixed(4))))} value={sharesText} onChange={(e) => setSharesText(e.target.value)} />
            </label>
            <label className="text-xs text-muted-foreground">{t('taxes.sim.price')}
              <Input inputMode="decimal" className="mt-1.5 h-10 rounded-xl num" placeholder={price.toFixed(2)} value={priceText} onChange={(e) => setPriceText(e.target.value)} />
            </label>
          </div>
          {accounts.length > 1 && (
            <label className="mt-2.5 block text-xs text-muted-foreground">{t('taxes.sim.account')}
              <select value={account?.key} onChange={(e) => setAccountKey(e.target.value)} className="mt-1.5 h-9 w-full rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-sm text-foreground outline-none">
                {accounts.map((a) => <option key={a.key} value={a.key} className="bg-popover">{a.broker}{a.account ? ` · ${a.account}` : ''} — {t('taxes.sim.sharesN', { n: sh(a.shares) })}</option>)}
              </select>
            </label>
          )}
          {account && <div className="mt-1.5 text-[11px] text-muted-foreground">{t('taxes.sim.fromAccount', { account: `${account.broker}${account.account ? ` · ${account.account}` : ''}`, n: sh(account.shares) })}</div>}
          {sim && (
            <>
              <Label className="mt-4">{t('taxes.sim.lots')}</Label>
              <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto">
                {sim.pieces.map((p, i) => {
                  // In CZK the gain is against the purchase-day rate (what the tax uses).
                  const g = currency === 'CZK' ? p.gainCzk : p.gainUsd;
                  return (
                    <div key={i} className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2 text-[13px]">
                      <span className="num">{fmtDate(p.acquiredDate)} · {t('taxes.sim.sharesN', { n: sh(p.shares) })}</span>
                      <span className="flex items-center gap-2">
                        <span className={cn('num', g == null ? 'text-muted-foreground' : g >= 0 ? 'text-profit' : 'text-loss')}>{g == null ? '—' : `${g >= 0 ? '+' : ''}${formatAt(p.gainUsd, g)}`}</span>
                        <Pill tone={p.exempt ? 'profit' : 'warning'}>{p.exempt ? t('taxes.sim.exempt') : t('taxes.sim.taxable')}</Pill>
                      </span>
                    </div>
                  );
                })}
                {sim.missingShares > 1e-9 && <div className="text-xs text-loss">{t('taxes.sim.missing', { n: sh(sim.missingShares) })}</div>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('taxes.sim.proceeds')} value={czk(sim.proceedsCzk)} size="sm" /></div>
                <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('taxes.sim.gain')} value={czk(sim.gainCzk)} tone={(sim.gainCzk ?? 0) >= 0 ? 'profit' : 'loss'} size="sm" /></div>
              </div>
              <div className="mt-2.5 rounded-2xl border border-warning/25 bg-warning/10 p-4">
                <Label className="text-warning/80">{(sim.extraTaxCzk ?? 0) < 0 ? t('taxes.sim.taxDown', { year: model.report.year }) : t('taxes.sim.taxUp', { year: model.report.year })}</Label>
                <div className="text-3xl font-semibold tracking-[-0.03em] text-warning num">{sim.extraTaxCzk == null ? '—' : `${sim.extraTaxCzk < 0 ? '−' : '+'}${czk(Math.abs(sim.extraTaxCzk))}`}</div>
                <div className="text-xs text-muted-foreground">
                  {sim.extraTaxCzk == null
                    ? t('taxes.sim.cannot')
                    : `${sim.yearComplete ? '' : `${t('taxes.sim.approx')} `}${t('taxes.sim.base', { from: czk(model.report.taxBaseCzk), to: czk(sim.taxBaseAfterCzk) })}${sim.underLimitAfter ? ` · ${t('taxes.sim.stillUnder')}` : ''}${sim.capTaxedShareAfter > 0 ? ` · ${t('taxes.sim.capped', { pct: fmtPercent(sim.capTaxedShareAfter * 100, 1) })}` : ''}`}
                </div>
              </div>
              <p className="mt-2.5 text-[11px] text-muted-foreground">{t('taxes.sim.note', { rate: fmtNum(usdCzk, 3) })}</p>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

/** Czech tax residents: estimate, 100 000 Kč limit, exempt calendar, simulator and the full report. */
const CzTaxes = () => {
  const { t } = useTranslation();
  // One set of settings for the cards, the simulator and the full report below.
  const [year, setYear] = useState<number>(Number(todayPrague().slice(0, 4)));
  // Start from the defaults chosen in Settings; switching here is for this look only.
  const [prefs] = useTaxPrefs();
  const [fxMethod, setFxMethod] = useState<FxMethod>(prefs.fxMethod);
  const [limitIncludesExempt, setLimitIncludesExempt] = useState(prefs.limitIncludesExempt);
  const settings = useMemo(() => ({ fxMethod, limitIncludesExempt }), [fxMethod, limitIncludesExempt]);
  const tax = useTaxModel(year, settings);
  // A simulated sale happens today, so it changes THIS year's report whatever year is shown.
  const taxNow = useTaxModel(Number(todayPrague().slice(0, 4)), settings);
  const { format, formatAt, currency } = useCurrency();
  const gainText = (usd: number | null, czkV: number | null) => {
    const g = currency === 'CZK' ? czkV : usd;
    return g == null || usd == null ? '—' : `${g >= 0 ? '+' : ''}${formatAt(usd, g)}`;
  };
  const czk = useCzk();
  const r = tax.report;
  const limitPct = Math.min(100, (SALE_INCOME_LIMIT_CZK / Math.max(SALE_INCOME_LIMIT_CZK, r.limitBaseCzk)) * 100);
  const times = r.limitBaseCzk / SALE_INCOME_LIMIT_CZK;
  const exempt = tax.summary;
  const soon = tax.calendar.filter((m) => m.firstDate <= `${Number(tax.today.slice(0, 4)) + 1}${tax.today.slice(4)}`);
  const limitText = czk(SALE_INCOME_LIMIT_CZK);
  // The bar is the securities limit; crypto has its own line below.
  const secOver = tax.limitState === 'over';
  return (
    <div>
      <PageTitle eyebrow={t('taxes.eyebrow')} title={t('taxes.title', { year: r.year })} right={<span className="text-xs text-muted-foreground">{t('taxes.switchHint')}</span>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel className="lg:col-span-5" glow="warning">
          <div className="flex items-center justify-between"><Label className="text-warning/80">{t('taxes.est.title')}</Label><Pill tone="warning">{fmtPercent(15, 0)}</Pill></div>
          <div className="mt-2.5 text-5xl font-semibold tracking-[-0.045em] text-warning leading-none num">{czk(r.estTaxCzk)}</div>
          <div className="mt-2.5 text-xs text-muted-foreground">{t('taxes.est.sub', { gain: czk(r.taxable.gainCzk) })}</div>
          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <div className="rounded-2xl bg-white/[0.05] p-3"><Kpi label={t('taxes.est.exemptGain')} value={czk(r.exempt.gainCzk)} tone="profit" size="sm" /></div>
            <div className="rounded-2xl bg-white/[0.05] p-3">
              <Label>{t('taxes.est.completeness')}</Label>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold"><span className={cn('h-2 w-2 rounded-full', r.complete ? 'bg-profit' : 'bg-warning')} />{r.complete ? t('taxes.est.complete') : t('taxes.est.incomplete')}</div>
            </div>
          </div>
        </Panel>

        <Panel className="lg:col-span-7" title={t('taxes.limit.title', { limit: limitText })} action={tax.limitState === 'over' ? <Pill tone="loss">{t('taxes.limit.over')}{times >= 2 ? ` ${Math.floor(times)}×` : ''}</Pill> : tax.limitState === 'under' ? <Pill tone="profit">{t('overview.tax.under')}</Pill> : <Pill tone="warning">{t('overview.tax.unknown')}</Pill>}>
          <div className="text-xs text-muted-foreground -mt-2">{t(tax.settings.limitIncludesExempt ? 'taxes.limit.ruleInclExempt' : 'taxes.limit.rule')}</div>
          <div className="mt-5 flex items-end gap-3 flex-wrap">
            <div className="text-4xl font-semibold tracking-[-0.04em] num">{czk(r.limitBaseCzk)}</div>
            <div className="mb-1.5 text-xs text-muted-foreground">{t('taxes.limit.proceeds', { year: r.year })}{tax.limitState === 'unknown' ? ` · ${t('taxes.limit.cannotConfirm')}` : ''}</div>
          </div>
          <div className="relative mt-5 h-4 rounded-full" style={{ background: secOver ? `linear-gradient(90deg, hsl(var(--profit)) 0 ${limitPct}%, hsl(var(--warning)) ${limitPct}%, hsl(var(--loss)))` : 'hsl(0 0% 100% / 0.07)' }}>
            {!secOver && <div className="h-4 rounded-full bg-profit" style={{ width: `${(r.limitBaseCzk / SALE_INCOME_LIMIT_CZK) * 100}%` }} />}
            {secOver && <div className="absolute -top-2 h-8 w-0.5 bg-foreground" style={{ left: `${limitPct}%` }} />}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{secOver ? t('taxes.limit.marker', { limit: limitText, pct: fmtPercent(limitPct, 0) }) : '0'}</span>
            <span className="num">{secOver ? czk(r.limitBaseCzk) : limitText}</span>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2.5">
            <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('taxes.limit.sales')} value={r.rows.length} size="sm" /></div>
            <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('taxes.limit.taxableGain')} value={czk(r.taxable.gainCzk)} tone={r.taxable.gainCzk >= 0 ? 'profit' : 'loss'} size="sm" /></div>
            <div className="rounded-2xl bg-white/[0.04] p-3"><Kpi label={t('taxes.limit.base')} value={czk(r.taxBaseCzk)} size="sm" /></div>
          </div>
          {(r.crypto.rowCount > 0 || r.crypto.unmatchedProceedsCzk > 0) && (
            <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-muted-foreground">
              <div className="mb-1">{t('taxes.limit.securitiesOnly')}</div>
              <span className="font-semibold text-foreground">{t('taxes.limit.crypto', { year: r.year, proceeds: czk(r.crypto.proceedsCzk) })}</span>
              {tax.cryptoLimitState !== 'none' && <> · <span className={cn(tax.cryptoLimitState === 'over' ? 'text-loss' : tax.cryptoLimitState === 'under' ? 'text-profit' : 'text-warning')}>
                {tax.cryptoLimitState === 'over' ? t('taxes.limit.cryptoOver', { limit: limitText, base: czk(r.crypto.taxBaseCzk) }) : tax.cryptoLimitState === 'under' ? t('taxes.limit.cryptoUnder') : t('taxes.limit.cryptoUnknown')}
              </span></>}
              {r.rows.some((x) => x.assetKind === 'crypto' && !x.exemptionsApply) && <div className="mt-1 text-loss">{t('taxes.limit.cryptoNoExemption', { gain: czk(r.crypto.noExemption.gainCzk) })}</div>}
            </div>
          )}
          {r.unresolvedTickers.length > 0 && (
            <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs">{t('taxes.limit.unresolved', { tickers: r.unresolvedTickers.join(', ') })}</div>
          )}
          {r.cap.taxedShare > 0 && (
            <div className="mt-3 rounded-2xl border border-loss/30 bg-loss/10 p-3 text-xs">
              {t('taxes.limit.cap', { base: czk(r.cap.baseCzk), pct: fmtPercent(r.cap.taxedShare * 100, 1), gain: czk(r.cap.taxedGainCzk) })}
            </div>
          )}
        </Panel>

        <ProceedsBreakdownPanel report={r} />

        <Panel className="lg:col-span-7" title={t('taxes.cal.title')} action={<span className="text-xs text-muted-foreground">{t('taxes.cal.sub')}</span>}>
          {exempt.exemptLots > 0 && (
            <div className="mb-3 flex items-center gap-3.5 rounded-2xl border border-profit/25 bg-profit/[0.08] p-3.5">
              <div className="flex -space-x-2">{exempt.exemptTickers.slice(0, 4).map((x) => <TickerLogo key={x} ticker={x} size="md" />)}</div>
              <div className="flex-1 min-w-0"><div className="font-semibold">{t('taxes.cal.alreadyFree', { count: exempt.exemptLots })}</div><div className="text-xs text-muted-foreground truncate">{exempt.exemptTickers.join(', ')} · {t('taxes.cal.sellFree')}</div></div>
              <div className="text-right"><div className="font-semibold num">{format(exempt.exemptValueUsd)}</div><div className={cn('text-xs num', ((currency === 'CZK' ? exempt.exemptGainCzk : exempt.exemptGainUsd) ?? 0) >= 0 ? 'text-profit' : 'text-loss')}>{t('taxes.cal.gain')} {gainText(exempt.exemptGainUsd, exempt.exemptGainCzk)}</div></div>
            </div>
          )}
          {soon.length === 0 && tax.calendar.length > 0 && <div className="mb-2 text-xs text-muted-foreground">{t('taxes.cal.nothingSoon')}</div>}
          {tax.calendar.length === 0 ? <EmptyNote>{t('taxes.cal.empty')}</EmptyNote> : (
            <div className="-mx-2 overflow-x-auto px-2"><div className="min-w-[520px] space-y-0.5">
              <div className="grid grid-cols-[96px_minmax(0,90px)_1fr_90px_90px] gap-3 px-2 text-[11px] text-muted-foreground"><span>{t('taxes.cal.from')}</span><span /><span>{t('taxes.cal.elapsed')}</span><span className="text-right">{t('taxes.cal.value')}</span><span className="text-right">{t('taxes.cal.gainCol')}</span></div>
              {tax.calendar.slice(0, 10).map((m) => {
                const progress = m.lots.reduce((s, l) => s + l.progress * l.shares, 0) / Math.max(1e-9, m.shares);
                const days = new Set(m.lots.map((l) => l.exemptFrom)).size;
                return (
                  <details key={m.month} className="rounded-xl hover:bg-white/[0.04] open:bg-white/[0.04]">
                    <summary className="grid cursor-pointer list-none grid-cols-[96px_minmax(0,90px)_1fr_90px_90px] items-center gap-3 px-2 py-2 [&::-webkit-details-marker]:hidden">
                      <span className="text-[13px] num">{fmtDate(m.firstDate)}{days > 1 && <span className="block text-[10px] text-muted-foreground">{t('taxes.cal.moreDays', { count: days - 1, until: fmtDate(m.lots[m.lots.length - 1].exemptFrom) })}</span>}</span>
                      <span className="flex -space-x-2">{m.tickers.slice(0, 3).map((x) => <TickerLogo key={x} ticker={x} size="xs" className="!w-6 !h-6" />)}</span>
                      <div className="h-2 rounded-full bg-white/[0.06]"><div className="h-2 rounded-full" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, hsl(var(--primary) / 0.35), hsl(var(--primary)))' }} /></div>
                      <span className="text-right text-[13px] num">{m.valueUsd == null ? '—' : format(m.valueUsd)}</span>
                      <span className={cn('text-right text-[13px] num', ((currency === 'CZK' ? m.gainCzk : m.gainUsd) ?? 0) >= 0 ? 'text-profit' : 'text-loss')}>{gainText(m.gainUsd, m.gainCzk)}</span>
                    </summary>
                    {/* Every lot of the month with its exact first tax-free day — tap to open (works on phones). */}
                    <div className="space-y-1 px-2 pb-2.5 sm:pl-[108px]">
                      {m.lots.map((l, i) => (
                        <div key={`${l.key}-${i}`} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <TickerLogo ticker={l.ticker} size="xs" className="!w-4 !h-4 !rounded" />
                            <span className="text-foreground">{l.ticker}</span> · {t('taxes.cal.lotLine', { from: fmtDate(l.exemptFrom), bought: fmtDate(l.acquiredDate) })}
                          </span>
                          <span className="num">{t('taxes.sim.sharesN', { n: fmtNum(l.shares, 4) })}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div></div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t('taxes.cal.note')}</p>
        </Panel>

        <Simulator model={taxNow} />
      </div>
      <div className="mt-4"><TaxReport controls={{ year, setYear, fxMethod, setFxMethod, limitIncludesExempt, setLimitIncludesExempt }} /></div>
      <Footnote>{t('taxes.footnote')}</Footnote>
    </div>
  );
};

// Which view depends on the user's tax residence, not on the UI language.
const Taxes = () => {
  const { jurisdiction, known, isError } = useTaxResidence();
  // Unknown residence: neither the Czech nor the neutral view (a wrong one is worse than none).
  if (!known) return isError ? <ResidenceLoadError /> : null;
  return jurisdiction.caps.taxEstimate ? <CzTaxes /> : <RealizedGainsView />;
};

export default Taxes;
