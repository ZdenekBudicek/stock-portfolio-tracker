// The app's own data → the input of a country tax engine (src/lib/tax/engines.ts).
// Pure: no IO, no clock (today comes in), so the mapping is tested on its own.
//
// - Trades: every real trade (no synthetic reconciliation rows), in the full ledger — the US
//   wash-sale and UK pooling rules need purchases outside the year too. The tax trade date is
//   the calendar day of the trade in the country's own time zone.
// - Instruments: stock / ETF / crypto as the user's data types them (the caller resolves it);
//   the asset id is the canonical ticker, the only stable identifier the app has.
// - Dividends: only recorded payments (statement, broker API, manual) — never sync-earnings'
//   own projections — with gross and withholding as the dividend tax module splits them. No
//   foreign tax credit is claimed (creditLimit 0): which treaty applies is not in the data.
// - completeThrough = today. A year that is still open (or whose look-ahead window — US/UK 30
//   days for wash sales and bed-and-breakfasting — has not passed) is a provisional estimate.
import type { FifoTx } from "@/lib/fifo";
import { isRealTradeTx } from "@/lib/fifo";
import { dividendPayDate, dividendTaxRow, type DividendRecord } from "@/lib/dividendTax";
import { isRecorded } from "@/lib/dividendAnalytics";
import type { AssetType, TaxDividend, TaxInput, TaxInstrument, TaxTrade } from "./types";
import type { Country, TaxProfile } from "./profile";

export const COUNTRY_TZ: Record<Country, string> = {
  US: "America/New_York", SK: "Europe/Bratislava", DE: "Europe/Berlin", GB: "Europe/London", PL: "Europe/Warsaw",
};

/** Calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Stock splits are tax-neutral everywhere this app supports: the cost spreads over more shares
 * and the holding period carries over. Revolut books a split as extra shares at $0 (":split:");
 * here every earlier trade of that ticker in that account is restated in post-split shares
 * (shares × ratio, price ÷ ratio — same money) and the split row is dropped, so the engines see
 * one consistent ledger. Mergers stay as they are (the engines flag them).
 */
export function normalizeSplits<T extends FifoTx>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.executed_at.localeCompare(b.executed_at));
  const out: T[] = [];
  const isSplit = (t: FifoTx) => /:split:/.test(t.ext_id ?? "") && t.side === "BUY" && !(Number(t.price_usd) > 0);
  const group = (t: FifoTx) => `${t.ticker}|${t.broker ?? ""}|${t.broker_account ?? ""}`;
  for (const t of sorted) {
    if (!isSplit(t)) { out.push({ ...t }); continue; }
    const g = group(t);
    const held = out.filter((x) => group(x) === g).reduce((a, x) => a + (x.side === "BUY" ? x.shares : -x.shares), 0);
    if (!(held > 1e-9)) { out.push({ ...t }); continue; } // nothing to split: leave it for the engine to flag
    const ratio = (held + Number(t.shares)) / held;
    for (const x of out) if (group(x) === g) { x.shares = x.shares * ratio; x.price_usd = x.price_usd / ratio; }
  }
  return out;
}

/**
 * A hand-entered sale carries no broker account, so per-account matching never finds its
 * purchases: the shares were bought at a real broker and the sale was logged by hand. Same rule
 * as the Czech FIFO (src/lib/fifo.ts): it takes the oldest open lots of that ticker in any
 * account — the sale is split into one row per account it draws from (ids `id#1`, `id#2` …).
 */
export function attributeManualSells<T extends FifoTx>(rows: T[]): T[] {
  const isManual = (t: FifoTx) => !t.broker_account && String(t.broker ?? 'manual').toLowerCase() === 'manual';
  const acct = (t: FifoTx) => `${t.broker ?? ''}|${t.broker_account ?? ''}`;
  const lots = new Map<string, { at: string; shares: number; acct: string; broker: string | null | undefined; account: string | null | undefined }[]>();
  const queue = (ticker: string) => lots.get(ticker) ?? lots.set(ticker, []).get(ticker)!;
  const out: T[] = [];
  for (const t of [...rows].sort((a, b) => a.executed_at.localeCompare(b.executed_at))) {
    const q = queue(t.ticker);
    if (t.side === 'BUY') { q.push({ at: t.executed_at, shares: t.shares, acct: acct(t), broker: t.broker, account: t.broker_account }); out.push(t); continue; }
    if (!isManual(t)) {
      let left = t.shares;
      for (const l of q) if (l.acct === acct(t) && left > 1e-9) { const n = Math.min(l.shares, left); l.shares -= n; left -= n; }
      out.push(t); continue;
    }
    // Own (manual) lots first, then the oldest lots elsewhere.
    let left = t.shares, part = 0;
    const order = [...q].filter((l) => l.shares > 1e-9).sort((a, b) => Number(b.acct === acct(t)) - Number(a.acct === acct(t)) || a.at.localeCompare(b.at));
    for (const l of order) {
      if (left <= 1e-9) break;
      const n = Math.min(l.shares, left);
      l.shares -= n; left -= n; part++;
      out.push({ ...t, id: `${t.id}#${part}`, shares: n, broker: l.broker, broker_account: l.account, fee_usd: (Number(t.fee_usd) || 0) * (n / t.shares) });
    }
    if (left > 1e-9) out.push({ ...t, id: part ? `${t.id}#${part + 1}` : t.id, shares: left, fee_usd: (Number(t.fee_usd) || 0) * (left / t.shares) }); // still unmatched: the engine says so
  }
  return out;
}

/**
 * Mergers as the Czech FIFO treats them (src/lib/fifo.ts), so a 2022 merger does not block every
 * later year. Revolut books one event as ":merger:" rows of the same broker/account/time:
 * - stock for stock (shares out and in): a tax-free exchange — earlier trades of the old ticker
 *   in that account continue as the new ticker (shares × ratio, price ÷ ratio, same money and
 *   dates); the event rows are dropped;
 * - shares out with no shares in: a cash buyout — the out row becomes an ordinary sale at the
 *   ":mergercash:" amount paid for it (0 when none was recorded, as in the Czech report).
 * A stock-plus-cash event keeps its markers and the engine flags it (rare, needs manual basis).
 */
export function normalizeMergers<T extends FifoTx>(rows: T[]): T[] {
  const isMerger = (t: FifoTx) => /:merger:/.test(t.ext_id ?? "") && !(Number(t.price_usd) > 0);
  const isCash = (t: FifoTx) => /:mergercash:/.test(t.ext_id ?? "");
  const key = (t: FifoTx) => `${t.broker ?? ""}|${t.broker_account ?? ""}|${Date.parse(t.executed_at)}`;
  const events = new Map<string, T[]>();
  for (const t of rows) if (isMerger(t)) (events.get(key(t)) ?? events.set(key(t), []).get(key(t))!).push(t);
  const cashRows = rows.filter(isCash);
  const drop = new Set<string>();
  let out = rows.map((t) => ({ ...t }));
  for (const members of events.values()) {
    const outs = members.filter((t) => t.side === "SELL");
    const ins = members.filter((t) => t.side === "BUY");
    const cash = (o: T) => cashRows.filter((c) => c.ticker === o.ticker && (c.broker_account ?? "") === (o.broker_account ?? "")
      && Math.abs(Date.parse(c.executed_at) - Date.parse(o.executed_at)) <= 31 * 86_400_000);
    const [o0, i0] = [outs[0], ins[0]];
    const sameAcct = (t: FifoTx, x: FifoTx) => (t.broker ?? "") === (x.broker ?? "") && (t.broker_account ?? "") === (x.broker_account ?? "");
    // Renaming the old lots is only safe when the account never traded the new ticker before:
    // otherwise an earlier sale of the new ticker would consume the renamed old lots.
    const newTradedBefore = !!o0 && !!i0 && rows.some((t) => t.ticker === i0.ticker && sameAcct(t, i0) && t.executed_at < i0.executed_at && t.id !== i0.id);
    if (outs.length === 1 && ins.length === 1 && cash(outs[0]).length === 0 && !newTradedBefore) {
      const [o, i] = [outs[0], ins[0]];
      const ratio = o.shares > 1e-12 ? i.shares / o.shares : 0;
      if (!(ratio > 0)) continue;
      out = out.map((t) => (t.ticker === o.ticker && (t.broker ?? "") === (o.broker ?? "") && (t.broker_account ?? "") === (o.broker_account ?? "")
        && t.executed_at < o.executed_at && !drop.has(t.id))
        ? { ...t, ticker: i.ticker, shares: t.shares * ratio, price_usd: t.price_usd / ratio } : t);
      drop.add(o.id); drop.add(i.id);
    } else if (ins.length === 0) {
      // A buyout becomes a sale only at the cash actually recorded for it; without that the row
      // keeps its marker (the engine flags it in its own year — never a made-up $0 sale).
      for (const o of outs) {
        const rec = cash(o);
        if (rec.length === 0) continue;
        // Same reading as the shared FIFO (fifo.ts cashAmount): the row is a 0-share SELL with the
        // payout in price_usd, so shares × price would be 0 (a full-cost loss instead of the gain).
        const paid = rec.reduce((a, c) => a + Math.abs(Number(c.price_usd) || 0) * (Number(c.shares) > 0 ? Number(c.shares) : 1), 0);
        for (const c of rec) drop.add(c.id);
        out = out.map((t) => (t.id === o.id ? { ...t, ext_id: null, price_usd: o.shares > 0 ? paid / o.shares : 0 } : t));
      }
    }
  }
  return out.filter((t) => !drop.has(t.id));
}

/**
 * US qualified-dividend holding test from the user's own trades: the shares paid on were held
 * more than 60 days within the 121-day window that starts 60 days before the ex-dividend date
 * (days need not be consecutive). Counted per ticker across accounts: a day counts when at least
 * the shares held on the ex-date were held that day.
 */
export function heldForQualification(transactions: FifoTx[], ticker: string, exDate: string): boolean {
  const D = 86_400_000;
  const ex = Date.parse(`${exDate}T00:00:00Z`);
  if (!Number.isFinite(ex)) return false;
  const rows = transactions.filter((t) => t.ticker === ticker);
  const heldAt = (ms: number) => rows.filter((t) => Date.parse(t.executed_at) < ms).reduce((a, t) => a + (t.side === 'BUY' ? t.shares : -t.shares), 0);
  const atEx = heldAt(ex);
  if (!(atEx > 1e-9)) return false;
  let days = 0;
  for (let d = -60; d <= 60; d++) if (heldAt(ex + d * D + D) >= atEx - 1e-9) days++; // held at the end of that day
  return days > 60;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface AppTaxData {
  profile: TaxProfile;
  transactions: (FifoTx & { id: string })[];
  dividends: (DividendRecord & { id?: string; ext_id?: string | null })[];
  /** stock / etf / crypto for a ticker, from the user's own data. */
  kindOf: (ticker: string) => AssetType;
  /** Canonical symbol for a ticker (aliases); defaults to the ticker itself. */
  canonical?: (ticker: string) => string;
  today: string;
}

export function buildTaxInput({ profile, transactions, dividends, kindOf, canonical = (t) => t.toUpperCase(), today }: AppTaxData): TaxInput {
  const country = profile.residence;
  const tz = COUNTRY_TZ[country];
  const trades: TaxTrade[] = attributeManualSells(normalizeMergers(normalizeSplits(transactions.filter(isRealTradeTx))))
    .map((t) => ({ ...t, taxDate: localDate(t.executed_at, tz) }) as TaxTrade)
    .filter((t) => t.taxDate <= today)
    .sort((a, b) => a.executed_at.localeCompare(b.executed_at));
  const tickers = new Set<string>([...trades.map((t) => t.ticker)]);
  const divs: TaxDividend[] = [];
  for (const [i, d] of dividends.entries()) {
    if (d.status !== "paid" || !isRecorded(d as never)) continue;
    const day = dividendPayDate(d);
    if (!day || day > today) continue;
    // Amounts as recorded — never the Czech 15 % gross-up for a row that only has the net
    // amount: then the received amount is used as gross and no withholding is assumed (true for
    // US issuers paid to a US resident; elsewhere it only understates the credit).
    const row = dividendTaxRow(d, "cnb-daily");
    const exact = row.basis === "exact";
    const grossUsd = exact ? row.grossUsd : row.basis === "gross" ? row.grossUsd : row.netUsd;
    const withholdingUsd = exact ? Math.max(0, row.grossUsd - row.netUsd) : 0;
    if (!(grossUsd > 0)) continue;
    const kind = kindOf(d.ticker);
    if (kind === "crypto") continue;
    tickers.add(d.ticker);
    divs.push({
      id: String(d.id ?? `div-${i}-${d.ticker}-${day}`), ticker: d.ticker, taxDate: day,
      grossUsd, withholdingUsd,
      // US: the credit can be at most what was actually withheld, and only when a credit is claimed.
      creditLimit: country === "US" && (profile as { foreignTaxCreditLimit?: number }).foreignTaxCreditLimit > 0 ? withholdingUsd : 0,
      // US: qualified when the holding-period test (more than 60 days in the 121 days around the
      // ex-date) is met from the user's own lots; fund distributions conservatively ordinary.
      qualified: kind === "stock" && heldForQualification(transactions, d.ticker, d.ex_date ?? day),
      // SK: the profit year is not in the data; dividends are normally paid out of the previous
      // year's profit, which is what is assumed here (shown as a note on the page).
      profitYear: Number(day.slice(0, 4)) - 1, skCategory: kind === "etf" ? "fund" : "corporate",
    });
  }
  const instruments: Record<string, TaxInstrument> = {};
  for (const t of tickers) {
    const kind = kindOf(t);
    // SK: securities listed on an exchange; the listing date is not in the data, so it is taken
    // as before any purchase (stated on the page). Crypto has no market status.
    instruments[t] = { kind, assetId: canonical(t), ...(country === "SK" && kind !== "crypto" ? { regulatedMarketSince: "1900-01-01" } : {}) };
  }
  // The look-ahead window after year end must be covered by the ledger before a year is final.
  const lookahead = country === "US" || country === "GB" ? 30 : 0;
  const yearEnd = country === "GB" ? `${profile.year + 1}-04-05` : `${profile.year}-12-31`;
  return {
    profile, trades, instruments, dividends: divs, completeThrough: today,
    provisional: today < addDays(yearEnd, lookahead),
  };
}
