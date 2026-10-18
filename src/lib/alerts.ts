// What needs the user's attention right now, derived from the data already loaded.
//
// This is a CURRENT-STATE view: it can say "NBIS is down 12 % today" or "CRWV is below your
// target", not "the price refresh failed twice yesterday" — a history of events needs a
// server-side log that does not exist yet. Ids are stable per condition (ticker + session /
// year), so a refresh never duplicates an alert and a future read-state can key on them.
import { addDays } from "@/lib/czTax";
import type { JurisdictionCaps } from "@/lib/tax/jurisdictions";

export type AlertKind = "move" | "watch" | "tax-limit" | "earnings" | "exempt" | "data";
export type AlertTone = "loss" | "profit" | "warning" | "info";

export interface AlertItem {
  id: string;
  kind: AlertKind;
  tone: AlertTone;
  /** UI translation code, independent of the display language. */
  code: string;
  /** Raw values only; formatting belongs to the UI. */
  params: Record<string, number | string | boolean | null>;
  ticker?: string;
  href?: string;
  /** Sort weight: higher first. */
  priority: number;
}

export interface AlertInput {
  today: string;
  positions: { ticker: string; name: string; dailyChangePct: number; dailyChangeUsd: number; allocation: number; hasPrevClose: boolean }[];
  moveThresholdPct: number;
  watch: { ticker: string; target_price_usd: number | null }[];
  priceOf: (ticker: string) => number | null;
  tax: { year: number; overLimit: boolean; complete: boolean; proceedsCzk: number; estTaxCzk: number } | null;
  earnings: { ticker: string; earnings_date: string; time_of_day: string | null }[];
  earningsDaysAhead: number;
  /** Tickers held now (earnings of other tickers are not "yours"). */
  held: Set<string>;
  /** Lots that became tax-free in the last 30 days. */
  newlyExempt: { ticker: string; exemptFrom: string; valueUsd: number | null }[];
  pricesStale: boolean;
  pricesError: string | null;
  /** The user's jurisdiction: tax alerts only where its rules have the limit / the exemption. Default: Czech (all). */
  caps?: Pick<JurisdictionCaps, "annualProceedsLimit" | "holdingExemption">;
}

/** sync-earnings stores "AMC" / "BMO" (nasdaq.com "after"/"before" market). */
export const normalizeEarningsTime = (t: string | null | undefined): "amc" | "bmo" | null => {
  const v = String(t ?? "").toLowerCase();
  return v === "amc" || v === "bmo" ? v : null;
};

export function deriveAlerts(i: AlertInput): AlertItem[] {
  const out: AlertItem[] = [];

  if (i.pricesError) {
    out.push({ id: "data:prices-error", kind: "data", tone: "loss", code: "data.pricesError", params: {}, priority: 100 });
  } else if (i.pricesStale) {
    out.push({ id: "data:prices-stale", kind: "data", tone: "warning", code: "data.pricesStale", params: {}, priority: 90 });
  }

  const caps = i.caps ?? { annualProceedsLimit: true, holdingExemption: true };
  if (caps.annualProceedsLimit && i.tax?.overLimit) {
    out.push({
      id: `tax-limit:${i.tax.year}`, kind: "tax-limit", tone: "warning", href: "/dane",
      code: "tax.limitOver",
      params: { year: i.tax.year, proceedsCzk: i.tax.proceedsCzk, estTaxCzk: i.tax.estTaxCzk, complete: i.tax.complete },
      priority: 80,
    });
  }

  for (const p of i.positions) {
    if (!p.hasPrevClose || Math.abs(p.dailyChangePct) < i.moveThresholdPct) continue;
    const down = p.dailyChangePct < 0;
    out.push({
      id: `move:${p.ticker}:${i.today}`, kind: "move", tone: down ? "loss" : "profit", ticker: p.ticker, href: `/stock/${p.ticker}`,
      code: down ? "move.down" : "move.up",
      params: { pct: p.dailyChangePct, amountUsd: p.dailyChangeUsd, allocation: p.allocation },
      priority: 70 + Math.min(9, Math.abs(p.dailyChangePct) / 2),
    });
  }

  for (const w of i.watch) {
    if (w.target_price_usd == null || !(w.target_price_usd > 0)) continue;
    const price = i.priceOf(w.ticker);
    if (price == null || price > w.target_price_usd) continue;
    const below = ((w.target_price_usd - price) / w.target_price_usd) * 100;
    out.push({
      id: `watch:${w.ticker}:${w.target_price_usd}`, kind: "watch", tone: "info", ticker: w.ticker, href: "/pozice#watchlist",
      code: "watch.belowTarget",
      params: { price, target: w.target_price_usd, belowPct: below },
      priority: 60,
    });
  }

  const until = addDays(i.today, i.earningsDaysAhead);
  for (const e of i.earnings) {
    if (!i.held.has(e.ticker) || e.earnings_date < i.today || e.earnings_date > until) continue;
    out.push({
      id: `earnings:${e.ticker}:${e.earnings_date}`, kind: "earnings", tone: "info", ticker: e.ticker, href: `/stock/${e.ticker}`,
      code: "earnings.soon",
      params: { date: e.earnings_date, time: normalizeEarningsTime(e.time_of_day) },
      priority: 50,
    });
  }

  const byTicker = new Map<string, { from: string; value: number | null; n: number }>();
  for (const l of caps.holdingExemption ? i.newlyExempt : []) {
    const e = byTicker.get(l.ticker);
    if (e) { e.n++; e.value = e.value == null || l.valueUsd == null ? null : e.value + l.valueUsd; if (l.exemptFrom > e.from) e.from = l.exemptFrom; }
    else byTicker.set(l.ticker, { from: l.exemptFrom, value: l.valueUsd, n: 1 });
  }
  for (const [ticker, e] of byTicker) {
    out.push({
      id: `exempt:${ticker}:${e.from}`, kind: "exempt", tone: "profit", ticker, href: "/dane",
      code: "exempt.lots",
      params: { count: e.n, from: e.from, valueUsd: e.value },
      priority: 40,
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}
