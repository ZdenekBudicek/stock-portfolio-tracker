// Figures for the demo assistant's answers, computed in the browser from the same invented demo data the screens show
// (holdings, today's prices, trades, price history), so an answer never contradicts the overview next to it.
import type { DemoData } from "./data";

type Lang = "cs" | "en";
export const num = (n: number, lang: Lang, digits = 0) =>
  new Intl.NumberFormat(lang === "en" ? "en-US" : "cs-CZ", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
export const usd = (n: number, lang: Lang, digits = 0) => `${num(n, lang, digits)} USD`;
export const pct = (n: number, lang: Lang, digits = 1, signed = true) => `${signed && n > 0 ? "+" : n < 0 ? "−" : ""}${num(Math.abs(n), lang, digits)} %`;

type Tx = { ticker: string; side: "BUY" | "SELL"; shares: number; price_usd: number; fee_usd?: number | null; executed_at: string };
type Position = { ticker: string; shares: number; name?: string };

export type DemoFacts = {
  today: { changePct: number; up?: { ticker: string; pct: number }; down?: { ticker: string; pct: number } };
  trades: { buys: number; buyUsd: number; sells: number; sellUsd: number; largest?: { ticker: string; usd: number } };
  realized: { total: number; thisYear: number; lastYear: number };
  weight: (ticker: string) => number;
  price: (ticker: string) => number;
  /** The change of a ticker's close over the last `days` trading days, with the S&P 500 over the same days. */
  move: (ticker: string, days: number) => { pct: number; spx: number } | null;
};

export function demoFacts(db: DemoData): DemoFacts {
  const positions = (db.tables.positions as Position[]).filter(p => p.ticker !== "CASH" && p.shares > 1e-9 && db.prices[p.ticker]);
  const value = (p: Position) => p.shares * db.prices[p.ticker].price;
  // Cash counts in the portfolio's value (as on the overview), not in the movers.
  const cash = (db.tables.positions as Position[]).find(p => p.ticker === "CASH")?.shares ?? 0;
  const total = positions.reduce((s, p) => s + value(p), 0) + cash;
  const prevTotal = positions.reduce((s, p) => s + p.shares * (db.prices[p.ticker].prevClose ?? db.prices[p.ticker].price), 0) + cash;
  const byChange = [...positions].sort((a, b) => db.prices[b.ticker].changePct - db.prices[a.ticker].changePct);
  const best = byChange[0], worst = byChange[byChange.length - 1];

  const year = db.today.slice(0, 4);
  const txs = [...(db.tables.transactions as Tx[])].sort((a, b) => a.executed_at.localeCompare(b.executed_at));
  const thisYear = txs.filter(t => t.executed_at.startsWith(year));
  const buys = thisYear.filter(t => t.side === "BUY"), sells = thisYear.filter(t => t.side === "SELL");
  const amount = (t: Tx) => t.shares * t.price_usd;
  const largest = [...buys].sort((a, b) => amount(b) - amount(a))[0];

  // Realized results by FIFO (the oldest lots are sold first), over the last 24 months.
  const lots = new Map<string, { qty: number; price: number }[]>();
  const since = new Date(Date.parse(`${db.today}T00:00:00Z`) - 730 * 86_400_000).toISOString().slice(0, 10);
  let realizedThis = 0, realizedLast = 0, realizedTotal = 0;
  for (const t of txs) {
    const queue = lots.get(t.ticker) ?? [];
    lots.set(t.ticker, queue);
    if (t.side === "BUY") { queue.push({ qty: t.shares, price: t.price_usd }); continue; }
    let left = t.shares, gain = -(t.fee_usd ?? 0);
    while (left > 1e-9 && queue.length) {
      const lot = queue[0], take = Math.min(left, lot.qty);
      gain += take * (t.price_usd - lot.price);
      lot.qty -= take; left -= take;
      if (lot.qty <= 1e-9) queue.shift();
    }
    if (t.executed_at.slice(0, 10) < since) continue;
    realizedTotal += gain;
    if (t.executed_at.startsWith(year)) realizedThis += gain; else realizedLast += gain;
  }

  const closes = (symbol: string) => (db.tables.price_history as { symbol: string; date: string; close: number }[]).filter(r => r.symbol === symbol);
  const spx = (db.tables.benchmark_history as { symbol: string; date: string; close_value: number }[]).filter(r => r.symbol === "SPX");
  return {
    today: { changePct: prevTotal > 0 ? (total / prevTotal - 1) * 100 : 0,
      ...(best ? { up: { ticker: best.ticker, pct: db.prices[best.ticker].changePct } } : {}),
      ...(worst ? { down: { ticker: worst.ticker, pct: db.prices[worst.ticker].changePct } } : {}) },
    trades: { buys: buys.length, buyUsd: buys.reduce((s, t) => s + amount(t), 0), sells: sells.length, sellUsd: sells.reduce((s, t) => s + amount(t), 0),
      ...(largest ? { largest: { ticker: largest.ticker, usd: amount(largest) } } : {}) },
    realized: { total: realizedTotal, thisYear: realizedThis, lastYear: realizedLast },
    weight: ticker => { const p = positions.find(x => x.ticker === ticker); return p && total > 0 ? (value(p) / total) * 100 : 0; },
    price: ticker => db.prices[ticker]?.price ?? 0,
    move: (ticker, days) => {
      const c = closes(ticker), b = spx;
      if (c.length <= days || b.length <= days) return null;
      const last = c[c.length - 1].close, first = c[c.length - 1 - days].close;
      const bl = b[b.length - 1].close_value, bf = b[b.length - 1 - days].close_value;
      return { pct: (last / first - 1) * 100, spx: (bl / bf - 1) * 100 };
    },
  };
}
