// "Vloženo" — the net money put into what the header values, so that
//     Celkový zisk = Hodnota − Vloženo
// holds for every broker. Hodnota is the positions plus the ONE cash balance the app tracks
// (the CASH row), so the money-in has to be measured per broker on the same basis:
//
//  • Tracked cash (the CASH row). It moves with manual deposits/withdrawals (CASH rows in the
//    ledger), with manual trades (the DB cash trigger) and with the connected Trading 212
//    account's free cash (mirrored by the sync). External money in is therefore the manual
//    CASH rows plus the connected account's net deposits from its own balance identity
//        total = deposits + result + ppl   =>   deposits = total − ppl − result
//    A manual trade only moves money between CASH and a position — it is not money in.
//    (Counting it too booked a deposit made in the Hotovost dialog a second time on the buy.)
//
//  • Brokers whose cash is NOT tracked — Revolut, XTB, any other Trading 212 account known
//    only from its statements. Their idle cash and sale proceeds are not in Hodnota, so their
//    real deposits must not be in Vloženo either (a $1 000 deposit, buy and sale at $1 100
//    read as a −$1 000 loss). Money in is the trade proxy instead: what was paid for the
//    positions, fees included, minus what sales returned. Hodnota − proxy is then exactly the
//    unrealized plus the realized result at that broker. Reconciliation (`:adj:`) and holdings
//    (`:pos:`) rows count too — they carry the broker's own cost, and the shares they add are
//    in Hodnota.

/** XTB dividends are stored gross; the US treaty withholding (W-8BEN) is 15 %. */
const XTB_ASSUMED_WHT = 0.15;

export interface DepositLedgerRow {
  ticker: string;
  side: "BUY" | "SELL";
  shares: number;
  price_usd: number;
  fee_usd?: number | null;
  executed_at: string;
  ext_id?: string | null;
  broker?: string | null;
  broker_account?: string | null;
}

/** The connected Trading 212 account's summary (broker_connections.account_summary). */
export interface T212AccountSummary {
  currency: string | null;
  total: number;
  ppl: number;
  result: number;
  /** Account number the summary belongs to; absent on summaries stored before scoping. */
  account?: string | null;
}

/** A received dividend (as read from the dividends table). */
export interface DepositDividendRow {
  broker?: string | null;
  broker_account?: string | null;
  status: string;
  total_amount_usd: number | null;
  pay_date?: string | null;
  ex_date: string;
  ext_id?: string | null;
}

export interface NetDeposits {
  usd: number;
  /** The same money in CZK at the rate of the day it went in (CZK account: exact). */
  czk: number;
}

const isManual = (t: DepositLedgerRow) => (t.broker ?? "manual").toLowerCase() === "manual";
const isT212 = (t: DepositLedgerRow) => (t.broker ?? "").toUpperCase() === "T212";

/** Net deposits of the connected T212 account from its balance identity, or null if unusable. */
function t212Identity(s: T212AccountSummary | null | undefined, usdCzk: number): NetDeposits | null {
  if (!s || !(s.total > 0)) return null;
  const net = s.total - s.ppl - s.result;
  // A profitable account that has been drawn down can legitimately sit at or below zero net
  // deposits — "return on deposits" then means nothing, so the trade proxy is kept instead.
  if (!(net > 0)) return null;
  if (s.currency === "CZK") return { usd: net / usdCzk, czk: net };
  if (s.currency === "USD") return { usd: net, czk: net * usdCzk };
  return null; // unknown account currency — never guess (EUR read as CZK is off by ~25 %)
}

export function computeNetDeposits({ txs, t212, usdCzk, fxAt, dividends = [] }: {
  txs: DepositLedgerRow[];
  t212?: T212AccountSummary | null;
  /** Today's USD/CZK, for the connected account's CZK↔USD conversion. */
  usdCzk: number;
  /** USD/CZK on a given day (YYYY-MM-DD), for flows booked in USD. */
  fxAt: (date: string) => number;
  /**
   * Paid dividends. At a broker whose cash is NOT tracked a dividend is money that came back
   * out of the positions: without this it was lost (not in Hodnota), and once reinvested
   * its buy even counted as a fresh deposit. Only real payouts (from a statement or the
   * broker API, i.e. with an ext_id) — never the estimated "auto" rows.
   */
  dividends?: DepositDividendRow[];
}): NetDeposits {
  const identity = t212Identity(t212, usdCzk);
  const account = t212?.account ?? null;
  // Rows written before per-account scoping carry no account. The sync only adopts them for
  // the connected account when no other T212 account is present — read them the same way.
  const otherT212 = txs.some((t) => isT212(t) && t.ticker !== "CASH" && t.broker_account && t.broker_account !== account);
  const isConnected = (t: DepositLedgerRow) =>
    isT212(t) && (account == null || t.broker_account === account || (!t.broker_account && !otherT212));

  let usd = 0, czk = 0;
  const add = (amountUsd: number, date: string) => {
    if (!Number.isFinite(amountUsd) || amountUsd === 0) return;
    usd += amountUsd;
    czk += amountUsd * fxAt(date.slice(0, 10));
  };

  for (const t of txs) {
    const sign = t.side === "BUY" ? 1 : -1;
    if (t.ticker === "CASH") {
      // Manual deposit (BUY) / withdrawal (SELL) — the same amount the cash trigger books.
      add(sign * t.shares * t.price_usd, t.executed_at);
      continue;
    }
    if (isManual(t)) continue;                    // cash tracked in CASH: an internal move
    if (identity && isConnected(t)) continue;     // replaced by the broker's own figure
    const fee = Number(t.fee_usd) || 0;
    // Merger cash is stored as a 0-share SELL carrying the amount in price_usd: it is money
    // coming back out, which shares × price would read as 0.
    const gross = String(t.ext_id ?? "").includes(":mergercash:") ? Math.abs(t.price_usd) * (t.shares > 0 ? t.shares : 1) : t.shares * t.price_usd;
    add(sign * gross + fee, t.executed_at); // trade proxy: buy + fee, sale − fee
  }

  for (const d of dividends) {
    if (d.status !== "paid" || !d.ext_id || !(Number(d.total_amount_usd) > 0)) continue;
    const b = (d.broker ?? "").toLowerCase();
    if (!b || b === "auto" || b === "manual") continue;
    const row = { ticker: "", side: "BUY" as const, shares: 0, price_usd: 0, executed_at: "", broker: d.broker, broker_account: d.broker_account };
    if (identity && isConnected(row)) continue; // lands in the tracked T212 free cash
    // XTB records the GROSS dividend; what reached the account is net of the withholding.
    const received = Number(d.total_amount_usd) * (b === "xtb" ? 1 - XTB_ASSUMED_WHT : 1);
    add(-received, d.pay_date ?? d.ex_date);
  }

  if (identity) { usd += identity.usd; czk += identity.czk; }
  return { usd, czk };
}
