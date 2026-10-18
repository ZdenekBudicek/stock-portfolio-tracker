// The ONE FIFO lot matcher of the app. The header's realized profit, the closed positions,
// the cost basis of current holdings and the tax report all read their numbers from here,
// so they can no longer disagree with each other.
//
// Rules:
//  - Lots are kept per ticker + broker + broker ACCOUNT. A sell consumes only the lots of
//    its own account — never a cheaper lot of the same ticker held elsewhere.
//  - The buy fee is part of the lot's cost; the sell fee lowers the proceeds. Both are split
//    pro rata when a lot or a sell is matched only partly.
//  - Trades with the same timestamp are ordered BUY before SELL, then by id, so the result
//    never depends on the order the database happened to return the rows in.
//  - Shares sold without a lot to match are NOT booked at zero cost. They are reported as a
//    warning and left out of the realized result (the cost is unknown, not zero).
//  - Corporate actions keep the acquisition date: a split (Revolut books it as extra shares
//    at $0, ext_id ":split:") rescales the open lots; a stock merger (":merger:" rows at $0)
//    moves the lots to the new ticker with their cost and dates; merger cash (":mergercash:")
//    is proceeds of a disposal, not a deposit.
//
// The function is pure: callers decide which rows count (see `isSyntheticTx`).

export interface FifoTx {
  id: string;
  ticker: string;
  side: "BUY" | "SELL";
  shares: number;
  price_usd: number;
  fee_usd?: number | null;
  executed_at: string;
  broker?: string | null;
  broker_account?: string | null;
  ext_id?: string | null;
}

export interface OpenLot {
  key: string;
  ticker: string;
  broker: string;
  account: string;
  /** The transaction that created the lot (the original buy, through splits and mergers). */
  buyTxId: string;
  /** Original acquisition time — kept through splits and stock mergers. */
  acquiredAt: string;
  shares: number;
  /** Per-share purchase price, split-adjusted, without the fee. */
  priceUsd: number;
  /** Per-share buy fee, split-adjusted. */
  feePerShareUsd: number;
  /** Set when a corporate action rescaled or moved the lot. */
  adjustedBy?: "split" | "merger";
}

export interface Disposal {
  key: string;
  ticker: string;
  broker: string;
  account: string;
  sellTxId: string;
  buyTxId: string;
  /** "merger-cash" = cash paid in a stock+cash merger, attributed to the exchanged lot. */
  kind: "sale" | "merger-cash";
  shares: number;
  acquiredAt: string;
  soldAt: string;
  buyPriceUsd: number;
  sellPriceUsd: number;
  /** Gross proceeds: shares × sell price (merger cash: the cash attributed to this lot). */
  proceedsUsd: number;
  /** Purchase cost incl. the matching part of the buy fee. */
  costUsd: number;
  buyFeeUsd: number;
  sellFeeUsd: number;
  /** proceeds − sell fee − cost */
  gainUsd: number;
}

export type FifoWarningKind =
  | "unmatched-sell"
  | "split-without-lots"
  | "merger-without-cash"
  | "merger-without-lots"
  | "merger-cash-unpaired"
  | "merger-cash-with-stock";

export interface FifoWarning {
  kind: FifoWarningKind;
  txId: string;
  ticker: string;
  broker: string;
  account: string;
  date: string;
  shares?: number;
  amountUsd?: number;
}

export interface FifoResult {
  disposals: Disposal[];
  openLots: OpenLot[];
  warnings: FifoWarning[];
}

const EPS = 1e-9;
const DAY_MS = 86_400_000;

type Kind = "trade" | "split" | "merger-out" | "merger-in" | "merger-cash";

/** Reconciliation (`:adj:`) and holdings-snapshot (`:pos:`) rows: share corrections, not trades. */
export function isSyntheticTx(t: { ext_id?: string | null }): boolean {
  const ext = String(t.ext_id ?? "");
  return ext.includes(":adj:") || ext.includes(":pos:");
}

/** Real trades only — what realized profit and taxes are computed from. */
export function isRealTradeTx(t: { ticker: string; ext_id?: string | null }): boolean {
  return t.ticker !== "CASH" && !isSyntheticTx(t);
}

export function brokerOf(t: { broker?: string | null; ext_id?: string | null }): string {
  const ext = String(t.ext_id ?? "");
  return String(t.broker ?? (ext ? ext.split(":")[0] : "manual")).toUpperCase();
}

export function lotKey(t: FifoTx): string {
  return `${t.ticker}|${brokerOf(t)}|${t.broker_account ?? ""}`;
}

function kindOf(t: FifoTx): Kind {
  const ext = String(t.ext_id ?? "");
  // A corporate-action row someone priced by hand is treated as the plain trade it claims to be.
  const free = !(Number(t.price_usd) > 0);
  if (ext.includes(":mergercash:")) return "merger-cash";
  if (free && ext.includes(":split:") && t.side === "BUY") return "split";
  if (free && ext.includes(":merger:")) return t.side === "SELL" ? "merger-out" : "merger-in";
  return "trade";
}

const ms = (iso: string) => Date.parse(iso) || 0;
const rank = (t: FifoTx, k: Kind) => (k === "trade" ? (t.side === "BUY" ? 0 : 2) : 1);

export function runFifo(input: FifoTx[]): FifoResult {
  const rows = input
    .filter((t) => t.ticker !== "CASH")
    .map((t) => ({ t, k: kindOf(t), at: ms(t.executed_at) }))
    .sort((a, b) => a.at - b.at || rank(a.t, a.k) - rank(b.t, b.k) || String(a.t.id).localeCompare(String(b.t.id)));

  const lots = new Map<string, OpenLot[]>();
  const disposals: Disposal[] = [];
  const warnings: FifoWarning[] = [];
  const queue = (key: string) => lots.get(key) ?? lots.set(key, []).get(key)!;
  const warn = (kind: FifoWarningKind, t: FifoTx, extra: Partial<FifoWarning> = {}) =>
    warnings.push({ kind, txId: t.id, ticker: t.ticker, broker: brokerOf(t), account: t.broker_account ?? "", date: t.executed_at, ...extra });

  /** Remove `shares` from the front of a queue; returns the removed pieces (as lots). */
  const take = (key: string, shares: number): { pieces: OpenLot[]; missing: number } => {
    const q = queue(key);
    const pieces: OpenLot[] = [];
    let left = shares;
    while (left > EPS && q.length) {
      const lot = q[0];
      const n = Math.min(left, lot.shares);
      pieces.push({ ...lot, shares: n });
      lot.shares -= n;
      left -= n;
      if (lot.shares <= EPS) q.shift();
    }
    return { pieces, missing: left > EPS ? left : 0 };
  };

  const pushDisposal = (sell: FifoTx, lot: OpenLot, kind: Disposal["kind"], shares: number, proceedsUsd: number, sellFeeUsd: number, costShares = shares) => {
    const buyFeeUsd = costShares * lot.feePerShareUsd;
    const costUsd = costShares * lot.priceUsd + buyFeeUsd;
    disposals.push({
      key: lot.key, ticker: lot.ticker, broker: lot.broker, account: lot.account,
      sellTxId: sell.id, buyTxId: lot.buyTxId, kind, shares,
      acquiredAt: lot.acquiredAt, soldAt: sell.executed_at,
      buyPriceUsd: lot.priceUsd, sellPriceUsd: shares > EPS ? proceedsUsd / shares : 0,
      proceedsUsd, costUsd, buyFeeUsd, sellFeeUsd,
      gainUsd: proceedsUsd - sellFeeUsd - costUsd,
    });
  };

  // ── Merger pre-pass: stock rows of one event share broker+account+timestamp; merger cash
  // is linked to the nearest merger-out of the same ticker (it may be booked days apart).
  const groupOf = (t: FifoTx) => `${brokerOf(t)}|${t.broker_account ?? ""}|${ms(t.executed_at)}`;
  const groups = new Map<string, FifoTx[]>();
  for (const r of rows) if (r.k === "merger-out" || r.k === "merger-in") (groups.get(groupOf(r.t)) ?? groups.set(groupOf(r.t), []).get(groupOf(r.t))!).push(r.t);
  const outs = rows.filter((r) => r.k === "merger-out");
  const cashFor = new Map<string, FifoTx[]>(); // merger-out id -> its cash rows
  for (const c of rows.filter((r) => r.k === "merger-cash")) {
    let best: { id: string; d: number } | null = null;
    for (const o of outs) {
      if (o.t.ticker !== c.t.ticker || brokerOf(o.t) !== brokerOf(c.t) || (o.t.broker_account ?? "") !== (c.t.broker_account ?? "")) continue;
      const d = Math.abs(o.at - c.at);
      if (d <= 31 * DAY_MS && (!best || d < best.d)) best = { id: o.t.id, d };
    }
    if (best) (cashFor.get(best.id) ?? cashFor.set(best.id, []).get(best.id)!).push(c.t);
    else warn("merger-cash-unpaired", c.t, { amountUsd: cashAmount(c.t) });
  }
  const doneGroups = new Set<string>();

  const processMerger = (gid: string) => {
    doneGroups.add(gid);
    const members = groups.get(gid) ?? [];
    const gOuts = members.filter((t) => t.side === "SELL");
    const gIns = members.filter((t) => t.side === "BUY");
    const removedShares = gOuts.reduce((s, t) => s + t.shares, 0);
    const insShares = gIns.reduce((s, t) => s + t.shares, 0);
    let missingTotal = 0;

    for (const out of gOuts) {
      const { pieces, missing } = take(lotKey(out), out.shares);
      if (missing > 0) { warn("unmatched-sell", out, { shares: missing }); missingTotal += missing; }
      const cash = (cashFor.get(out.id) ?? []).reduce((s, c) => s + cashAmount(c), 0);
      const got = pieces.reduce((s, p) => s + p.shares, 0);

      if (gIns.length === 0) {
        // Pure cash merger = a sale of the removed shares for the cash paid.
        if (!(cash > 0)) warn("merger-without-cash", out, { shares: out.shares });
        for (const p of pieces) pushDisposal(out, p, "sale", p.shares, got > EPS ? cash * (p.shares / got) : 0, 0);
        continue;
      }
      if (cash > 0) {
        // Stock + cash: the cash is a disposal attributed to the exchanged lots (by shares,
        // with each lot's own acquisition date); the cost basis moves on with the new shares.
        warn("merger-cash-with-stock", out, { amountUsd: cash });
        for (const p of pieces) pushDisposal(out, p, "merger-cash", 0, got > EPS ? cash * (p.shares / got) : 0, 0, 0);
      }
      // Stock part: every exchanged lot continues in the new ticker(s) with its cost and date.
      for (const inc of gIns) {
        const share = insShares > EPS ? inc.shares / insShares : 0;
        const ratio = removedShares > EPS ? insShares / removedShares : 0;
        for (const p of pieces) {
          const sh = p.shares * share * ratio;
          if (sh <= EPS) continue;
          insertByDate(queue(lotKey(inc)), {
            ...p, key: lotKey(inc), ticker: inc.ticker, broker: brokerOf(inc), account: inc.broker_account ?? "",
            shares: sh, priceUsd: ratio > EPS ? p.priceUsd / ratio : 0, feePerShareUsd: ratio > EPS ? p.feePerShareUsd / ratio : 0,
            adjustedBy: "merger",
          });
        }
      }
    }
    // New shares that have no lot to inherit from (no removed shares in the event, or the
    // removed shares were never bought in this ledger): the cost basis is unknown. They are
    // still added — at $0, dated the merger — so the share count matches the broker.
    if (gIns.length && (gOuts.length === 0 || missingTotal > EPS)) {
      const covered = gOuts.length ? missingTotal / removedShares : 1;
      for (const inc of gIns) {
        const sh = inc.shares * covered;
        warn("merger-without-lots", inc, { shares: sh });
        insertByDate(queue(lotKey(inc)), { ...newLot(inc), shares: sh });
      }
    }
  };

  for (const { t, k } of rows) {
    if (k === "merger-cash") continue; // handled with its merger-out
    if (k === "merger-out" || k === "merger-in") {
      const gid = groupOf(t);
      if (!doneGroups.has(gid)) processMerger(gid);
      continue;
    }
    if (!(t.shares > 0)) continue;
    const key = lotKey(t);
    if (k === "split") {
      const q = queue(key);
      const held = q.reduce((s, l) => s + l.shares, 0);
      if (held <= EPS) { warn("split-without-lots", t, { shares: t.shares }); q.push(newLot(t)); continue; }
      const r = (held + t.shares) / held;
      for (const l of q) { l.shares *= r; l.priceUsd /= r; l.feePerShareUsd /= r; l.adjustedBy = l.adjustedBy ?? "split"; }
      continue;
    }
    if (t.side === "BUY") { queue(key).push(newLot(t)); continue; }
    // SELL
    const fee = Number(t.fee_usd) || 0;
    const { pieces, missing: left } = take(key, t.shares);
    let missing = left;
    // A hand-entered sell carries no broker, so it can never find its own lots: the shares
    // were bought at a real broker (e.g. Revolut) and the sale was logged manually. Let it
    // consume the oldest open lots of the same ticker at any other broker/account.
    if (missing > 0 && brokerOf(t) === "MANUAL") {
      while (missing > EPS) {
        let best: string | null = null;
        for (const [k, q] of lots) {
          if (k === key || !q.length || q[0].ticker !== t.ticker) continue;
          if (!best || q[0].acquiredAt < lots.get(best)![0].acquiredAt) best = k;
        }
        if (!best) break;
        const got = take(best, Math.min(missing, lots.get(best)![0].shares));
        pieces.push(...got.pieces);
        missing -= got.pieces.reduce((s, p) => s + p.shares, 0);
      }
    }
    for (const p of pieces) pushDisposal(t, p, "sale", p.shares, p.shares * t.price_usd, fee * (p.shares / t.shares));
    if (missing > EPS) warn("unmatched-sell", t, { shares: missing, amountUsd: missing * t.price_usd });
  }

  const openLots = [...lots.values()].flat().filter((l) => l.shares > EPS);
  return { disposals, openLots, warnings };
}

/**
 * Lots carried over by a merger keep their ORIGINAL acquisition date, so they belong in the
 * queue by that date — appended at the end, a 2020 lot sat behind a 2024 buy of the new
 * ticker and the 2024 lot was sold first (wrong gain, wrong time test).
 */
function insertByDate(q: OpenLot[], lot: OpenLot) {
  const i = q.findIndex((l) => l.acquiredAt > lot.acquiredAt);
  if (i < 0) q.push(lot); else q.splice(i, 0, lot);
}

function newLot(t: FifoTx): OpenLot {
  const fee = Number(t.fee_usd) || 0;
  return {
    key: lotKey(t), ticker: t.ticker, broker: brokerOf(t), account: t.broker_account ?? "",
    buyTxId: t.id, acquiredAt: t.executed_at, shares: t.shares,
    priceUsd: Number(t.price_usd) || 0, feePerShareUsd: t.shares > 0 ? fee / t.shares : 0,
  };
}

/** Merger cash rows carry the amount in price_usd (shares are 0 so positions don't move). */
function cashAmount(t: FifoTx): number {
  return Math.abs(Number(t.price_usd) || 0) * (t.shares > 0 ? t.shares : 1);
}

/** Sum of realized gains (USD) — what the header shows as "Realizovaný zisk". */
export function realizedUsd(r: FifoResult): number {
  return r.disposals.reduce((s, d) => s + d.gainUsd, 0);
}
