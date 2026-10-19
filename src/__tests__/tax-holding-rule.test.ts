import { describe, expect, it } from "vitest";
import { holdingProgress, holdingRuleFor } from "@/lib/tax/holdingRule";
import { overYear } from "@/lib/tax/common";
import { isTimeTestExempt } from "@/lib/czTax";
import type { TaxResidence } from "@/lib/tax/jurisdictions";

describe("holdingRuleFor", () => {
  it("CZ: securities and crypto tax-free after more than 3 years", () => {
    for (const kind of ["security", "crypto"] as const) {
      const r = holdingRuleFor("CZ", kind)!;
      expect(r).toMatchObject({ effect: "exempt", years: 3 });
      expect(r.qualifiesFrom("2023-05-10")).toBe("2026-05-11");
    }
  });

  it("DE: crypto tax-free after more than 1 year, stocks have no holding exemption", () => {
    expect(holdingRuleFor("DE", "crypto")).toMatchObject({ effect: "exempt", years: 1 });
    expect(holdingRuleFor("DE", "crypto")!.qualifiesFrom("2025-05-10")).toBe("2026-05-11");
    expect(holdingRuleFor("DE", "security")).toBeNull();
  });

  it("SK: securities tax-free after more than 1 year, crypto has no exemption", () => {
    expect(holdingRuleFor("SK", "security")).toMatchObject({ effect: "exempt", years: 1 });
    expect(holdingRuleFor("SK", "crypto")).toBeNull();
  });

  it("US: long-term after more than 1 year, never tax-free", () => {
    for (const kind of ["security", "crypto"] as const) expect(holdingRuleFor("US", kind)).toMatchObject({ effect: "long-term", years: 1 });
  });

  it("GB, PL and OTHER have no holding-period rule", () => {
    for (const c of ["GB", "PL", "OTHER"] as TaxResidence[])
      for (const kind of ["security", "crypto"] as const) expect(holdingRuleFor(c, kind)).toBeNull();
  });

  it("dates agree with the engines' own tests, leap day included", () => {
    const one = holdingRuleFor("US", "security")!, cz = holdingRuleFor("CZ", "security")!;
    for (const a of ["2024-02-29", "2025-01-01", "2025-12-31", "2024-03-01"]) {
      const f = one.qualifiesFrom(a);
      const dayBefore = new Date(Date.parse(`${f}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      expect(overYear(a, f)).toBe(true);
      expect(overYear(a, dayBefore)).toBe(false);
      const c = cz.qualifiesFrom(a);
      const czBefore = new Date(Date.parse(`${c}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      expect(isTimeTestExempt(a, c)).toBe(true);
      expect(isTimeTestExempt(a, czBefore)).toBe(false);
    }
    expect(one.qualifiesFrom("2024-02-29")).toBe("2025-03-01");
  });
});

describe("holdingProgress", () => {
  const lots = [
    { shares: 2, acquiredDate: "2025-01-10" },
    { shares: 1, acquiredDate: "2025-09-01" },
    { shares: 1, acquiredDate: "2026-03-01" },
  ];

  it("counts qualified shares and the next qualifying date", () => {
    const p = holdingProgress(lots, holdingRuleFor("DE", "crypto")!, "2026-10-19");
    expect(p).toEqual({ heldShares: 4, qualifiedShares: 3, qualifiedPct: 75, next: "2027-03-02" });
  });

  it("qualifies on the first day after the anniversary, not on it", () => {
    const rule = holdingRuleFor("US", "security")!;
    expect(holdingProgress([{ shares: 1, acquiredDate: "2025-10-19" }], rule, "2026-10-19").qualifiedShares).toBe(0);
    expect(holdingProgress([{ shares: 1, acquiredDate: "2025-10-19" }], rule, "2026-10-20").qualifiedShares).toBe(1);
  });

  it("all qualified → no next date; no lots → 0 %", () => {
    expect(holdingProgress(lots, holdingRuleFor("SK", "security")!, "2027-06-01")).toMatchObject({ qualifiedPct: 100, next: null });
    expect(holdingProgress([], holdingRuleFor("CZ", "security")!, "2026-10-19")).toEqual({ heldShares: 0, qualifiedShares: 0, qualifiedPct: 0, next: null });
  });
});
