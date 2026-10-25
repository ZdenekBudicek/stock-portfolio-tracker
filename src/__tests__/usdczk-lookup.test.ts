import { describe, it, expect } from "vitest";
import { makeRateLookup } from "@/lib/fxLookup";

describe("makeRateLookup (T212 CZK -> USD)", () => {
  const rows = [
    { date: "2011-08-10", close: 17.181 },
    { date: "2023-09-12", close: 22.9 },
    { date: "2023-09-13", close: 23.05 },
    { date: "2026-10-16", close: "21.63" },
  ];
  const fx = makeRateLookup(rows);
  it("uses the rate of the day, or the last one before it", () => {
    expect(fx("2023-09-13")).toBe(23.05);
    expect(fx("2023-09-14")).toBe(23.05);
    expect(fx("2026-10-17")).toBe(21.63);
  });
  it("never answers a 2023 date with a 2011 rate (the 1000-row cap bug)", () => {
    expect(fx("2023-09-13")).not.toBe(17.181);
  });
  it("does not use a future rate", () => {
    expect(fx("2005-01-01")).toBeNaN();
  });
  it("reports missing history", () => {
    expect(makeRateLookup([])("2024-01-01")).toBeNaN();
  });
});
