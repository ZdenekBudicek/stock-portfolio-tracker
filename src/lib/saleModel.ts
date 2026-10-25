import type { DbTransaction } from "@/lib/portfolioTypes";
import type { CzTaxModel } from "@/lib/czTaxModel";
import type { InternationalTaxModel } from "@/lib/internationalTaxModel";
import { simulateSale, type SaleInput, type SaleSimulation } from "@/lib/saleSimulation";
import { brokerOf, isRealTradeTx, runFifo, type FifoTx } from "@/lib/fifo";
import { pragueDate } from "@/lib/czTax";
import { COUNTRY_TZ, localDate } from "@/lib/tax/appInput";
import { taxEngineFor, type Country, type TaxSimulation } from "@/lib/tax/engines";

export type SaleRequest = SaleInput & { taxDate?: string; assumedLocalFx?: number; lots?: { buyId: string; shares: number }[] };
export type SaleModelInput = { jurisdiction: "CZ"; model: CzTaxModel; transactions: DbTransaction[]; sale: SaleRequest }
  | { jurisdiction: Country; model: Extract<InternationalTaxModel, { status: "ready" }>; sale: SaleRequest };
export type SaleModelResult = { jurisdiction: "CZ"; result: SaleSimulation } | { jurisdiction: Country; result: TaxSimulation };
type Scope = { broker: string; account: string };

function guardManualScope(transactions: readonly FifoTx[], sale: SaleRequest) {
  if (brokerOf(sale) !== "MANUAL") return;
  const available = runFifo(transactions.filter(t => t.executed_at <= sale.at)).openLots
    .filter(l => l.ticker === sale.ticker && l.broker === "MANUAL" && l.account === sale.account)
    .reduce((sum, l) => sum + l.shares, 0);
  if (sale.shares > available + 1e-9) throw new Error("A scoped manual sale cannot consume another account's lots.");
}

export function resolveSaleAccount(ticker: string, transactions: DbTransaction[], scope?: Scope):
  { status: "resolved"; broker: string; account: string } | { status: "clarify"; choices: Scope[] } {
  const choices: Scope[] = [];
  for (const lot of runFifo(transactions.filter(isRealTradeTx)).openLots) {
    if (lot.ticker !== ticker || lot.shares <= 1e-9) continue;
    if (!choices.some(c => c.broker === lot.broker && c.account === lot.account)) {
      choices.push({ broker: lot.broker, account: lot.account });
    }
  }
  const match = scope ? choices.find(c => c.broker === brokerOf(scope) && c.account === scope.account)
    : choices.length === 1 ? choices[0] : null;
  return match ? { status: "resolved", ...match } : { status: "clarify", choices };
}

export function computeSaleModel(input: SaleModelInput): SaleModelResult {
  const { sale, jurisdiction } = input;
  if (!sale.ticker || typeof sale.broker !== "string" || typeof sale.account !== "string"
    || !Number.isFinite(sale.shares) || sale.shares <= 0 || !Number.isFinite(sale.priceUsd) || sale.priceUsd <= 0
    || !Number.isFinite(sale.feeUsd) || sale.feeUsd < 0 || !Number.isFinite(Date.parse(sale.at))) {
    throw new Error("A sale requires an account, valid time, positive shares and price, and a nonnegative fee.");
  }
  if (sale.assumedLocalFx != null && (!Number.isFinite(sale.assumedLocalFx) || sale.assumedLocalFx <= 0)) {
    throw new Error("Invalid assumed local FX.");
  }
  if (jurisdiction === "US" && sale.assumedLocalFx != null && sale.assumedLocalFx !== 1) {
    throw new Error("USD reporting requires a USD/USD rate of 1.");
  }
  if (sale.lots && jurisdiction !== "US") throw new Error("Specific lots are supported only by the US engine.");
  if (input.jurisdiction === "CZ") {
    const taxDate = pragueDate(sale.at);
    if (sale.taxDate != null && sale.taxDate !== taxDate) throw new Error("CZ tax date must match the sale instant in Prague.");
    if (Number(taxDate.slice(0, 4)) !== input.model.report.year) throw new Error("Simulation outside profile year.");
    if (!Number.isFinite(sale.saleFx) || sale.saleFx <= 0
      || (sale.assumedLocalFx != null && sale.assumedLocalFx !== sale.saleFx)) throw new Error("Invalid or conflicting assumed CZK FX.");
    const transactions = input.transactions.filter(isRealTradeTx);
    const scope = resolveSaleAccount(sale.ticker, transactions, sale);
    if (scope.status !== "resolved") throw new Error("Select an account with open lots for this sale.");
    // Legacy manual sales may draw from other accounts. A scoped simulation must never do so.
    guardManualScope(transactions, sale);
    return { jurisdiction: "CZ", result: simulateSale(transactions, input.model.report, sale, input.model.settings, input.model.kindOf) };
  }
  if (input.model.input.profile.residence !== jurisdiction || input.model.report.residence !== jurisdiction) {
    throw new Error("Sale jurisdiction does not match the tax profile.");
  }
  const taxDate = sale.taxDate ?? localDate(sale.at, COUNTRY_TZ[jurisdiction]);
  const data = input.model.input;
  const assetId = data.instruments[sale.ticker]?.assetId;
  const brokers = [...new Set(data.trades.filter(t => (t.broker_account ?? "") === sale.account
    && brokerOf(t) === brokerOf(sale) && (t.ticker === sale.ticker || (assetId && data.instruments[t.ticker]?.assetId === assetId)))
    .map(t => t.broker))];
  const broker = brokers.includes(sale.broker) ? sale.broker : brokers.length === 1 ? brokers[0] : null;
  if (!broker) throw new Error("Select an existing, unambiguous account for this sale.");
  guardManualScope(data.trades, sale);
  // Keep all accounts and look-ahead history: wash sales and UK pooling need the full input.
  const trade = { id: "__simulated_sale__", ticker: sale.ticker, side: "SELL" as const,
    broker, broker_account: sale.account, shares: sale.shares, price_usd: sale.priceUsd,
    fee_usd: sale.feeUsd, executed_at: sale.at, taxDate, ...(sale.lots ? { lots: sale.lots } : {}) };
  return { jurisdiction, result: taxEngineFor(jurisdiction).simulate(input.model.input, { trade, assumedFx: sale.assumedLocalFx }) };
}
