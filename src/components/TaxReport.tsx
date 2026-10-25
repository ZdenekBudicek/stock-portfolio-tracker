import { fmtDay } from "@/i18n/format";
import { useTranslation } from "react-i18next";
import { t } from "i18next";
import { currentLocale } from "@/i18n";
import { useMemo, useState } from "react";
import { FileText, Calendar, Download, Shield, Clock, Layers, ChevronDown, AlertTriangle, Coins } from "lucide-react";
import { useCurrency } from "@/contexts/CurrencyContext";
import { usePositions, useTransactions, useComputedPortfolio, useLivePrices } from "@/hooks/usePortfolio";
import { useDividends } from "@/hooks/useExtras";
import { runFifo, isRealTradeTx, type FifoWarning, type OpenLot } from "@/lib/fifo";
import { buildSalesReport, pragueDate, timeTestExemptFrom, daysBetween, SALE_INCOME_LIMIT_CZK, type TaxSettings } from "@/lib/czTax";
import { buildDividendReport } from "@/lib/dividendTax";
import { cnbUsdCzk, CNB_DATA_TO, type FxMethod } from "@/lib/cnbRates";
import { salesCsvRows, dividendsCsvRows, downloadCsv } from "@/lib/taxCsv";
import { TickerLogo } from "@/components/TickerLogo";
import { useAssetKindResolver } from "@/hooks/useAssetKinds";

const MASK = "••••";

/** Format days as "X let Y měs. Z dní" or shorter variants */
function formatDuration(days: number): string {
  if (days <= 0) return t('legacy.taxReport.durationDays', { count: 0 });
  const years = Math.floor(days / 365.25);
  const afterYears = days - Math.floor(years * 365.25);
  const months = Math.floor(afterYears / 30.4375);
  const remDays = Math.max(0, Math.round(afterYears - months * 30.4375));
  const parts: string[] = [];
  if (years > 0) parts.push(t('legacy.taxReport.years', { count: years }));
  if (months > 0) parts.push(t('legacy.taxReport.months', { count: months }));
  if (years === 0 && remDays > 0) parts.push(t('legacy.taxReport.durationDays', { count: remDays }));
  if (parts.length === 0) parts.push(t('legacy.taxReport.durationDays', { count: days }));
  return parts.join(" ");
}

const fmtDate = (iso: string) => fmtDay(iso);
const brokerLabel = (b: string) => ({ T212: "T212", REVOLUT: "Revolut", XTB: "XTB", MANUAL: t('legacy.taxReport.manual') } as Record<string, string>)[b] ?? b;

const WARNING_TEXT: Record<FifoWarning["kind"], (w: FifoWarning) => string> = {
  "unmatched-sell": (w) => t('legacy.taxReport.sharesSoldWithoutAMatchingPurchaseMissingAn', { v0: w.shares?.toLocaleString(currentLocale(), { maximumFractionDigits: 6 }) }),
  "split-without-lots": () => t('legacy.taxReport.splitWithoutPurchasedSharesAddedSharesHaveZero'),
  "merger-without-cash": () => t('legacy.taxReport.mergerCashMissingFromTradesAnOlderImport'),
  "merger-without-lots": () => t('legacy.taxReport.mergerSharesWithoutTheOriginalPurchaseZeroCost'),
  "merger-cash-unpaired": (w) => t('legacy.taxReport.mergerCashWithoutRemovedSharesExcludedFromThe', { v0: w.amountUsd?.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
  "merger-cash-with-stock": (w) => t('legacy.taxReport.cashConsiderationInAStockMergerIsTaxed', { v0: w.amountUsd?.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
};

interface LotView extends OpenLot {
  name: string;
  acquiredDate: string;
  exemptFrom: string;
  exempt: boolean;
  days: number;
  remainingDays: number;
  progress: number;
}

export interface TaxControls {
  year: number; setYear: (y: number) => void;
  fxMethod: FxMethod; setFxMethod: (m: FxMethod) => void;
}

/** `controls`: year and settings owned by the parent (Daně page) so its summary cards match. */
const TaxReport = ({ controls }: { controls?: TaxControls } = {}) => {
  const { t } = useTranslation();
  const { format, hidden } = useCurrency();
  // Czech tax: today's REAL USD/CZK, whatever currency the app shows.
  const liveRate = useLivePrices().data?.usdCzk ?? 23;
  const { data: positions = [] } = usePositions();
  const { data: allTxs = [] } = useTransactions();
  const { data: divs = [] } = useDividends();
  const { positions: livePositions } = useComputedPortfolio();
  const [yearS, setYearS] = useState<number>(new Date().getFullYear());
  const [fxMethodS, setFxMethodS] = useState<FxMethod>("cnb-daily");
  const year = controls?.year ?? yearS, setYear = controls?.setYear ?? setYearS;
  const fxMethod = controls?.fxMethod ?? fxMethodS, setFxMethod = controls?.setFxMethod ?? setFxMethodS;
  // The 100 000 Kč test always counts every sale (audit B11); no switch.
  const limitIncludesExempt = true;
  const [openTickers, setOpenTickers] = useState<Set<string>>(new Set());
  const toggleTicker = (ticker: string) =>
    setOpenTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker); else next.add(ticker);
      return next;
    });

  const czk = (n: number | null) => (n == null ? "—" : hidden ? t('legacy.taxReport.czk', { v0: MASK }) : t('legacy.taxReport.czk', { v0: Math.round(n).toLocaleString(currentLocale()) }));
  const usd = (n: number) => (hidden ? `$${MASK}` : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // One FIFO over real trades (no reconciliation or holdings-snapshot rows) — the same
  // lots the header's realized profit and the closed positions are computed from.
  const fifo = useMemo(() => runFifo(allTxs.filter(isRealTradeTx)), [allTxs]);
  const settings: TaxSettings = { fxMethod, limitIncludesExempt };
  // Crypto has its own rules; the kind comes from the whole instrument registry (sold
  // positions included) — the same resolver as the Daně cards and the Overview.
  const kindOf = useAssetKindResolver();
  const sales = useMemo(() => buildSalesReport(fifo.disposals, year, { fxMethod, limitIncludesExempt }, fifo.warnings, kindOf), [fifo, year, fxMethod, limitIncludesExempt, kindOf]);
  const crypto = sales.crypto;
  const hasCrypto = crypto.rowCount > 0 || crypto.unmatchedProceedsCzk > 0;
  const pct = (share: number) => `${(share * 100).toLocaleString(currentLocale(), { maximumFractionDigits: 1 })} %`;
  const dividends = useMemo(() => buildDividendReport(divs, year, fxMethod), [divs, year, fxMethod]);
  const yearWarnings = useMemo(() => fifo.warnings.filter((w) => pragueDate(w.date).startsWith(`${year}-`)), [fifo, year]);
  const olderWarnings = fifo.warnings.length - yearWarnings.length;

  const nameMap = useMemo(() => new Map(positions.map((p) => [p.ticker, p.name])), [positions]);
  const priceMap = useMemo(() => new Map(livePositions.map((p) => [p.ticker, p.currentPrice])), [livePositions]);

  /** Open lots with their time test, judged in the Prague calendar. */
  const lots = useMemo<LotView[]>(() => {
    const today = pragueDate(new Date().toISOString());
    return fifo.openLots.map((l) => {
      const acquiredDate = pragueDate(l.acquiredAt);
      const exemptFrom = timeTestExemptFrom(acquiredDate);
      const days = Math.max(0, daysBetween(acquiredDate, today));
      const span = daysBetween(acquiredDate, exemptFrom);
      return {
        ...l, name: nameMap.get(l.ticker) ?? l.ticker, acquiredDate, exemptFrom,
        exempt: today >= exemptFrom, days,
        remainingDays: Math.max(0, daysBetween(today, exemptFrom)),
        progress: Math.min(100, (days / span) * 100),
      };
    });
  }, [fifo, nameMap]);

  /** Minimum lot current value (USD) to display — filters out tiny dust positions like residual LRCX */
  const MIN_LOT_VALUE_USD = 90;
  const lotCost = (l: OpenLot) => l.shares * (l.priceUsd + l.feePerShareUsd);

  /** Group lots by ticker for display, filtering out dust lots (< $90 current value) */
  const lotsByTicker = useMemo(() => {
    const map = new Map<string, LotView[]>();
    for (const l of lots) {
      const price = priceMap.get(l.ticker) ?? l.priceUsd;
      if (l.shares * price < MIN_LOT_VALUE_USD) continue;
      if (!map.has(l.ticker)) map.set(l.ticker, []);
      map.get(l.ticker)!.push(l);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
    return map;
  }, [lots, priceMap]);

  const soldInYear = useMemo(() => new Set(sales.rows.map((r) => r.ticker)), [sales]);

  /** How much of the current portfolio is already past the time test. */
  const exemptionSummary = useMemo(() => {
    let exemptCost = 0, taxableCost = 0, exemptValue = 0, taxableValue = 0, exemptShares = 0, taxableShares = 0;
    // Hypothetical gain if the taxable lots were sold today: value at today's rate minus the
    // cost at the ČNB rate of each purchase day. Null as soon as one purchase rate is missing.
    let taxableGainCzk: number | null = 0;
    for (const l of lots) {
      const price = priceMap.get(l.ticker) ?? l.priceUsd;
      const cost = lotCost(l);
      const value = l.shares * price;
      if (l.exempt) { exemptCost += cost; exemptValue += value; exemptShares += l.shares; continue; }
      taxableCost += cost; taxableValue += value; taxableShares += l.shares;
      const fx = cnbUsdCzk(l.acquiredDate);
      taxableGainCzk = taxableGainCzk != null && fx ? taxableGainCzk + value * liveRate - cost * fx.rate : null;
    }
    const totalValue = exemptValue + taxableValue;
    return {
      exemptCost, taxableCost, exemptValue, taxableValue, exemptShares, taxableShares,
      exemptPct: totalValue > 0 ? (exemptValue / totalValue) * 100 : 0,
      taxableGainCzk,
    };
  }, [lots, priceMap, liveRate]);

  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    allTxs.forEach((row) => { if (isRealTradeTx(row)) set.add(Number(pragueDate(row.executed_at).slice(0, 4))); });
    divs.forEach((d) => { if (d.status === "paid") set.add(Number((d.pay_date ?? d.ex_date).slice(0, 4))); });
    return Array.from(set).filter((y) => y <= new Date().getFullYear()).sort((a, b) => b - a);
  }, [allTxs, divs]);

  const missingFx = [...new Set([...sales.missingFx, ...dividends.missingFx])].sort();
  const hasWarnings = yearWarnings.length > 0 || missingFx.length > 0 || dividends.estimatedCount > 0 || sales.unresolvedTickers.length > 0;
  const usingGfr = fxMethod === "gfr-annual";

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 sm:p-6 animate-fade-in-up">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <div>
          <h2 className="font-display text-xl font-bold flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" /> {t('legacy.taxReport.taxReport')}</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            {t('legacy.taxReport.salesMatchedUsingFifoWithinEachBrokerageAccount')}{" "}{usingGfr ? t('legacy.taxReport.gfAnnualExchangeRateForThePurchaseSale') : t('legacy.taxReport.theNbRateOnThePurchaseAndSale')}.
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <select value={year} onChange={(e) => setYear(parseInt(e.target.value))} aria-label={t('legacy.taxReport.year')}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-background">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={fxMethod} onChange={(e) => setFxMethod(e.target.value as FxMethod)} aria-label={t('legacy.taxReport.exchangeRate')}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-background">
            <option value="cnb-daily">{t('legacy.taxReport.dailyNbRate')}</option>
            <option value="gfr-annual">{t('legacy.taxReport.annualGfRate')}</option>
          </select>
          <button onClick={() => downloadCsv(`danovy-report-prodeje-${year}.csv`, salesCsvRows(sales))}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-accent inline-flex items-center gap-1.5">
            <Download className="w-3 h-3" /> {t('legacy.taxReport.salesCsv')}</button>
          <button onClick={() => downloadCsv(`danovy-report-dividendy-${year}.csv`, dividendsCsvRows(dividends))}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-accent inline-flex items-center gap-1.5">
            <Download className="w-3 h-3" /> {t('legacy.taxReport.dividendsCsv')}</button>
        </div>
      </div>

      {hasWarnings && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 mb-5 text-[11px] space-y-1.5">
          <p className="font-bold flex items-center gap-1.5 text-warning"><AlertTriangle className="w-3.5 h-3.5" /> {t('legacy.taxReport.reportFor')}{" "}{year} {t('legacy.taxReport.isIncomplete')}</p>
          {missingFx.length > 0 && (
            <p>
              {t('legacy.taxReport.missing')}{" "}{usingGfr ? t('legacy.taxReport.gf') : t('legacy.taxReport.nb')} {t('legacy.taxReport.rateFor')}{" "}{missingFx.map(fmtDate).join(", ")} {t('legacy.taxReport.theseRowsHaveNoCzkAmountAndAre')}{" "}{fmtDate(CNB_DATA_TO)}{t('legacy.taxReport.updateItWith')}{" "}<code>node scripts/update-cnb-rates.mjs</code>.
            </p>
          )}
          {yearWarnings.map((w, i) => (
            <p key={i}>
              <span className="font-mono font-bold">{w.ticker}</span> · {brokerLabel(w.broker)}{w.account ? ` ${w.account}` : ""} · {fmtDate(pragueDate(w.date))}: {WARNING_TEXT[w.kind](w)}
            </p>
          ))}
          {sales.unresolvedTickers.length > 0 && (
            <p>{t('legacy.taxReport.kindUnresolved', { v0: sales.unresolvedTickers.join(", ") })}</p>
          )}
          {dividends.estimatedCount > 0 && (
            <p>{t('legacy.taxReport.estimatedDividends', { count: dividends.estimatedCount })}</p>
          )}
        </div>
      )}
      {olderWarnings > 0 && (
        <p className="text-[11px] text-muted-foreground mb-4 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" /> {t('legacy.taxReport.olderWarnings', { count: olderWarnings })}</p>
      )}

      {/* Sales: the figures for the tax return */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <div className="rounded-xl border border-border bg-background/30 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.saleProceeds')}{" "}{year}</p>
          <p className="font-display text-2xl font-bold mt-1">{czk(sales.proceedsCzk)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {hasCrypto && t('legacy.taxReport.securitiesPrefix')}
            {sales.underLimit ? (
              <span className="text-profit font-semibold">{t('legacy.taxReport.belowTheLimitOf')}{" "}{SALE_INCOME_LIMIT_CZK.toLocaleString(currentLocale())} {t('legacy.taxReport.czkSalesAreExempt')}</span>
            ) : (
              <>{t('legacy.taxReport.theLimitOf')}{" "}{SALE_INCOME_LIMIT_CZK.toLocaleString(currentLocale())} {t('legacy.taxReport.czkIncludes')}{" "}{czk(sales.limitBaseCzk)}{!sales.complete && t('legacy.taxReport.incomplete')}</>
            )}
          </p>
        </div>
        <div className="rounded-xl border border-loss/20 bg-loss/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.taxableGain')}{" "}{year}</p>
          <p className="font-display text-2xl font-bold text-loss mt-1">{czk(sales.taxable.gainCzk)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {t('legacy.taxReport.lotsHeld3YearsProceeds')}{" "}{czk(sales.taxable.proceedsCzk)} {t('legacy.taxReport.expenses')}{" "}{czk(sales.taxable.expensesCzk)}
            {sales.underLimit && !hasCrypto && <span className="text-profit font-semibold"> {t('legacy.taxReport.exemptUnderTheLimit')}</span>}
          </p>
        </div>
        <div className="rounded-xl border border-profit/20 bg-profit/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.exemptUnderTheHoldingPeriodTest')}</p>
          <p className="font-display text-2xl font-bold text-profit mt-1">{czk(sales.exempt.gainCzk)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><Shield className="w-3 h-3" /> {t('legacy.taxReport.gainOnLotsHeld3Years')}</p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.estimatedTaxOnSales15')}</p>
          <p className="font-display text-2xl font-bold text-warning mt-1">{czk(sales.estTaxCzk)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {sales.underLimit && crypto.taxBaseCzk === 0 ? t('legacy.taxReport.belowTheLimitZeroTax') : t('legacy.taxReport.fromTheTaxBaseOfLossesAreNot', { v0: czk(sales.taxBaseCzk) })}
          </p>
        </div>
      </div>

      {sales.cap.taxedShare > 0 && (
        <div className="rounded-xl border border-loss/30 bg-loss/5 p-3 mb-5 text-[11px]">
          {t('legacy.taxReport.capNotice', { base: czk(sales.cap.baseCzk), over: czk(sales.cap.overCzk), pct: pct(sales.cap.taxedShare), gain: czk(sales.cap.taxedGainCzk) })}
        </div>
      )}

      {/* Crypto: its own limit and time test from 15. 2. 2025, none before */}
      {hasCrypto && (
        <>
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2"><Coins className="w-4 h-4" /> {t('legacy.taxReport.cryptoTitle', { year })}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            <div className="rounded-xl border border-border bg-background/30 p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.cryptoProceeds')}</p>
              <p className="font-display text-xl font-bold mt-1">{czk(crypto.proceedsCzk)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {!crypto.limitApplies ? t('legacy.taxReport.cryptoNoLimit')
                  : crypto.underLimit ? <span className="text-profit font-semibold">{t('legacy.taxReport.cryptoUnderLimit')}</span>
                  : <>{t('legacy.taxReport.cryptoLimitIncludes', { v0: czk(crypto.limitBaseCzk) })}{!crypto.complete && t('legacy.taxReport.incomplete')}</>}
              </p>
            </div>
            <div className="rounded-xl border border-loss/20 bg-loss/5 p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.cryptoTaxableGain')}</p>
              <p className="font-display text-xl font-bold text-loss mt-1">{czk(crypto.taxable.gainCzk)}</p>
              <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">{t('legacy.taxReport.cryptoBase', { v0: czk(crypto.taxBaseCzk), v1: czk(crypto.estTaxCzk) })}</p>
            </div>
            <div className="rounded-xl border border-profit/20 bg-profit/5 p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('legacy.taxReport.cryptoExemptGain')}</p>
              <p className="font-display text-xl font-bold text-profit mt-1">{czk(crypto.exempt.gainCzk)}</p>
            </div>
          </div>
          {sales.rows.some((r) => r.assetKind === "crypto" && !r.exemptionsApply) && (
            <p className="text-[11px] text-loss mb-5">{t('legacy.taxReport.cryptoNoExemptionNote', { v0: czk(crypto.noExemption.gainCzk) })}</p>
          )}
        </>
      )}

      {/* Dividends */}
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2"><Coins className="w-4 h-4" /> {t('legacy.taxReport.dividends')}{" "}{year} {t('legacy.taxReport.byPaymentDate')}</h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          [t('legacy.taxReport.grossDividends'), dividends.grossCzk, t('legacy.taxReport.section8Annex3')],
          [t('legacy.taxReport.foreignWithholdingTax'), dividends.whtCzk, t('legacy.taxReport.above15IsNotCreditable', { v0: czk(dividends.excessWhtCzk) })],
          [t('legacy.taxReport.creditableTax'), dividends.creditableCzk, dividends.assumedCreditCzk > 0 ? t('legacy.taxReport.verifiedWithholdingAFurtherAssumes15WithholdingCheck', { v0: czk(dividends.assumedCreditCzk) }) : t('legacy.taxReport.max15OfTheGrossAmount')],
          [t('legacy.taxReport.additionalCzechTaxDue'), dividends.topUpCzk, t('legacy.taxReport.15LessTaxCredit', { v0: czk(dividends.czTaxCzk) })],
        ].map(([label, value, note]) => (
          <div key={label as string} className="rounded-xl border border-border bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
            <p className="font-display text-lg font-bold mt-0.5">{czk(value as number)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{note}</p>
          </div>
        ))}
      </div>
      {dividends.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground mb-6">{t('legacy.taxReport.noDividendsPaidIn')}{" "}{year}.</p>
      ) : (
        <>
          <div className="overflow-x-auto mb-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/60">
                  <th className="py-2">{t('legacy.taxReport.payment')}</th><th>{t('legacy.taxReport.ticker')}</th><th>{t('legacy.taxReport.broker')}</th>
                  <th className="text-right">{t('legacy.taxReport.gross')}</th><th className="text-right">{t('legacy.taxReport.withheld')}</th>
                  <th className="text-right">{t('legacy.taxReport.exchangeRate')}</th><th className="text-right">{t('legacy.taxReport.grossCzk')}</th><th className="text-right">{t('legacy.taxReport.withheldCzk')}</th>
                </tr>
              </thead>
              <tbody>
                {dividends.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/30">
                    <td className="py-1.5 whitespace-nowrap">{fmtDate(r.payDate)}</td>
                    <td className="font-mono font-bold"><span className="inline-flex items-center gap-2"><TickerLogo ticker={r.ticker} size="xs" />{r.ticker}</span></td>
                    <td className="text-muted-foreground whitespace-nowrap">
                      {r.estimated ? t('legacy.taxReport.estimate') : brokerLabel(r.broker)}
                      {r.basis !== "exact" && <span title={r.basis === "gross" ? t('legacy.taxReport.grossAmountFromStatementWithholdingTaxEstimatedAt') : t('legacy.taxReport.netAmountStoredGrossAmountEstimatedAssuming15')}> *</span>}
                    </td>
                    <td className="text-right tabular-nums">{usd(r.grossUsd)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{usd(r.whtUsd)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{r.fx ? r.fx.rate.toLocaleString(currentLocale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : t('legacy.taxReport.missing2')}</td>
                    <td className="text-right tabular-nums font-bold">{czk(r.grossCzk)}</td>
                    <td className="text-right tabular-nums">{czk(r.whtCzk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground mb-6">
            {t('legacy.taxReport.theBrokerStoredOnlyOneAmountTheOther')}</p>
        </>
      )}

      {/* Open portfolio: exempt vs taxable hypothetical */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="rounded-xl border border-profit/30 bg-profit/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
            <Shield className="w-3 h-3" /> {t('legacy.taxReport.currentlyExempt3Years')}</p>
          <p className="font-display text-2xl font-bold text-profit mt-1">{format(exemptionSummary.exemptValue)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {exemptionSummary.exemptShares.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.taxReport.sharesCostBasis')}{" "}{usd(exemptionSummary.exemptCost)} · {exemptionSummary.exemptPct.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {t('legacy.taxReport.ofPortfolio')}</p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
            <Clock className="w-3 h-3" /> {t('legacy.taxReport.stillTaxable3Years')}</p>
          <p className="font-display text-2xl font-bold text-warning mt-1">{format(exemptionSummary.taxableValue)}</p>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {exemptionSummary.taxableShares.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.taxReport.sharesCostBasis')}{" "}{usd(exemptionSummary.taxableCost)} {t('legacy.taxReport.gainIfSoldToday')}{" "}{czk(exemptionSummary.taxableGainCzk)}
            <span className="block text-[10px]">{t('legacy.taxReport.valueAtTodaySExchangeRateCostBasis')}</span>
          </p>
        </div>
      </div>

      {/* Lots timeline grouped by ticker */}
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2"><Layers className="w-4 h-4" /> {t('legacy.taxReport.holdingPeriodTestForIndividualPurchasesFifoLots')}</h3>
      <div className="space-y-4 mb-6">
        {lotsByTicker.size === 0 && <p className="text-xs text-muted-foreground">{t('legacy.taxReport.noOpenPurchaseLots')}</p>}
        {Array.from(lotsByTicker.entries()).map(([ticker, tickerLots]) => {
          const totalShares = tickerLots.reduce((s, l) => s + l.shares, 0);
          const exemptShares = tickerLots.filter((l) => l.exempt).reduce((s, l) => s + l.shares, 0);
          const price = priceMap.get(ticker) ?? 0;
          const exemptValue = exemptShares * price;
          const isOpen = openTickers.has(ticker);
          return (
            <div key={ticker} className="rounded-xl border border-border/60 bg-background/30 p-4">
              <button
                type="button"
                onClick={() => toggleTicker(ticker)}
                aria-expanded={isOpen}
                className={`w-full flex items-center justify-between flex-wrap gap-2 text-left ${isOpen ? "mb-3" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`} />
                  <span className="inline-flex items-center gap-2"><TickerLogo ticker={ticker} size="sm" /><span className="font-mono font-bold text-sm">{ticker}</span></span>
                  <span className="text-xs text-muted-foreground">· {tickerLots[0].name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                    {totalShares.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.taxReport.shares')}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                    {t('legacy.taxReport.purchaseCount', { count: tickerLots.length })}
                  </span>
                  {soldInYear.has(ticker) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-semibold uppercase tracking-wider">
                      {t('legacy.taxReport.partlySoldIn')}{" "}{year}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {exemptShares > 0 ? (
                    <>{t('legacy.taxReport.exempt')}{" "}<span className="font-bold text-profit tabular-nums">{exemptShares.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('legacy.taxReport.shares')}</span> ({format(exemptValue)})</>
                  ) : (
                    <>{t('legacy.taxReport.noLotIsExemptYet')}</>
                  )}
                </div>
              </button>
              {isOpen && (
              <div className="space-y-2">
                {tickerLots.map((l, i) => {
                  const lotValue = l.shares * (price || l.priceUsd);
                  const cost = lotCost(l);
                  const lotPnl = lotValue - cost;
                  return (
                  <div key={`${l.buyTxId}-${i}`} className="rounded-lg border border-border/40 bg-background/40 p-2.5">
                    <div className="flex items-center justify-between mb-1.5 text-xs flex-wrap gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-muted-foreground">#{i + 1}</span>
                        <span className="tabular-nums">
                          <span className="font-bold">{l.shares.toLocaleString(currentLocale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span> {t('legacy.taxReport.shares2')}{(l.priceUsd + l.feePerShareUsd).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Calendar className="w-2.5 h-2.5" /> {fmtDate(l.acquiredDate)} · {brokerLabel(l.broker)}
                          {l.adjustedBy && <span title={l.adjustedBy === "split" ? t('legacy.taxReport.adjustedForASplitPurchaseDatePreserved') : t('legacy.taxReport.transferredThroughAMergerCostBasisAndPurchase')}>({l.adjustedBy === "split" ? t('legacy.taxReport.split') : t('legacy.taxReport.merger')})</span>}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {l.exempt ? (
                          <span className="px-2 py-0.5 rounded-full bg-profit/15 text-profit text-[10px] font-bold uppercase flex items-center gap-1">
                            <Shield className="w-3 h-3" /> {t('legacy.taxReport.exempt2')}</span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            {t('legacy.taxReport.remaining')}{" "}<span className="font-bold text-foreground">{formatDuration(l.remainingDays)}</span>
                            <span className="text-muted-foreground"> {t('legacy.taxReport.exemptFrom')}{" "}{fmtDate(l.exemptFrom)}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between mb-1.5 text-[11px] flex-wrap gap-1">
                      <span className="text-muted-foreground">
                        {t('legacy.taxReport.currentValue')}{" "}<span className={`font-bold tabular-nums ${l.exempt ? "text-profit" : "text-foreground"}`}>{format(lotValue)}</span>
                        <span className="text-muted-foreground"> {t('legacy.taxReport.costBasis')}{" "}{usd(cost)}</span>
                      </span>
                      <span className={`tabular-nums font-bold ${lotPnl >= 0 ? "text-profit" : "text-loss"}`}>
                        {lotPnl >= 0 ? "+" : ""}{usd(lotPnl)}
                        {l.exempt && lotPnl > 0 && <span className="ml-1 text-[10px] font-normal text-profit/80">{t('legacy.taxReport.taxFree')}</span>}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
                      <div
                        className={`h-full transition-all ${l.exempt ? "bg-profit" : "bg-gradient-to-r from-warning to-primary"}`}
                        style={{ width: `${l.progress}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] text-muted-foreground tabular-nums">
                      <span>{t('legacy.taxReport.heldFor')}{" "}{formatDuration(l.days)}</span>
                      <span>{l.progress.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %</span>
                    </div>
                  </div>
                  );
                })}
              </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Realized rows: one per matched lot */}
      {sales.rows.length > 0 && (
        <>
          <h3 className="text-sm font-bold mb-3">{t('legacy.taxReport.realizedSales')}{" "}{year} {t('legacy.taxReport.byLot')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/60">
                  <th className="py-2">{t('legacy.taxReport.sale')}</th><th>{t('legacy.taxReport.ticker')}</th><th className="text-right">{t('legacy.taxReport.quantity')}</th>
                  <th className="text-right">{t('legacy.taxReport.acquired')}</th><th className="text-right">{t('legacy.taxReport.proceeds')}</th><th className="text-right">{t('legacy.taxReport.costBasis2')}</th>
                  <th className="text-right">{t('legacy.taxReport.gain')}</th><th className="text-right">{t('legacy.taxReport.exchangeRatePurchaseSale')}</th><th className="text-right">{t('legacy.taxReport.status')}</th>
                </tr>
              </thead>
              <tbody>
                {sales.rows.map((r, i) => (
                  <tr key={`${r.sellTxId}-${r.buyTxId}-${i}`} className="border-b border-border/30">
                    <td className="py-1.5 whitespace-nowrap">{fmtDate(r.soldDate)}</td>
                    <td className="whitespace-nowrap"><span className="inline-flex items-center gap-1.5 font-mono font-bold"><TickerLogo ticker={r.ticker} size="xs" />{r.ticker}</span>{r.assetKind === "crypto" && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-primary/15 text-primary font-semibold uppercase">{t('legacy.taxReport.cryptoBadge')}</span>} <span className="text-[10px] text-muted-foreground">{brokerLabel(r.broker)}</span></td>
                    <td className="text-right tabular-nums">{r.kind === "merger-cash" ? t('legacy.taxReport.cashConsideration') : r.shares.toLocaleString(currentLocale(), { maximumFractionDigits: 6 })}</td>
                    <td className="text-right tabular-nums text-muted-foreground whitespace-nowrap" title={t('legacy.taxReport.heldFor2', { v0: formatDuration(r.heldDays) })}>{fmtDate(r.acquiredDate)}</td>
                    <td className="text-right tabular-nums">{czk(r.proceedsCzk)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{czk(r.costCzk == null || r.sellFeeCzk == null ? null : r.costCzk + r.sellFeeCzk)}</td>
                    <td className={`text-right tabular-nums font-bold ${(r.gainCzk ?? r.gainUsd) >= 0 ? "text-profit" : "text-loss"}`}>
                      {czk(r.gainCzk)}
                      <span className="block text-[10px] font-normal text-muted-foreground">{usd(r.gainUsd)}</span>
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground whitespace-nowrap">
                      {r.costUsd === 0 ? "—" : r.fxBuy ? r.fxBuy.rate.toLocaleString(currentLocale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : t('legacy.taxReport.missing2')} → {r.fxSell ? r.fxSell.rate.toLocaleString(currentLocale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : t('legacy.taxReport.missing2')}
                    </td>
                    <td className="text-right">
                      {r.exempt && r.capTaxedShare > 0 ? (
                        <span className="text-warning font-bold" title={t('legacy.taxReport.partlyCappedTitle')}>{t('legacy.taxReport.partlyCapped', { pct: pct(r.capTaxedShare) })}</span>
                      ) : r.exempt ? (
                        <span className="text-profit font-bold">{t('legacy.taxReport.exempt2')}</span>
                      ) : !r.exemptionsApply ? (
                        <span className="text-loss font-bold" title={t('legacy.taxReport.cryptoBeforeExemption')}>{t('legacy.taxReport.taxable')} *</span>
                      ) : (
                        <span className="text-loss font-bold" title={t('legacy.taxReport.wouldBeExemptFrom', { date: fmtDate(r.exemptFrom) })}>{t('legacy.taxReport.taxable')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="text-[10px] text-muted-foreground mt-4">
        {t('legacy.taxReport.indicativeCalculationNotTaxAdviceCostBasisIncludes')}{" "}{fmtDate(CNB_DATA_TO)}.
        {t('legacy.taxReport.theCzk100000LimitIncludesAllSale')}
        {t('legacy.taxReport.capRule')}
      </p>
    </div>
  );
};

export default TaxReport;
