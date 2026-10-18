// Crypto has its own Czech tax rules (zákon č. 32/2025 Sb., from 15. 2. 2025) and the
// time-test exemption is capped at 40 mil. Kč a year (§ 4 odst. 3 ZDP, from 2025; from 2026
// crypto only — zákon č. 360/2025 Sb.).
import { describe, expect, it } from "vitest";
import { runFifo, type FifoTx } from "@/lib/fifo";
import { cnbUsdCzk } from "@/lib/cnbRates";
import {
  assetKindOf, buildSalesReport, cappedKinds, DEFAULT_TAX_SETTINGS, exemptionsApply, kindResolverFrom, overallTaxState, resolveAssetKind,
  type AssetKindResolver,
} from "@/lib/czTax";
import { simulateSale } from "@/lib/saleSimulation";
import { salesCsvRows } from "@/lib/taxCsv";

let n = 0;
const fx = (d: string) => cnbUsdCzk(d)!.rate;
/** A trade whose CZK amount at that day's ČNB rate is exactly `czk`. */
const trade = (side: "BUY" | "SELL", ticker: string, day: string, czk: number, account = "A"): FifoTx => ({
  id: String(++n), ticker, side, shares: 1, price_usd: czk / fx(day), executed_at: `${day}T15:00:00Z`, broker: "T212", broker_account: account,
});
const report = (txs: FifoTx[], year: number, settings = DEFAULT_TAX_SETTINGS, kindOf?: AssetKindResolver) => {
  const f = runFifo(txs);
  return buildSalesReport(f.disposals, year, settings, f.warnings, kindOf);
};
const LENIENT = { ...DEFAULT_TAX_SETTINGS, limitIncludesExempt: false };

describe("asset kinds and per-year rules", () => {
  it("falls back to the shared crypto key set; an explicit type wins", () => {
    expect(assetKindOf("BTC")).toBe("crypto");
    expect(assetKindOf("ETHUSD")).toBe("crypto");
    expect(assetKindOf("AAPL", "Stock")).toBe("security");
    expect(assetKindOf("LTC", "ETF")).toBe("security");
    // A coin outside the price-source list is crypto when the position says so.
    expect(assetKindOf("SHIB", "Crypto")).toBe("crypto");
  });

  it("explicit type, then alias pin, then profile, then the list — unknown is flagged", () => {
    expect(resolveAssetKind("SHIB", { positionType: "Crypto" })).toMatchObject({ kind: "crypto", source: "type" });
    // "Stock" is the DB default for coins too, so it does not override the list…
    expect(resolveAssetKind("LTC", { positionType: "Stock" })).toMatchObject({ kind: "crypto", source: "list" });
    // …but a pinned Yahoo symbol (how the real LTC/ATOM stocks are pinned for prices) does.
    expect(resolveAssetKind("LTC", { positionType: "Stock", yahooSymbol: "LTC" })).toMatchObject({ kind: "security", source: "alias" });
    expect(resolveAssetKind("CUSTOM", { yahooSymbol: "SOL-USD" })).toMatchObject({ kind: "crypto", source: "alias" });
    expect(resolveAssetKind("COIN_ALIAS", { aliasCanonical: "BTC" })).toMatchObject({ kind: "crypto", source: "alias" });
    expect(resolveAssetKind("NEAR", { profileType: "ETF" })).toMatchObject({ kind: "security", source: "profile" });
    expect(resolveAssetKind("PEPE", { profileType: "CRYPTO" })).toMatchObject({ kind: "crypto", source: "profile" });
    expect(resolveAssetKind("AAPL", { profileType: "EQUITY" })).toMatchObject({ kind: "security", unresolved: false });
    expect(resolveAssetKind("SHIB")).toMatchObject({ kind: "security", source: "default", unresolved: true });
  });

  it("the registry keeps the kind of a fully sold instrument (no position row any more)", () => {
    const kindOf = kindResolverFrom({
      positions: [{ ticker: "BTC", type: "Stock" }],
      aliases: [{ alias: "ATOM", canonical: "ATOM", yahoo_symbol: "ATOM" }],
      profiles: [{ ticker: "NEAR", asset_type: "ETF" }, { ticker: "MSFT", asset_type: "EQUITY" }],
    });
    expect(kindOf("NEAR").kind).toBe("security");
    expect(kindOf("ATOM").kind).toBe("security");
    expect(kindOf("BTC").kind).toBe("crypto");
    expect(kindOf("MSFT")).toMatchObject({ kind: "security", unresolved: false });
    expect(kindOf("SHIB").unresolved).toBe(true);
  });

  it("crypto exemptions start on 15. 2. 2025, the cap's scope changes by year", () => {
    expect(exemptionsApply("crypto", "2025-02-14")).toBe(false);
    expect(exemptionsApply("crypto", "2025-02-15")).toBe(true);
    expect(exemptionsApply("security", "2010-01-04")).toBe(true);
    expect(cappedKinds(2024)).toEqual([]);
    expect(cappedKinds(2025)).toEqual(["security", "crypto"]);
    expect(cappedKinds(2026)).toEqual(["crypto"]);
  });
});

describe("crypto before 15. 2. 2025 — no exemption at all", () => {
  // BTC bought in 2020 (held almost 4 years), sold in February 2024 for 92 076 Kč, gain 47 024 Kč.
  const btc = [trade("BUY", "BTC", "2020-03-02", 92_076 - 47_024), trade("SELL", "BTC", "2024-02-15", 92_076)];

  it("is taxable despite the 3 years held and the proceeds under 100 000 Kč", () => {
    const rep = report(btc, 2024);
    expect(rep.rows[0]).toMatchObject({ assetKind: "crypto", timeTestMet: true, exemptionsApply: false, exempt: false });
    expect(rep.crypto.proceedsCzk).toBeCloseTo(92_076, 6);
    expect(rep.crypto.limitApplies).toBe(false);
    expect(rep.crypto.underLimit).toBe(false);
    expect(rep.crypto.taxBaseCzk).toBeCloseTo(47_024, 6);
    expect(rep.taxBaseCzk).toBeCloseTo(47_024, 6);
    expect(rep.estTaxCzk).toBeCloseTo(7_053.6, 6);
    // The securities limit is untouched by crypto proceeds.
    expect(rep.securities.proceedsCzk).toBe(0);
    expect(rep.underLimit).toBe(true);
  });

  it("the same trade in a share is exempt (time test and limit)", () => {
    const rep = report([trade("BUY", "AAPL", "2020-03-02", 45_052), trade("SELL", "AAPL", "2024-02-15", 92_076)], 2024);
    expect(rep.rows[0].exempt).toBe(true);
    expect(rep.estTaxCzk).toBe(0);
  });

  it("2025: only sales from 15. 2. count against crypto's own limit (KDP 625/30.04.25, example 2)", () => {
    const rep = report([
      trade("BUY", "ETH", "2024-06-03", 30_000), trade("SELL", "ETH", "2025-01-15", 50_000),
      trade("BUY", "SOL", "2024-06-03", 60_000), trade("SELL", "SOL", "2025-04-15", 80_000),
    ], 2025);
    expect(rep.crypto.proceedsCzk).toBeCloseTo(130_000, 6);
    expect(rep.crypto.limitBaseCzk).toBeCloseTo(80_000, 6); // April only
    expect(rep.crypto.underLimit).toBe(true);
    // The January sale stays taxable: 50 000 − 30 000.
    expect(rep.crypto.noExemption.gainCzk).toBeCloseTo(20_000, 6);
    expect(rep.crypto.taxBaseCzk).toBeCloseTo(20_000, 6);
  });
});

describe("crypto from 15. 2. 2025 — own limit and own time test", () => {
  it("a coin held over 3 years is exempt even above the limit; a newer one is taxable", () => {
    const rep = report([
      trade("BUY", "BTC", "2021-03-01", 100_000), trade("BUY", "ETH", "2024-03-01", 100_000),
      trade("SELL", "BTC", "2025-06-02", 400_000), trade("SELL", "ETH", "2025-06-02", 150_000),
    ], 2025);
    expect(rep.rows.find((r) => r.ticker === "BTC")!.exempt).toBe(true); // holding before 15. 2. 2025 counts
    expect(rep.crypto.underLimit).toBe(false);
    expect(rep.crypto.exempt.gainCzk).toBeCloseTo(300_000, 6);
    expect(rep.crypto.taxBaseCzk).toBeCloseTo(50_000, 6);
  });

  it("shares and crypto each have a separate 100 000 Kč limit", () => {
    const rep = report([
      trade("BUY", "AAPL", "2025-06-02", 60_000), trade("SELL", "AAPL", "2026-03-02", 90_000),
      trade("BUY", "BTC", "2025-06-02", 60_000), trade("SELL", "BTC", "2026-03-02", 90_000),
    ], 2026);
    expect(rep.proceedsCzk).toBeCloseTo(180_000, 6);
    expect(rep.securities.underLimit).toBe(true);
    expect(rep.crypto.underLimit).toBe(true);
    expect(rep.estTaxCzk).toBe(0);
  });

  it("a crypto loss is not set off against a share gain", () => {
    const rep = report([
      trade("BUY", "AAPL", "2025-06-02", 100_000), trade("SELL", "AAPL", "2026-03-02", 200_000),
      trade("BUY", "BTC", "2025-06-02", 250_000), trade("SELL", "BTC", "2026-03-02", 150_000),
    ], 2026);
    expect(rep.securities.taxBaseCzk).toBeCloseTo(100_000, 6);
    expect(rep.crypto.taxBaseCzk).toBe(0);
    expect(rep.taxBaseCzk).toBeCloseTo(100_000, 6);
  });

  it("an unmatched crypto sell leaves crypto incomplete, not the securities limit", () => {
    const rep = report([
      trade("BUY", "AAPL", "2025-06-02", 10_000), trade("SELL", "AAPL", "2026-03-02", 20_000),
      trade("SELL", "BTC", "2026-03-02", 50_000),
    ], 2026);
    expect(rep.crypto.complete).toBe(false);
    expect(rep.crypto.underLimit).toBe(false);
    expect(rep.crypto.unmatchedProceedsCzk).toBeCloseTo(50_000, 6);
    expect(rep.securities.complete).toBe(true);
    expect(rep.securities.underLimit).toBe(true);
    expect(rep.complete).toBe(false);
  });
});

describe("40 mil. Kč cap on the time-test exemption", () => {
  it("2025: a 50 mil. Kč time-tested share sale taxes the part above the cap proportionally", () => {
    const rep = report([trade("BUY", "AAPL", "2020-03-02", 20_000_000), trade("SELL", "AAPL", "2025-06-02", 50_000_000)], 2025);
    const row = rep.rows[0];
    expect(row.exempt).toBe(true);
    expect(rep.cap.baseCzk).toBeCloseTo(50_000_000, 4);
    expect(rep.cap.overCzk).toBeCloseTo(10_000_000, 4);
    expect(rep.cap.taxedShare).toBeCloseTo(0.2, 12);
    expect(row.capTaxedShare).toBeCloseTo(0.2, 12);
    // 10 mil. of the proceeds with 20 % of the expenses: 10 000 000 − 4 000 000.
    expect(rep.securities.taxable.proceedsCzk).toBeCloseTo(10_000_000, 4);
    expect(rep.securities.taxable.expensesCzk).toBeCloseTo(4_000_000, 4);
    expect(rep.taxBaseCzk).toBeCloseTo(6_000_000, 4);
    expect(rep.estTaxCzk).toBeCloseTo(900_000, 4);
    expect(rep.exempt.gainCzk).toBeCloseTo(24_000_000, 4);
  });

  it("2025: one cap shared by shares and crypto", () => {
    const rep = report([
      trade("BUY", "AAPL", "2020-03-02", 10_000_000), trade("SELL", "AAPL", "2025-06-02", 30_000_000),
      trade("BUY", "BTC", "2020-03-02", 5_000_000), trade("SELL", "BTC", "2025-06-02", 20_000_000),
    ], 2025);
    expect(rep.cap.taxedShare).toBeCloseTo(0.2, 12);
    expect(rep.securities.taxBaseCzk).toBeCloseTo(0.2 * 20_000_000, 4);
    expect(rep.crypto.taxBaseCzk).toBeCloseTo(0.2 * 15_000_000, 4);
  });

  it("2026: shares are out of the cap (zákon č. 360/2025 Sb.), crypto keeps it", () => {
    const shares = report([trade("BUY", "AAPL", "2020-03-02", 20_000_000), trade("SELL", "AAPL", "2026-06-01", 50_000_000)], 2026);
    expect(shares.cap.taxedShare).toBe(0);
    expect(shares.estTaxCzk).toBe(0);
    const coins = report([trade("BUY", "BTC", "2020-03-02", 20_000_000), trade("SELL", "BTC", "2026-06-01", 50_000_000)], 2026);
    expect(coins.cap.taxedShare).toBeCloseTo(0.2, 12);
    expect(coins.crypto.taxBaseCzk).toBeCloseTo(6_000_000, 4);
  });

  it("2024 and earlier: no cap", () => {
    const rep = report([trade("BUY", "AAPL", "2019-03-01", 20_000_000), trade("SELL", "AAPL", "2024-06-03", 50_000_000)], 2024);
    expect(rep.cap.kinds).toEqual([]);
    expect(rep.estTaxCzk).toBe(0);
  });

  it("the 100 000 Kč value test never wipes out the tax above the cap (either limit setting)", () => {
    // Coin held since 2020, sold in 2026 for 40 050 000 Kč, cost 20 mil.: 50 000 Kč above the
    // cap → 50 000 / 40 050 000 of the 20 050 000 gain = 25 031,21 Kč taxable.
    const txs = [trade("BUY", "BTC", "2020-03-02", 20_000_000), trade("SELL", "BTC", "2026-06-01", 40_050_000)];
    for (const settings of [DEFAULT_TAX_SETTINGS, LENIENT]) {
      const rep = report(txs, 2026, settings);
      expect(rep.cap.overCzk).toBeCloseTo(50_000, 4);
      expect(rep.crypto.capTaxedGainCzk).toBeCloseTo(25_031.21, 2);
      expect(rep.crypto.taxBaseCzk).toBeCloseTo(25_031.21, 2);
    }
    // Lenient: time-test lots stay out of the value test entirely, capped or not.
    const lenient = report(txs, 2026, LENIENT);
    expect(lenient.crypto.limitBaseCzk).toBe(0);
    expect(lenient.crypto.underLimit).toBe(true);
    // A small taxable sale beside it is still exempt by the value test; the capped part is not.
    const mixed = report([...txs, trade("BUY", "ETH", "2025-06-02", 10_000), trade("SELL", "ETH", "2026-06-01", 30_000)], 2026, LENIENT);
    expect(mixed.crypto.underLimit).toBe(true);
    expect(mixed.crypto.taxBaseCzk).toBeCloseTo(25_031.21, 2);
  });

  it("under the cap nothing changes", () => {
    const rep = report([trade("BUY", "AAPL", "2020-03-02", 20_000_000), trade("SELL", "AAPL", "2025-06-02", 40_000_000)], 2025);
    expect(rep.cap.taxedShare).toBe(0);
    expect(rep.estTaxCzk).toBe(0);
  });
});

describe("instrument kind in the report", () => {
  it("a coin outside the price list, typed Crypto, sold in 2024 gets no share exemption", () => {
    const txs = [trade("BUY", "SHIB", "2020-03-02", 10_000), trade("SELL", "SHIB", "2024-02-15", 50_000)];
    const typed = report(txs, 2024, DEFAULT_TAX_SETTINGS, kindResolverFrom({ positions: [{ ticker: "SHIB", type: "Crypto" }] }));
    expect(typed.rows[0]).toMatchObject({ assetKind: "crypto", exempt: false, kindUnresolved: false });
    expect(typed.taxBaseCzk).toBeCloseTo(40_000, 6);
  });

  it("an unidentified instrument is flagged and leaves the report incomplete", () => {
    const rep = report([trade("BUY", "SHIB", "2020-03-02", 10_000), trade("SELL", "SHIB", "2024-02-15", 50_000)], 2024, DEFAULT_TAX_SETTINGS, kindResolverFrom({}));
    expect(rep.unresolvedTickers).toEqual(["SHIB"]);
    expect(rep.rows[0].kindUnresolved).toBe(true);
    expect(rep.complete).toBe(false);
    expect(rep.securities.underLimit).toBe(false); // not confirmed
  });

  it("a fully sold ETF named like a coin keeps its kind from the profile", () => {
    const txs = [trade("BUY", "NEAR", "2020-03-02", 10_000), trade("SELL", "NEAR", "2024-02-15", 50_000)];
    const rep = report(txs, 2024, DEFAULT_TAX_SETTINGS, kindResolverFrom({ positions: [], profiles: [{ ticker: "NEAR", asset_type: "ETF" }] }));
    expect(rep.rows[0]).toMatchObject({ assetKind: "security", exempt: true });
    expect(rep.estTaxCzk).toBe(0);
  });
});

describe("overall tax state (Overview card)", () => {
  it("crypto alone over its limit is 'over', not the securities 'under'", () => {
    const rep = report([trade("BUY", "BTC", "2025-06-02", 100_000), trade("SELL", "BTC", "2026-03-02", 300_000)], 2026);
    expect(rep.securities.underLimit).toBe(true);
    expect(overallTaxState(rep)).toBe("over");
  });

  it("tax due under every limit (crypto before 15. 2. 2025) is 'taxed'", () => {
    const rep = report([trade("BUY", "BTC", "2020-03-02", 45_052), trade("SELL", "BTC", "2024-02-15", 92_076)], 2024);
    expect(overallTaxState(rep)).toBe("taxed");
  });

  it("no tax and every limit held is 'under'", () => {
    const rep = report([trade("BUY", "AAPL", "2025-06-02", 10_000), trade("SELL", "AAPL", "2026-03-02", 20_000)], 2026);
    expect(overallTaxState(rep)).toBe("under");
  });
});

describe("sale simulation follows the same rules", () => {
  it("a crypto sale counts against crypto's own limit, not the securities one", () => {
    const txs = [trade("BUY", "BTC", "2025-06-02", 20_000), trade("BUY", "AAPL", "2025-06-02", 20_000)];
    const f = runFifo(txs);
    const before = buildSalesReport(f.disposals, 2026, DEFAULT_TAX_SETTINGS, f.warnings);
    const sim = simulateSale(txs, before, { ticker: "BTC", broker: "T212", account: "A", shares: 1, priceUsd: 5_000, feeUsd: 0, at: "2026-10-16T12:00:00Z", saleFx: 20 }, DEFAULT_TAX_SETTINGS);
    expect(sim.kind).toBe("crypto");
    expect(sim.limitBaseAfterCzk).toBeCloseTo(100_000, 6);
    expect(sim.underLimitAfter).toBe(true);
    expect(sim.extraTaxCzk).toBe(0);
  });

  it("a crypto sale above the 40 mil. Kč cap adds the capped part's tax", () => {
    const txs = [trade("BUY", "BTC", "2020-03-02", 20_000_000)];
    const f = runFifo(txs);
    const before = buildSalesReport(f.disposals, 2026, DEFAULT_TAX_SETTINGS, f.warnings);
    const sim = simulateSale(txs, before, { ticker: "BTC", broker: "T212", account: "A", shares: 1, priceUsd: 2_500_000, feeUsd: 0, at: "2026-10-16T12:00:00Z", saleFx: 20 }, DEFAULT_TAX_SETTINGS);
    expect(sim.pieces[0].exempt).toBe(true);
    expect(sim.capTaxedShareAfter).toBeCloseTo(0.2, 12);
    expect(sim.extraTaxCzk!).toBeCloseTo(0.2 * 30_000_000 * 0.15, 2);
  });
});

describe("CSV", () => {
  it("names the asset kind and why a crypto row is taxable", () => {
    const rows = salesCsvRows(report([trade("BUY", "BTC", "2020-03-02", 45_052), trade("SELL", "BTC", "2024-02-15", 92_076)], 2024));
    const col = (name: string) => rows[1][rows[0].indexOf(name)];
    expect(col("Druh")).toBe("Krypto");
    expect(col("Status")).toBe("Zdanitelné (krypto před 15.2.2025, bez osvobození)");
    expect(rows.some((r) => r[0] === "Krypto – dílčí základ (CZK)" && r[1] === "47024,00")).toBe(true);
  });
});
