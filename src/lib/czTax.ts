// Czech personal income tax on sales of securities and crypto-assets (§ 10 ZDP) and the
// exemptions that apply to them, computed from the shared FIFO disposals (src/lib/fifo.ts).
//
// Securities (shares, ETFs), § 4 odst. 1 ZDP:
//  - Time test: a lot held MORE than 3 years is exempt. Judged per lot — one sale can be
//    part exempt, part taxable. Calendar years in Europe/Prague: bought 15. 3. 2020 → exempt
//    from 16. 3. 2023; bought 29. 2. 2020 → the 3 years end 28. 2. 2023 (§ 605 OZ: no 29th →
//    last day of the month), exempt from 1. 3. 2023.
//  - 100 000 Kč limit: when the year's gross proceeds from selling securities do not exceed
//    100 000 Kč, the sale income is exempt. Whether time-test-exempt proceeds count towards
//    the limit is a setting (default: they do — the stricter reading).
//
// Crypto-assets (zákon č. 32/2025 Sb., in force from 15. 2. 2025, no transitional provisions):
//  - A sale before 15. 2. 2025 has no exemption at all — fully taxable § 10 income.
//  - From 15. 2. 2025 crypto has its OWN 100 000 Kč limit (§ 4 odst. 1 písm. zj; in 2025 only
//    sales from that day count — KDP koordinační výbor 625/30.04.25, GFŘ agreed) and its own
//    3-year time test (písm. zk; the holding period before 15. 2. 2025 counts).
//
// 40 000 000 Kč cap (§ 4 odst. 3): when the time-test-exempt proceeds of a tax year exceed
// 40 mil. Kč, each of them is not exempt in the share (total − 40 mil.) / total.
//  - 2025: one combined cap over securities and crypto (zákony č. 349/2023 Sb. and 32/2025 Sb.).
//  - 2026+: crypto only — zákon č. 360/2025 Sb. took securities out of the cap.
//  - before 2025: no cap.
// The taxed share of a lot takes the same share of its expenses. (§ 10 odst. 9 lets a
// security bought before 2025 use its value at 31. 12. 2024 as the expense for that part;
// not modelled — the purchase cost is used, which can only overstate the tax.)
//
// Securities and crypto are separate partial bases, each floored at zero: a loss on one
// kind is not set off against a gain on the other (the conservative reading).
//
// CZK: cost at the rate of the purchase date, proceeds and the sell fee at the rate of the
// sale date (or the GFŘ unified rate of the respective year). A missing rate leaves the
// amount empty and marks the report incomplete — never today's rate instead.
import type { Disposal, FifoWarning } from "@/lib/fifo";
import { usdCzkFor, type FxMethod, type FxRate } from "@/lib/cnbRates";
import { isCryptoTicker } from "../../supabase/functions/_shared/crypto.js";

export const SALE_INCOME_LIMIT_CZK = 100_000;
export const TAX_RATE = 0.15;
/** § 4 odst. 3 ZDP: cap on time-test-exempt proceeds per tax year (from 2025). */
export const TIME_TEST_CAP_CZK = 40_000_000;
/** zákon č. 32/2025 Sb. took effect: crypto exemptions apply to sales from this day. */
export const CRYPTO_EXEMPTION_FROM = "2025-02-15";

export type AssetKind = "security" | "crypto";
export const ASSET_KINDS: readonly AssetKind[] = ["security", "crypto"];

/** What the app knows about an instrument, from every source — held or long sold. */
export interface InstrumentInfo {
  /** positions.type ("Stock" is the DB default for every manual trade and sync, crypto included). */
  positionType?: string | null;
  /** ticker_alias: canonical ticker and the pinned Yahoo symbol, if any. */
  aliasCanonical?: string | null;
  yahooSymbol?: string | null;
  /** ticker_profiles.asset_type: EQUITY / ETF / CRYPTO. */
  profileType?: string | null;
}

export interface AssetKindResolution {
  kind: AssetKind;
  /** Which source decided. "default" = nothing known, treated as a security. */
  source: "type" | "alias" | "profile" | "list" | "default";
  /** Nothing identifies the instrument: the report flags it instead of trusting the default. */
  unresolved: boolean;
}

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();
const YAHOO_CRYPTO_PAIR = /^[A-Z0-9]+-USD$/i;

/**
 * Crypto or security, for the tax rules. The explicit instrument data wins over the ticker:
 *  1. positions.type "Crypto" → crypto; any explicit non-stock type (ETF, Fund, Bond, …) →
 *     security. "Stock" alone decides nothing — it is the default every write path stores,
 *     coins included (see isCryptoHolding).
 *  2. ticker_alias: a pinned Yahoo coin pair (XXX-USD) or a crypto canonical → crypto; any
 *     other pinned Yahoo symbol → security (how a real LTC/ATOM stock is pinned for prices).
 *  3. ticker_profiles.asset_type: ETF / CRYPTO; EQUITY only for a ticker that is not a coin
 *     name (the sector sync stamps coin names CRYPTO by the key set, so it cannot settle them).
 *  4. The crypto key set (CRYPTO_TICKERS) as the fallback.
 *  5. Otherwise a security when "Stock" or EQUITY was stored, else unresolved.
 */
export function resolveAssetKind(ticker: string, info: InstrumentInfo = {}): AssetKindResolution {
  const type = norm(info.positionType);
  if (type.includes("crypto")) return { kind: "crypto", source: "type", unresolved: false };
  if (type && type !== "stock" && type !== "cash") return { kind: "security", source: "type", unresolved: false };
  const yahoo = String(info.yahooSymbol ?? "").trim();
  if (yahoo) return { kind: YAHOO_CRYPTO_PAIR.test(yahoo) ? "crypto" : "security", source: "alias", unresolved: false };
  if (info.aliasCanonical && info.aliasCanonical.toUpperCase() !== ticker.toUpperCase() && isCryptoTicker(info.aliasCanonical))
    return { kind: "crypto", source: "alias", unresolved: false };
  const profile = norm(info.profileType);
  if (profile === "etf") return { kind: "security", source: "profile", unresolved: false };
  if (profile === "crypto") return { kind: "crypto", source: "profile", unresolved: false };
  if (isCryptoTicker(ticker)) return { kind: "crypto", source: "list", unresolved: false };
  if (profile === "equity") return { kind: "security", source: "profile", unresolved: false };
  if (type === "stock") return { kind: "security", source: "type", unresolved: false };
  return { kind: "security", source: "default", unresolved: true };
}

/** Kind alone, for callers without registry data (tests, one-off checks). */
export function assetKindOf(ticker: string, type?: string | null): AssetKind {
  return resolveAssetKind(ticker, { positionType: type }).kind;
}

/** Whether the § 4 exemptions (the 100 000 Kč limit and the time test) exist for this sale. */
export function exemptionsApply(kind: AssetKind, soldDate: string): boolean {
  return kind === "security" || soldDate >= CRYPTO_EXEMPTION_FROM;
}

/** Kinds whose time-test-exempt proceeds fall under the 40 mil. Kč cap in a tax year. */
export function cappedKinds(year: number): AssetKind[] {
  if (year < 2025) return [];
  if (year === 2025) return ["security", "crypto"];
  return ["crypto"];
}

export interface TaxSettings {
  fxMethod: FxMethod;
  /**
   * @deprecated Ignored (audit B11): the 100 000 Kč value test counts every sale of securities, time-test-exempt
   * ones included (§ 4 odst. 1 písm. w) ZDP). Kept so stored preferences and the assistant protocol stay readable.
   */
  limitIncludesExempt: boolean;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = { fxMethod: "cnb-daily", limitIncludesExempt: true };

const pragueFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" });

/** Calendar date (YYYY-MM-DD) of an instant in Europe/Prague. */
export function pragueDate(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return pragueFmt.format(new Date(iso));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** date + n years; a day that does not exist in the target month becomes its last day. */
export function addYearsClamped(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const ty = y + years;
  const last = new Date(Date.UTC(ty, m, 0)).getUTCDate();
  return `${ty}-${pad(m)}-${pad(Math.min(d, last))}`;
}

export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** First day on which a lot acquired on `acquired` (Prague date) may be sold tax-free. */
export function timeTestExemptFrom(acquired: string): string {
  return addDays(addYearsClamped(acquired, 3), 1);
}

/** The holding period exceeds 3 years: sale date > acquisition date + 3 years. */
export function isTimeTestExempt(acquired: string, sold: string): boolean {
  return sold >= timeTestExemptFrom(acquired);
}


export interface TaxedDisposal extends Disposal {
  assetKind: AssetKind;
  /** No instrument data identified the kind (treated as a security, report incomplete). */
  kindUnresolved: boolean;
  acquiredDate: string;
  soldDate: string;
  heldDays: number;
  /** The lot passed the 3-year test (whether or not an exemption existed for it). */
  timeTestMet: boolean;
  /** An exemption regime existed for this sale (false: crypto sold before 15. 2. 2025). */
  exemptionsApply: boolean;
  /** Exempt by the time test (before the 40 mil. Kč cap). */
  exempt: boolean;
  exemptFrom: string;
  /** Share (0–1) of an exempt row that is taxed anyway because of the 40 mil. Kč cap. */
  capTaxedShare: number;
  fxBuy: FxRate | null;
  fxSell: FxRate | null;
  /** null when a rate is missing. */
  proceedsCzk: number | null;
  costCzk: number | null;
  sellFeeCzk: number | null;
  gainCzk: number | null;
}

export function taxDisposal(d: Disposal, fxMethod: FxMethod, resolution: AssetKindResolution = resolveAssetKind(d.ticker, { positionType: "Stock" })): TaxedDisposal {
  const kind = resolution.kind;
  const acquiredDate = pragueDate(d.acquiredAt);
  const soldDate = pragueDate(d.soldAt);
  const fxBuy = usdCzkFor(acquiredDate, fxMethod);
  const fxSell = usdCzkFor(soldDate, fxMethod);
  const proceedsCzk = fxSell ? d.proceedsUsd * fxSell.rate : null;
  const sellFeeCzk = fxSell ? d.sellFeeUsd * fxSell.rate : null;
  // A disposal without cost (merger cash) needs no purchase-date rate.
  const costCzk = d.costUsd === 0 ? 0 : fxBuy ? d.costUsd * fxBuy.rate : null;
  const gainCzk = proceedsCzk != null && sellFeeCzk != null && costCzk != null ? proceedsCzk - sellFeeCzk - costCzk : null;
  const timeTestMet = isTimeTestExempt(acquiredDate, soldDate);
  const applies = exemptionsApply(kind, soldDate);
  return {
    ...d, assetKind: kind, kindUnresolved: resolution.unresolved, acquiredDate, soldDate, heldDays: daysBetween(acquiredDate, soldDate),
    timeTestMet, exemptionsApply: applies, exempt: timeTestMet && applies, exemptFrom: timeTestExemptFrom(acquiredDate),
    capTaxedShare: 0, fxBuy, fxSell, proceedsCzk, costCzk, sellFeeCzk, gainCzk,
  };
}

/** A sell the ledger has no buy for (FIFO warning): its proceeds still count. */
export interface UnmatchedSale {
  ticker: string;
  kind: AssetKind;
  kindUnresolved?: boolean;
  date: string;
  /** null when the sale-day rate is missing. */
  proceedsCzk: number | null;
}

export interface SalesTotals { proceedsCzk: number; expensesCzk: number; gainCzk: number; gainUsd: number }

export interface KindReport {
  kind: AssetKind;
  rowCount: number;
  /** Gross proceeds of all sales of this kind in the year (incl. unmatched sells). */
  proceedsCzk: number;
  /** Proceeds of time-test-exempt lots (before the cap). */
  proceedsExemptLotsCzk: number;
  /** Proceeds counted against this kind's 100 000 Kč limit (depends on the setting). */
  limitBaseCzk: number;
  /** Proceeds of sells the ledger has no buy for — counted against the limit. */
  unmatchedProceedsCzk: number;
  /** The kind has a 100 000 Kč limit this year (crypto: only for sales from 15. 2. 2025). */
  limitApplies: boolean;
  underLimit: boolean;
  complete: boolean;
  /** Lots held ≤ 3 years plus the capped part of exempt lots — § 10 income and expenses. */
  taxable: SalesTotals;
  /** Part of `taxable` from sales outside any exemption regime (crypto before 15. 2. 2025). */
  noExemption: SalesTotals;
  exempt: { gainCzk: number; gainUsd: number };
  /** Gain of exempt lots taxed because of the 40 mil. Kč cap — taxed even under the 100 000 Kč limit. */
  capTaxedGainCzk: number;
  /** Partial tax base: never negative (a loss carries no deduction). */
  taxBaseCzk: number;
  estTaxCzk: number;
}

export interface TimeTestCap {
  /** Kinds under the cap this year (empty before 2025). */
  kinds: AssetKind[];
  /** Time-test-exempt proceeds counted against the cap. */
  baseCzk: number;
  overCzk: number;
  /** (base − 40 mil.) / base; 0 under the cap. */
  taxedShare: number;
  /** Proceeds / gain moved from exempt to taxable by the cap. */
  taxedProceedsCzk: number;
  taxedGainCzk: number;
}

export interface SalesYearReport {
  year: number;
  rows: TaxedDisposal[];
  unmatched: UnmatchedSale[];
  /** Tickers whose asset kind nothing identifies (counted as securities; the report is incomplete). */
  unresolvedTickers: string[];
  /** Dates (YYYY-MM-DD) for which no exchange rate was available. */
  missingFx: string[];
  complete: boolean;
  /** Gross proceeds of all sales in the year, every kind. */
  proceedsCzk: number;
  /** Securities figures (their 100 000 Kč limit) — kept at the top level for the screens. */
  proceedsExemptLotsCzk: number;
  limitBaseCzk: number;
  underLimit: boolean;
  /** Unmatched-sell proceeds of every kind. */
  unmatchedProceedsCzk: number;
  /** Totals over every kind. */
  taxable: SalesTotals;
  exempt: { gainCzk: number; gainUsd: number };
  taxBaseCzk: number;
  estTaxCzk: number;
  securities: KindReport;
  crypto: KindReport;
  cap: TimeTestCap;
}

export type AssetKindResolver = (ticker: string) => AssetKindResolution;
/** Without registry data: the ticker list decides, like the DB default type "Stock". */
export const defaultKindOf: AssetKindResolver = (t) => resolveAssetKind(t, { positionType: "Stock" });

/**
 * Resolver over the whole instrument registry: every positions row, every ticker_alias row
 * and every ticker_profiles row — profiles and aliases outlive a sold position, so a fully
 * sold ETF keeps its kind. Independent of what is currently held or its value.
 */
export function kindResolverFrom(registry: {
  positions?: { ticker: string; type?: string | null }[];
  aliases?: { alias: string; canonical: string; yahoo_symbol?: string | null }[];
  profiles?: { ticker: string; asset_type?: string | null }[];
}): AssetKindResolver {
  const up = (t: string) => t.trim().toUpperCase();
  const types = new Map<string, string>();
  for (const p of registry.positions ?? []) if (p.type) types.set(up(p.ticker), p.type);
  const aliases = new Map<string, { canonical: string; yahoo: string | null }>();
  for (const a of registry.aliases ?? []) {
    const row = { canonical: a.canonical, yahoo: a.yahoo_symbol ?? null };
    aliases.set(up(a.alias), row);
    // A pinned symbol on an alias row speaks for its canonical ticker too.
    if (row.yahoo && !aliases.has(up(a.canonical))) aliases.set(up(a.canonical), row);
  }
  const profiles = new Map<string, string>();
  for (const p of registry.profiles ?? []) if (p.asset_type) profiles.set(up(p.ticker), p.asset_type);
  return (t) => {
    const k = up(t);
    const alias = aliases.get(k);
    const canon = alias ? up(alias.canonical) : k;
    return resolveAssetKind(t, {
      positionType: types.get(k) ?? types.get(canon) ?? null,
      aliasCanonical: alias?.canonical ?? null,
      yahooSymbol: alias?.yahoo ?? null,
      profileType: profiles.get(k) ?? profiles.get(canon) ?? null,
    });
  };
}

const zeroTotals = (): SalesTotals => ({ proceedsCzk: 0, expensesCzk: 0, gainCzk: 0, gainUsd: 0 });

/**
 * Taxed rows + unmatched sells of one year → the year's figures. Shared by the report and
 * the sale simulator, so a hypothetical sale goes through exactly the same limits and cap.
 * `forceIncomplete`: something outside these rows is unknown.
 */
export function summarizeSalesYear(
  year: number, taxedRows: TaxedDisposal[], unmatched: UnmatchedSale[], settings: TaxSettings,
  missingDates: string[] = [], forceIncomplete = false,
): SalesYearReport {
  const rows = taxedRows
    .map((r) => ({ ...r, capTaxedShare: 0 }))
    .sort((a, b) => b.soldDate.localeCompare(a.soldDate) || a.ticker.localeCompare(b.ticker) || a.acquiredDate.localeCompare(b.acquiredDate));
  const missing = new Set<string>(missingDates);
  const incompleteKinds = new Set<AssetKind>();
  for (const r of rows) {
    if (!r.fxSell) { missing.add(r.soldDate); incompleteKinds.add(r.assetKind); }
    if (!r.fxBuy && r.costUsd !== 0) { missing.add(r.acquiredDate); incompleteKinds.add(r.assetKind); }
  }
  // An unmatched sell leaves its kind incomplete: the missing purchase is unknown.
  for (const u of unmatched) incompleteKinds.add(u.kind);
  // An instrument nothing identifies is counted as a security, but not trusted: if it is a
  // coin, its rules differ (no exemption before 15. 2. 2025, its own limit).
  const unresolved = new Set<string>();
  for (const r of rows) if (r.kindUnresolved) { unresolved.add(r.ticker); incompleteKinds.add(r.assetKind); }
  for (const u of unmatched) if (u.kindUnresolved) unresolved.add(u.ticker);
  if (forceIncomplete) ASSET_KINDS.forEach((k) => incompleteKinds.add(k));

  // § 4 odst. 3: one cap per year over the time-test-exempt proceeds of the capped kinds.
  const capKinds = cappedKinds(year);
  let capBase = 0;
  for (const r of rows) if (r.exempt && capKinds.includes(r.assetKind) && r.proceedsCzk != null) capBase += r.proceedsCzk;
  const overCzk = Math.max(0, capBase - TIME_TEST_CAP_CZK);
  const taxedShare = capBase > 0 ? overCzk / capBase : 0;
  let capProceeds = 0, capGain = 0;
  if (taxedShare > 0) for (const r of rows) if (r.exempt && capKinds.includes(r.assetKind)) {
    r.capTaxedShare = taxedShare;
    capProceeds += (r.proceedsCzk ?? 0) * taxedShare;
    capGain += (r.gainCzk ?? 0) * taxedShare;
  }

  const kindReport = (kind: AssetKind): KindReport => {
    const taxable = zeroTotals(), noExemption = zeroTotals(), exempt = { gainCzk: 0, gainUsd: 0 };
    let proceedsCzk = 0, proceedsExemptLotsCzk = 0, limitBaseCzk = 0, rowCount = 0, limitApplies = kind === "security", capTaxedGainCzk = 0;
    for (const r of rows) {
      if (r.assetKind !== kind) continue;
      rowCount++;
      if (r.exemptionsApply) limitApplies = true;
      const s = r.exempt ? r.capTaxedShare : 1; // taxed share of the row
      taxable.gainUsd += r.gainUsd * s;
      exempt.gainUsd += r.gainUsd * (1 - s);
      if (!r.exemptionsApply) noExemption.gainUsd += r.gainUsd;
      if (r.proceedsCzk != null) {
        proceedsCzk += r.proceedsCzk;
        if (r.exempt) proceedsExemptLotsCzk += r.proceedsCzk;
        // The 100 000 Kč value test is separate from the 40 mil. Kč cap: every sale inside the regime
        // counts, time-test-exempt lots (capped or not) included — the two exemptions do not combine.
        if (r.exemptionsApply) limitBaseCzk += r.proceedsCzk;
      }
      if (r.gainCzk == null) continue;
      const expenses = r.costCzk! + r.sellFeeCzk!;
      taxable.proceedsCzk += r.proceedsCzk! * s;
      taxable.expensesCzk += expenses * s;
      taxable.gainCzk += r.gainCzk * s;
      exempt.gainCzk += r.gainCzk * (1 - s);
      if (r.exempt) capTaxedGainCzk += r.gainCzk * s;
      if (!r.exemptionsApply) {
        noExemption.proceedsCzk += r.proceedsCzk!;
        noExemption.expensesCzk += expenses;
        noExemption.gainCzk += r.gainCzk;
      }
    }
    // A sell the ledger has no buy for still brought in money: its proceeds count against the
    // limit (gross income from sales), and the year is not complete until the missing
    // purchase is found — otherwise one recorded share of a ten-share sale read as "under
    // the limit, no tax".
    let unmatchedProceedsCzk = 0;
    for (const u of unmatched) {
      if (u.kind !== kind || u.proceedsCzk == null) continue;
      unmatchedProceedsCzk += u.proceedsCzk;
      if (exemptionsApply(kind, u.date)) { limitApplies = true; limitBaseCzk += u.proceedsCzk; }
    }
    proceedsCzk += unmatchedProceedsCzk;
    const complete = !incompleteKinds.has(kind);
    // Without every rate the limit cannot be confirmed — so it is not applied.
    const underLimit = limitApplies && complete && limitBaseCzk <= SALE_INCOME_LIMIT_CZK;
    // Under the limit the lots it exempts drop out; sales outside the regime and the part of
    // time-test lots above the 40 mil. Kč cap stay taxable whatever the value test says.
    const taxBaseCzk = Math.max(0, underLimit ? noExemption.gainCzk + capTaxedGainCzk : taxable.gainCzk);
    return {
      kind, rowCount, proceedsCzk, proceedsExemptLotsCzk, limitBaseCzk, unmatchedProceedsCzk, limitApplies, underLimit, complete,
      taxable, noExemption, exempt, capTaxedGainCzk, taxBaseCzk, estTaxCzk: taxBaseCzk * TAX_RATE,
    };
  };

  const securities = kindReport("security"), crypto = kindReport("crypto");
  const sum = (f: (k: KindReport) => number) => f(securities) + f(crypto);
  const taxBaseCzk = sum((k) => k.taxBaseCzk);
  return {
    year, rows, unmatched, unresolvedTickers: [...unresolved].sort(), missingFx: [...missing].sort(), complete: incompleteKinds.size === 0,
    proceedsCzk: sum((k) => k.proceedsCzk),
    proceedsExemptLotsCzk: securities.proceedsExemptLotsCzk, limitBaseCzk: securities.limitBaseCzk, underLimit: securities.underLimit,
    unmatchedProceedsCzk: sum((k) => k.unmatchedProceedsCzk),
    taxable: {
      proceedsCzk: sum((k) => k.taxable.proceedsCzk), expensesCzk: sum((k) => k.taxable.expensesCzk),
      gainCzk: sum((k) => k.taxable.gainCzk), gainUsd: sum((k) => k.taxable.gainUsd),
    },
    exempt: { gainCzk: sum((k) => k.exempt.gainCzk), gainUsd: sum((k) => k.exempt.gainUsd) },
    taxBaseCzk, estTaxCzk: taxBaseCzk * TAX_RATE,
    securities, crypto,
    cap: { kinds: capKinds, baseCzk: capBase, overCzk, taxedShare, taxedProceedsCzk: capProceeds, taxedGainCzk: capGain },
  };
}

export function buildSalesReport(
  disposals: Disposal[], year: number, settings: TaxSettings = DEFAULT_TAX_SETTINGS, warnings: FifoWarning[] = [],
  kindOf: AssetKindResolver = defaultKindOf,
): SalesYearReport {
  const rows = disposals
    .map((d) => taxDisposal(d, settings.fxMethod, kindOf(d.ticker)))
    .filter((r) => Number(r.soldDate.slice(0, 4)) === year);
  const missing: string[] = [];
  const unmatched: UnmatchedSale[] = [];
  for (const w of warnings) {
    // Year and rate follow the Prague calendar date of the sale, like every other row.
    const day = pragueDate(w.date);
    if (w.kind !== "unmatched-sell" || Number(day.slice(0, 4)) !== year || !(Number(w.amountUsd) > 0)) continue;
    const fx = usdCzkFor(day, settings.fxMethod);
    if (!fx) missing.push(day);
    const res = kindOf(w.ticker);
    unmatched.push({ ticker: w.ticker, kind: res.kind, kindUnresolved: res.unresolved, date: day, proceedsCzk: fx ? Number(w.amountUsd) * fx.rate : null });
  }
  return summarizeSalesYear(year, rows, unmatched, settings, missing);
}

export type LimitState = 'over' | 'under' | 'unknown';
export const limitStateOf = (k: KindReport): LimitState =>
  k.limitBaseCzk > SALE_INCOME_LIMIT_CZK ? 'over' : k.underLimit ? 'under' : 'unknown';

/**
 * One state for the whole year, every kind: 'over' when any limit is exceeded, 'under' only
 * when every limit holds AND no tax is due, 'taxed' when tax is due under the limits (crypto
 * sold before 15. 2. 2025, the part above the 40 mil. Kč cap), 'unknown' otherwise.
 */
export type OverallTaxState = LimitState | 'taxed';
export function overallTaxState(r: SalesYearReport): OverallTaxState {
  const kinds = [r.securities, r.crypto].filter((k) => k.limitApplies);
  const states = kinds.map(limitStateOf);
  if (states.includes('over')) return 'over';
  if (states.includes('unknown') || !r.complete) return 'unknown';
  return r.taxBaseCzk > 0 ? 'taxed' : 'under';
}
