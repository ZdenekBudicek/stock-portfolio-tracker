import { afterEach, describe, expect, it, vi } from "vitest";
import { computeInternationalTaxModel } from "@/lib/internationalTaxModel";
import { parseStoredProfiles, profileKey } from "@/lib/taxProfiles";
import { resolveTaxIdentity } from "@/lib/instrumentRegistry";
import { buildTaxInput } from "@/lib/tax/appInput";
import { taxEngineFor, type Country } from "@/lib/tax/engines";
import { createInternationalFixture } from "@/test/agentPortfolioFixture";
import * as taxFx from "@/lib/tax/fx";

afterEach(() => vi.restoreAllMocks());

describe("international tax model", () => {
  it.each<Country>(["SK", "PL", "DE", "GB", "US"])("preserves the complete %s engine input and report", country => {
    const fixture = createInternationalFixture(country);
    // Independent identity functions reproduce the original UI for this stock-only fixture.
    const input = buildTaxInput({ ...fixture, profile: fixture.storedProfiles.profiles[`${country}-2026`],
      kindOf: () => "stock", canonical: t => t.toUpperCase() });
    const result = computeInternationalTaxModel(fixture);
    expect(result).toEqual({ status: "ready", input, report: taxEngineFor(country).report(input) });
    if (result.status !== "ready") throw new Error(result.reason);
    expect(result.report).toHaveProperty("healthContributions");
    expect(result.report).toHaveProperty("fxMode");
    expect(result.report).toHaveProperty("complete");
    if (country === "SK") expect(result.report.currency).toBe("EUR");
  });

  it("distinguishes missing profile, unsupported residence, and unsupported year", () => {
    const fixture = createInternationalFixture();
    expect(computeInternationalTaxModel({ ...fixture, storedProfiles: null }).status).toBe("missing_profile");
    expect(computeInternationalTaxModel({ ...fixture, residence: "OTHER" }).status).toBe("unsupported");
    expect(computeInternationalTaxModel({ ...fixture, year: 2027 }).status).toBe("invalid");
    expect(computeInternationalTaxModel({ ...fixture, transactions: [{ ...fixture.transactions[0], shares: -1 }] }).status).toBe("invalid");
  });

  it("preserves nonzero Slovak health contributions and estimate provenance", () => {
    vi.spyOn(taxFx, "cnbTaxFx").mockImplementation(date => ({ rate: 1, ref: date, source: "synthetic", statutory: false }));
    const fixture = createInternationalFixture();
    fixture.transactions[0] = { ...fixture.transactions[0], executed_at: "2026-01-02T12:00:00Z" };
    fixture.transactions[1] = { ...fixture.transactions[1], price_usd: 350 };
    const result = computeInternationalTaxModel({ ...fixture, dividends: [] });
    if (result.status !== "ready") throw new Error(result.reason);
    expect(result.report).toMatchObject({ currency: "EUR", healthContributions: 80, fxMode: "cnb-estimate", complete: true });
    expect(result.report.warnings).toContainEqual(expect.objectContaining({ code: "incomplete-ledger", blocking: false }));
  });

  it("validates the nested country/year key without inventing defaults", () => {
    const fixture = createInternationalFixture();
    const profile = fixture.storedProfiles.profiles["SK-2026"];
    expect(profileKey("SK", 2026)).toBe("SK-2026");
    expect(parseStoredProfiles(fixture.storedProfiles)).toEqual({ "SK-2026": profile });
    for (const raw of [null, [], "bad", { profiles: [] }, { profiles: { "SK-2025": profile } },
      { profiles: { "SK-2026": { ...profile, healthInsurance: undefined } } }, { "SK-2026": profile }]) {
      expect(parseStoredProfiles(raw)).toEqual({});
    }
  });

  it.each<Country>(["US", "GB"])("retains %s post-year purchases and provisional warnings", country => {
    const fixture = createInternationalFixture(country);
    const end = country === "US" ? "2026-12-31" : "2027-04-05";
    const next = country === "US" ? "2027-01-15" : "2027-04-20";
    fixture.transactions = [
      { ...fixture.transactions[0], executed_at: "2026-05-01T12:00:00Z" },
      { ...fixture.transactions[1], executed_at: `${end}T12:00:00Z`, price_usd: 80 },
      { ...fixture.transactions[0], id: "replacement", executed_at: `${next}T12:00:00Z` },
    ];
    const open = computeInternationalTaxModel({ ...fixture, today: next });
    if (open.status !== "ready") throw new Error(open.reason);
    expect(open.input.trades.map(t => t.id)).toContain("replacement");
    expect(open.report.warnings).toContainEqual(expect.objectContaining({ code: "incomplete-ledger", blocking: false }));
    const closed = computeInternationalTaxModel({ ...fixture, today: "2027-06-01" });
    if (closed.status !== "ready") throw new Error(closed.reason);
    expect(closed.input.provisional).toBe(false);
    expect(closed.report.warnings.some(w => w.code === "incomplete-ledger")).toBe(false);
  });

  it("retains crypto precedence, closed ETFs, and canonical aliases", () => {
    const fixture = createInternationalFixture();
    const registry = { ...fixture.registry,
      positions: [{ ...fixture.registry.positions[0], ticker: "COIN", type: "Crypto" }],
      profiles: [{ ticker: "LTC", asset_type: "ETF" }, { ticker: "FUND", asset_type: "ETF" }, { ticker: "COIN", asset_type: "ETF" }],
      aliases: [{ alias: "OLD", canonical: "FUND", yahoo_symbol: null }] };
    const identity = resolveTaxIdentity(registry);
    expect(identity.kindOf("COIN")).toBe("crypto");
    expect(identity.kindOf("LTC")).toBe("etf");
    expect(identity.kindOf("OLD")).toBe("etf");
    expect(identity.canonical("old")).toBe("FUND");
    expect(identity.canonical("syn")).toBe("SYN");
  });
});
