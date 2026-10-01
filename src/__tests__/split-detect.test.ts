import { describe, it, expect } from "vitest";
import { parseFinnhubSplits } from "../../supabase/functions/detect-splits/parse";

describe("parseFinnhubSplits", () => {
  it("converts a forward split (fromFactor/toFactor) to ratio", () => {
    const rows = [{ symbol: "AAPL", date: "2026-06-22", fromFactor: 1, toFactor: 4 }];
    expect(parseFinnhubSplits("AAPL", rows)).toEqual([
      { ticker: "AAPL", split_date: "2026-06-22", ratio: 4, status: "pending", source: "finnhub" },
    ]);
  });
  it("handles reverse splits (ratio < 1)", () => {
    const rows = [{ symbol: "XYZ", date: "2026-06-22", fromFactor: 10, toFactor: 1 }];
    expect(parseFinnhubSplits("XYZ", rows)[0].ratio).toBeCloseTo(0.1);
  });
  it("ignores malformed rows (missing/zero factors or no date)", () => {
    const rows = [
      { symbol: "A", date: "2026-06-22", fromFactor: 0, toFactor: 4 },
      { symbol: "B", fromFactor: 1, toFactor: 4 },
      { symbol: "C", date: "2026-06-22", fromFactor: 1 },
    ];
    expect(parseFinnhubSplits("A", rows)).toEqual([]);
  });
  it("returns empty for no rows", () => {
    expect(parseFinnhubSplits("A", [])).toEqual([]);
  });
});
