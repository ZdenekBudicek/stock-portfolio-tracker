// Open FIFO lots seen through the Czech time test (§ 4 odst. 1 písm. w ZDP): which are
// already exempt, when the rest become exempt, and what they are worth today. Shared by the
// Daně, Pozice and stock-detail screens so the same lot never shows two different dates.
//
// Values are at today's price — a picture of now, not a forecast of the value on the day a
// lot becomes exempt. Dust filtering is a presentation choice of the caller; these totals
// always include every lot.
import type { OpenLot } from "@/lib/fifo";
import { daysBetween, pragueDate, timeTestExemptFrom } from "@/lib/czTax";

export interface LotStatus {
  key: string;
  ticker: string;
  broker: string;
  account: string;
  shares: number;
  /** Cost incl. the buy fee, USD. */
  costUsd: number;
  acquiredDate: string;
  exemptFrom: string;
  exempt: boolean;
  heldDays: number;
  remainingDays: number;
  /** 0–100: share of the 3-year holding period already behind the lot. */
  progress: number;
  /** null when the ticker has no price. */
  valueUsd: number | null;
  gainUsd: number | null;
  /** Value at today's rate minus the cost at the purchase-day rate; null when a rate is missing. */
  gainCzk: number | null;
}

export function lotStatuses(
  openLots: OpenLot[],
  priceOf: (ticker: string) => number | null | undefined,
  today: string,
  czk?: { rate: number; fxAt: (date: string) => number | null },
): LotStatus[] {
  return openLots.map((l) => {
    const acquiredDate = pragueDate(l.acquiredAt);
    const exemptFrom = timeTestExemptFrom(acquiredDate);
    const heldDays = Math.max(0, daysBetween(acquiredDate, today));
    const span = daysBetween(acquiredDate, exemptFrom);
    const costUsd = l.shares * (l.priceUsd + l.feePerShareUsd);
    const price = priceOf(l.ticker);
    const valueUsd = price != null && Number.isFinite(price) ? l.shares * price : null;
    return {
      key: l.key, ticker: l.ticker, broker: l.broker, account: l.account,
      shares: l.shares, costUsd, acquiredDate, exemptFrom,
      exempt: today >= exemptFrom,
      heldDays,
      remainingDays: Math.max(0, daysBetween(today, exemptFrom)),
      progress: span > 0 ? Math.min(100, (heldDays / span) * 100) : 100,
      valueUsd,
      gainUsd: valueUsd != null ? valueUsd - costUsd : null,
      gainCzk: (() => {
        if (valueUsd == null || !czk) return null;
        const fx = costUsd === 0 ? 0 : czk.fxAt(acquiredDate);
        return fx == null ? null : valueUsd * czk.rate - costUsd * fx;
      })(),
    };
  });
}

export interface ExemptionMonth {
  /** YYYY-MM of the first tax-free day. */
  month: string;
  /** Earliest exact first tax-free day in the month. */
  firstDate: string;
  tickers: string[];
  lots: LotStatus[];
  shares: number;
  valueUsd: number | null;
  gainUsd: number | null;
  gainCzk: number | null;
}

/** Lots not yet exempt, grouped by the month they become exempt, soonest first. */
export function exemptionCalendar(lots: LotStatus[]): ExemptionMonth[] {
  const byMonth = new Map<string, LotStatus[]>();
  for (const l of lots) {
    if (l.exempt) continue;
    const m = l.exemptFrom.slice(0, 7);
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(l);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, ls]) => {
      const sorted = [...ls].sort((a, b) => a.exemptFrom.localeCompare(b.exemptFrom) || a.ticker.localeCompare(b.ticker));
      const sum = (f: (l: LotStatus) => number | null) => sorted.reduce<number | null>((s, l) => (s == null || f(l) == null ? null : s + f(l)!), 0);
      return {
        month,
        firstDate: sorted[0].exemptFrom,
        tickers: [...new Set(sorted.map((l) => l.ticker))],
        lots: sorted,
        shares: sorted.reduce((s, l) => s + l.shares, 0),
        valueUsd: sum((l) => l.valueUsd),
        gainUsd: sum((l) => l.gainUsd),
        gainCzk: sum((l) => l.gainCzk),
      };
    });
}

export interface ExemptSummary {
  exemptLots: number;
  exemptValueUsd: number;
  exemptGainUsd: number;
  /** null as soon as one exempt lot has no CZK gain. */
  exemptGainCzk: number | null;
  /** Exempt share of each ticker's open lots, 0–1. */
  exemptShareByTicker: Map<string, number>;
  /** Tickers that have exempt lots. */
  exemptTickers: string[];
  /** Soonest first tax-free day among lots not yet exempt (null when none are left). */
  nextExemptFrom: string | null;
}

export function exemptSummary(lots: LotStatus[]): ExemptSummary {
  let exemptLots = 0, exemptValueUsd = 0, exemptGainUsd = 0;
  let exemptGainCzk: number | null = 0;
  let next: string | null = null;
  const held = new Map<string, number>(), free = new Map<string, number>();
  for (const l of lots) {
    held.set(l.ticker, (held.get(l.ticker) ?? 0) + l.shares);
    if (l.exempt) {
      exemptLots++;
      exemptValueUsd += l.valueUsd ?? 0;
      exemptGainUsd += l.gainUsd ?? 0;
      exemptGainCzk = exemptGainCzk == null || l.gainCzk == null ? null : exemptGainCzk + l.gainCzk;
      free.set(l.ticker, (free.get(l.ticker) ?? 0) + l.shares);
    } else if (next == null || l.exemptFrom < next) next = l.exemptFrom;
  }
  const exemptShareByTicker = new Map<string, number>();
  for (const [t, h] of held) exemptShareByTicker.set(t, h > 0 ? (free.get(t) ?? 0) / h : 0);
  return { exemptLots, exemptValueUsd, exemptGainUsd, exemptGainCzk, exemptShareByTicker, exemptTickers: [...free.keys()].sort(), nextExemptFrom: next };
}

/** Soonest first tax-free day of one ticker's remaining taxable lots. */
export function nextExemptionOf(lots: LotStatus[], ticker: string): string | null {
  let next: string | null = null;
  for (const l of lots) if (l.ticker === ticker && !l.exempt && (next == null || l.exemptFrom < next)) next = l.exemptFrom;
  return next;
}
