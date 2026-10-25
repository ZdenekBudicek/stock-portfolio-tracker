import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSaleModel, resolveSaleAccount, type SaleRequest } from "@/lib/saleModel";
import { computeCzTaxModel } from "@/lib/czTaxModel";
import { computeInternationalTaxModel } from "@/lib/internationalTaxModel";
import { taxEngineFor, type Country } from "@/lib/tax/engines";
import { createInternationalFixture, createSaleFixture } from "@/test/agentPortfolioFixture";
import { buildSalesReport } from "@/lib/czTax";
import { runFifo } from "@/lib/fifo";
import * as rates from "@/lib/cnbRates";

const sale: SaleRequest = { ticker: "AAPL", broker: "synthetic", account: "A", shares: 3,
  priceUsd: 150, feeUsd: 0, at: "2026-10-23T12:00:00Z", saleFx: 25 };
afterEach(() => vi.restoreAllMocks());

describe("scoped sale model", () => {
  it("requires clarification for two accounts and resolves only an existing scope", () => {
    const { transactions } = createSaleFixture();
    const choices = [{ broker: "SYNTHETIC", account: "A" }, { broker: "SYNTHETIC", account: "B" }];
    expect(resolveSaleAccount("AAPL", transactions)).toEqual({ status: "clarify", choices });
    expect(resolveSaleAccount("AAPL", transactions, choices[0])).toEqual({ status: "resolved", ...choices[0] });
    expect(resolveSaleAccount("AAPL", transactions, sale)).toEqual({ status: "resolved", ...choices[0] });
    expect(resolveSaleAccount("AAPL", transactions, { broker: "synthetic", account: "wrong" })).toEqual({ status: "clarify", choices });
    expect(resolveSaleAccount("NONE", transactions)).toEqual({ status: "clarify", choices: [] });
    expect(resolveSaleAccount("AAPL", transactions.slice(0, 1))).toEqual({ status: "resolved", ...choices[0] });
  });

  it("sells account A at a 150 USD gain without consuming B or mutating inputs", () => {
    const fixture = createSaleFixture();
    const model = computeCzTaxModel(fixture);
    const original = structuredClone(fixture.transactions);
    const result = computeSaleModel({ jurisdiction: "CZ", model, transactions: fixture.transactions, sale });
    if (result.jurisdiction !== "CZ") throw new Error("Wrong engine");
    expect(result.result.pieces.reduce((s, p) => s + p.gainUsd, 0)).toBe(150);
    expect(result.result.pieces.reduce((s, p) => s + p.shares, 0)).toBe(3);
    expect(model.fifo.openLots.find(l => l.account === "B")?.shares).toBe(5);
    expect(fixture.transactions).toEqual(original);
  });

  it("uses the annual CZ tax delta when a sale crosses the proceeds limit", () => {
    vi.spyOn(rates, "usdCzkFor").mockImplementation(date => ({ rate: 25, ref: date }));
    const fixture = createSaleFixture();
    fixture.transactions.push({ ...fixture.transactions[0], id: "earlier-buy", ticker: "SYN", shares: 100, price_usd: 10 },
      { ...fixture.transactions[0], id: "earlier-sale", ticker: "SYN", side: "SELL", shares: 100, price_usd: 39, executed_at: "2026-02-01T12:00:00Z" });
    const model = computeCzTaxModel(fixture);
    const output = computeSaleModel({ jurisdiction: "CZ", model, transactions: fixture.transactions, sale });
    if (output.jurisdiction !== "CZ") throw new Error("Wrong engine");
    const after = buildSalesReport(runFifo([...fixture.transactions, { ...fixture.transactions[0], id: "sale", side: "SELL",
      shares: 3, price_usd: 150, executed_at: sale.at }]).disposals, 2026, fixture.settings);
    expect(output.result.extraTaxCzk).toBe(after.estTaxCzk - model.report.estTaxCzk);
    expect(output.result.extraTaxCzk).toBe(11437.5);
    expect(output.result.extraTaxCzk).not.toBe(150 * 25 * 0.15);
  });

  it("keeps missing purchase FX incomplete", () => {
    vi.spyOn(rates, "usdCzkFor").mockReturnValue(null);
    const fixture = createSaleFixture();
    const output = computeSaleModel({ jurisdiction: "CZ", model: computeCzTaxModel(fixture), transactions: fixture.transactions, sale });
    expect(output.result).toMatchObject({ complete: false, extraTaxCzk: null, gainCzk: null });
  });

  it.each<Country>(["SK", "PL", "DE", "GB", "US"])("delegates %s simulation with the full assumptions", country => {
    const fixture = { ...createInternationalFixture(country), transactions: createSaleFixture().transactions };
    const model = computeInternationalTaxModel(fixture);
    if (model.status !== "ready") throw new Error(model.reason);
    const spy = vi.spyOn(taxEngineFor(country), "simulate");
    const request = { ...sale, feeUsd: 2, taxDate: "2026-10-23", assumedLocalFx: country === "US" ? 1 : 0.9,
      ...(country === "US" ? { lots: [{ buyId: "buy-A", shares: 3 }] } : {}) };
    const output = computeSaleModel({ jurisdiction: country, model, sale: request });
    expect(output.jurisdiction).toBe(country);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toEqual({ assumedFx: request.assumedLocalFx, trade: expect.objectContaining({
      ticker: "AAPL", broker: "synthetic", broker_account: "A", shares: 3, price_usd: 150, fee_usd: 2,
      executed_at: sale.at, taxDate: request.taxDate, ...(country === "US" ? { lots: request.lots } : {}) }) });
    expect(output.result).toEqual(spy.mock.results[0].value);
    expect(model.input.trades).toHaveLength(2);
    if (country === "US") {
      const result = spy.mock.results[0].value;
      expect(result.after.rows[0]).toMatchObject({ buyId: "buy-A", gain: 148 });
      expect(result.after.openLots.find(l => l.buyId === "buy-B").shares).toBe(5);
    }
  });

  it("rejects unsupported CZ lots, conflicting dates/FX, and invalid quantities", () => {
    const fixture = createSaleFixture();
    const input = { jurisdiction: "CZ" as const, model: computeCzTaxModel(fixture), transactions: fixture.transactions };
    for (const override of [{ lots: [{ buyId: "buy-A", shares: 3 }] }, { taxDate: "2026-10-22" }, { assumedLocalFx: 0.9 },
      { shares: -1 }, { priceUsd: NaN }, { feeUsd: -1 }, { saleFx: 0 }, { at: "bad" }, { account: "wrong" }]) {
      expect(() => computeSaleModel({ ...input, sale: { ...sale, ...override } })).toThrow();
    }
  });

  it("rejects foreign profile mismatch and non-US specific lots", () => {
    const model = computeInternationalTaxModel({ ...createInternationalFixture(), transactions: createSaleFixture().transactions });
    if (model.status !== "ready") throw new Error(model.reason);
    expect(() => computeSaleModel({ jurisdiction: "US", model, sale })).toThrow(/profile/i);
    expect(() => computeSaleModel({ jurisdiction: "SK", model, sale: { ...sale, lots: [{ buyId: "buy-A", shares: 3 }] } })).toThrow(/lot/i);
  });

  it("uses a resolved FIFO account with the US engine's original broker identity", () => {
    const transactions = createSaleFixture().transactions;
    const scope = resolveSaleAccount("AAPL", transactions, sale);
    if (scope.status !== "resolved") throw new Error("Missing account");
    const model = computeInternationalTaxModel({ ...createInternationalFixture("US"), transactions });
    if (model.status !== "ready") throw new Error(model.reason);
    const output = computeSaleModel({ jurisdiction: "US", model, sale: { ...sale, ...scope } });
    if (output.jurisdiction === "CZ") throw new Error("Wrong engine");
    expect(output.result.after.rows[0]).toMatchObject({ buyId: "buy-A", gain: 150 });
    expect(() => computeSaleModel({ jurisdiction: "US", model, sale: { ...sale, account: "wrong" } })).toThrow(/account/i);
  });

  it.each(["CZ", "SK"] as const)("never lets a scoped %s manual simulation spill into another account", jurisdiction => {
    const fixture = createSaleFixture();
    fixture.transactions[0] = { ...fixture.transactions[0], broker: "manual", broker_account: "" };
    const request = { ...sale, broker: "MANUAL", account: "", shares: 6 };
    if (jurisdiction === "CZ") {
      expect(() => computeSaleModel({ jurisdiction, model: computeCzTaxModel(fixture), transactions: fixture.transactions, sale: request })).toThrow(/account/i);
    } else {
      const model = computeInternationalTaxModel({ ...createInternationalFixture(jurisdiction), transactions: fixture.transactions });
      if (model.status !== "ready") throw new Error(model.reason);
      expect(() => computeSaleModel({ jurisdiction, model, sale: request })).toThrow(/account/i);
    }
  });

  it("forwards US specific lots instead of falling back to FIFO", () => {
    const transactions = createSaleFixture().transactions;
    transactions.push({ ...transactions[0], id: "later-A", price_usd: 140, executed_at: "2026-02-01T12:00:00Z" });
    const model = computeInternationalTaxModel({ ...createInternationalFixture("US"), transactions });
    if (model.status !== "ready") throw new Error(model.reason);
    const output = computeSaleModel({ jurisdiction: "US", model, sale: { ...sale, lots: [{ buyId: "later-A", shares: 3 }] } });
    if (output.jurisdiction === "CZ") throw new Error("Wrong engine");
    expect(output.result.after.rows[0]).toMatchObject({ buyId: "later-A", gain: 30 });
    expect(output.result.after.openLots.find(l => l.buyId === "buy-A")?.shares).toBe(5);
  });

  it("derives the US local day without treating CZK FX as local FX", () => {
    const model = computeInternationalTaxModel({ ...createInternationalFixture("US"), transactions: createSaleFixture().transactions });
    if (model.status !== "ready") throw new Error(model.reason);
    const spy = vi.spyOn(taxEngineFor("US"), "simulate");
    computeSaleModel({ jurisdiction: "US", model, sale: { ...sale, at: "2026-10-23T00:30:00Z" } });
    expect(spy.mock.calls[0][1]).toMatchObject({ assumedFx: undefined, trade: { taxDate: "2026-10-22" } });
    expect(() => computeSaleModel({ jurisdiction: "US", model, sale: { ...sale, assumedLocalFx: 25 } })).toThrow(/USD/i);
  });
});
