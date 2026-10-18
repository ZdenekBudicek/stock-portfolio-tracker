// "Co když prodám?" — a hypothetical sale run through the same FIFO and the same yearly
// report arithmetic as the real tax report, without touching any stored data.
//
// The extra tax is the difference between the year's report before and after the sale, not
// 15 % of this sale's gain: one sale can push the year over the 100 000 Kč limit and make the
// earlier sales taxable too, or push the time-test-exempt proceeds over the 40 mil. Kč cap.
// Crypto runs under its own rules (see czTax.ts). The sale-day rate is an explicit assumption (no ČNB rate exists
// for a day that has not happened); the purchase-day rates are the real ČNB/GFŘ ones and a
// missing one makes the result incomplete instead of being replaced by today's rate.
import { runFifo, type FifoTx } from "@/lib/fifo";
import { defaultKindOf, pragueDate, summarizeSalesYear, taxDisposal, type AssetKind, type AssetKindResolver, type SalesYearReport, type TaxedDisposal, type TaxSettings } from "@/lib/czTax";
import type { FxRate } from "@/lib/cnbRates";

export interface SaleInput {
  ticker: string;
  /** Broker/account whose lots are sold (OpenLot.broker / .account). */
  broker: string;
  account: string;
  shares: number;
  priceUsd: number;
  feeUsd: number;
  /** Sale instant (ISO). */
  at: string;
  /** Assumed USD/CZK on the sale day. */
  saleFx: number;
}

export interface SimulatedPiece {
  acquiredDate: string;
  exemptFrom: string;
  exempt: boolean;
  /** false: crypto sold before 15. 2. 2025 — no exemption existed. */
  exemptionsApply: boolean;
  shares: number;
  costUsd: number;
  proceedsUsd: number;
  gainUsd: number;
  /** null when the purchase-day rate is missing. */
  gainCzk: number | null;
}

export interface SaleSimulation {
  pieces: SimulatedPiece[];
  kind: AssetKind;
  /** Shares asked for that the account does not hold. */
  missingShares: number;
  proceedsCzk: number;
  gainCzk: number | null;
  taxableGainCzk: number | null;
  /** Year totals after the sale; the limit is the one of the sold asset's kind. */
  limitBaseAfterCzk: number;
  underLimitAfter: boolean;
  /** Share of time-test-exempt proceeds taxed because of the 40 mil. Kč cap (0 under it). */
  capTaxedShareAfter: number;
  taxBaseAfterCzk: number | null;
  estTaxAfterCzk: number | null;
  /** estTaxAfter − estTaxBefore; null when it cannot be known. */
  extraTaxCzk: number | null;
  /** The simulated sale itself is fully priced and covered by lots. */
  complete: boolean;
  /**
   * The year's report before the sale is complete. When it is not (a missing rate or an
   * unmatched sell elsewhere in the year), the extra tax is still the difference of two
   * reports over the same known rows — but the limit cannot be confirmed, so it is shown
   * as approximate.
   */
  yearComplete: boolean;
}

const SIM_ID = "__simulated_sale__";

export function simulateSale(
  txs: FifoTx[], before: SalesYearReport, input: SaleInput, settings: TaxSettings,
  kindOf: AssetKindResolver = defaultKindOf,
): SaleSimulation {
  const sim: FifoTx = {
    id: SIM_ID, ticker: input.ticker, side: "SELL", shares: input.shares, price_usd: input.priceUsd,
    fee_usd: input.feeUsd, executed_at: input.at,
    broker: input.broker === "MANUAL" ? "manual" : input.broker, broker_account: input.account || null,
  };
  const fifo = runFifo([...txs, sim]);
  const resolution = kindOf(input.ticker);
  const kind = resolution.kind;
  const soldDate = pragueDate(input.at);
  const saleFx: FxRate = { rate: input.saleFx, ref: soldDate };
  const pieces: SimulatedPiece[] = [];
  const rows: TaxedDisposal[] = [];
  let complete = true;
  let proceedsCzk = 0, gainCzk: number | null = 0, taxableGainCzk: number | null = 0;
  for (const d of fifo.disposals) {
    if (d.sellTxId !== SIM_ID) continue;
    // The real purchase-day rate, the assumed sale-day rate.
    const row = { ...taxDisposal(d, settings.fxMethod, resolution), fxSell: saleFx };
    row.proceedsCzk = d.proceedsUsd * input.saleFx;
    row.sellFeeCzk = d.sellFeeUsd * input.saleFx;
    row.gainCzk = row.costCzk == null ? null : row.proceedsCzk - row.sellFeeCzk - row.costCzk;
    rows.push(row);
    if (row.gainCzk == null) complete = false;
    proceedsCzk += row.proceedsCzk;
    gainCzk = gainCzk != null && row.gainCzk != null ? gainCzk + row.gainCzk : null;
    if (!row.exempt) taxableGainCzk = taxableGainCzk != null && row.gainCzk != null ? taxableGainCzk + row.gainCzk : null;
    pieces.push({
      acquiredDate: row.acquiredDate, exemptFrom: row.exemptFrom, exempt: row.exempt, exemptionsApply: row.exemptionsApply,
      shares: d.shares, costUsd: d.costUsd, proceedsUsd: d.proceedsUsd, gainUsd: d.gainUsd, gainCzk: row.gainCzk,
    });
  }
  const sold = pieces.reduce((s, p) => s + p.shares, 0);
  const missingShares = Math.max(0, input.shares - sold);
  if (missingShares > 1e-9) complete = false;

  // The sale lands in its own calendar year; only a sale in the report's year changes it.
  // The year is re-run with the sale's rows added, so the limits and the 40 mil. Kč cap
  // see it exactly like a real sale.
  const sameYear = Number(soldDate.slice(0, 4)) === before.year;
  const after = sameYear
    ? summarizeSalesYear(before.year, [...before.rows, ...rows], before.unmatched, settings, before.missingFx, !before.complete || !complete)
    : before;
  const kindAfter = kind === "crypto" ? after.crypto : after.securities;
  // A piece without its purchase rate leaves the base unknown.
  const known = taxableGainCzk != null || !sameYear;
  const taxBaseAfterCzk = known ? after.taxBaseCzk : null;
  const estTaxAfterCzk = known ? after.estTaxCzk : null;
  return {
    pieces, kind, missingShares, proceedsCzk, gainCzk, taxableGainCzk,
    limitBaseAfterCzk: kindAfter.limitBaseCzk, underLimitAfter: kindAfter.underLimit,
    capTaxedShareAfter: after.cap.taxedShare,
    taxBaseAfterCzk, estTaxAfterCzk,
    extraTaxCzk: estTaxAfterCzk == null || !complete ? null : estTaxAfterCzk - before.estTaxCzk,
    complete,
    yearComplete: before.complete,
  };
}
