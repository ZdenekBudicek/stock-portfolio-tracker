import { describe, it, expect } from "vitest";
import { assetType, mkProfileRow, rankTicker, yahooQuerySymbol } from "../../scripts/sector-worker.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-10T05:30:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("rankTicker — what the nightly Yahoo pass picks up", () => {
  it("a ticker with no row at all is the highest priority", () => {
    expect(rankTicker(undefined, NOW)).toBe(1);
  });

  it("re-fetches a finnhub-resolved row at ANY age — the whole point of the worker", () => {
    // The edge function guessed this from one coarse industry string; Yahoo refines it.
    const row = { sector: "Technologie", source: "finnhub", yahoo_miss_count: 0, fetched_at: ago(0.01) };
    expect(rankTicker(row, NOW)).toBe(2);
  });

  it("leaves a fresh yahoo-resolved row alone", () => {
    const row = { sector: "Technologie", source: "yahoo", yahoo_miss_count: 0, fetched_at: ago(1) };
    expect(rankTicker(row, NOW)).toBe(-1);
  });

  it("refreshes a yahoo-resolved row once it passes 90 days", () => {
    const row = { sector: "Technologie", source: "yahoo", yahoo_miss_count: 0, fetched_at: ago(91) };
    expect(rankTicker(row, NOW)).toBe(4);
  });

  it("stops asking after 5 empty Yahoo answers", () => {
    const row = { sector: null, source: "yahoo", yahoo_miss_count: 5, fetched_at: ago(400) };
    expect(rankTicker(row, NOW)).toBe(-1);
  });

  it("holds off while the 2^misses-day backoff is still running", () => {
    const row = { sector: null, source: "yahoo", yahoo_miss_count: 2, fetched_at: ago(3) }; // needs 4
    expect(rankTicker(row, NOW)).toBe(-1);
  });

  it("retries once the backoff has elapsed", () => {
    const row = { sector: null, source: "yahoo", yahoo_miss_count: 2, fetched_at: ago(5) }; // needs 4
    expect(rankTicker(row, NOW)).toBe(3);
  });

  it("the backoff outranks 'refine a finnhub row at any age'", () => {
    // Otherwise a symbol Yahoo simply does not know would be asked about every single night
    // for ever, and yahoo_miss_count — the column that exists for exactly these rows — would
    // never gate anything.
    const row = { sector: "Fintech", source: "finnhub", yahoo_miss_count: 1, fetched_at: ago(1) };
    expect(rankTicker(row, NOW)).toBe(-1);
    expect(rankTicker({ ...row, fetched_at: ago(3) }, NOW)).toBe(3);
  });

  it("never consults finnhub_miss_count", () => {
    // The two counters exist so one provider's outage cannot suppress the other's retries.
    const row = { sector: null, source: "finnhub", yahoo_miss_count: 0, finnhub_miss_count: 9, fetched_at: ago(0.01) };
    expect(rankTicker(row, NOW)).toBe(2);
  });

  it("treats an unparseable fetched_at as infinitely old rather than freezing the row", () => {
    const row = { sector: "Technologie", source: "yahoo", yahoo_miss_count: 0, fetched_at: "not a date" };
    expect(rankTicker(row, NOW)).toBe(4);
  });
});

describe("yahooQuerySymbol", () => {
  // ~18 seeded ticker_alias rows have canonical = alias, with the only resolvable symbol in
  // yahoo_symbol. The map is keyed on the UPPER-CASED canonical because that is what the
  // ticker_profiles row is keyed on, while ticker_alias stores 'BATSl'.
  const map = new Map([["BATSL", "BATS.L"], ["ELF_EQ_US", "ELF"], ["BRK_B", "BRK-B"]]);

  it("prefers ticker_alias.yahoo_symbol", () => {
    expect(yahooQuerySymbol("BATSL", map)).toBe("BATS.L");
    expect(yahooQuerySymbol("BRK_B", map)).toBe("BRK-B");
  });
  it("matches the map case-insensitively via the canonical upper-casing", () => {
    expect(yahooQuerySymbol("batsl", map)).toBe("BATS.L");
  });
  it("falls back to price-worker's heuristic when there is no alias row", () => {
    expect(yahooQuerySymbol("FOO_US_EQ", map)).toBe("FOO");
    expect(yahooQuerySymbol("FOO_EQ", map)).toBe("FOO");
    expect(yahooQuerySymbol("BRK.B", map)).toBe("BRK-B");
    expect(yahooQuerySymbol("AAPL", map)).toBe("AAPL");
  });
  it("does NOT invent a stripping rule the price worker does not have", () => {
    // The suffix in the seeded rows is _EQ_US, not _US_EQ, and the heuristic deliberately
    // leaves it alone — resolving it is ticker_alias.yahoo_symbol's job (ELF_EQ_US -> ELF).
    // Widening the regex here would send Yahoo a symbol nobody verified.
    expect(yahooQuerySymbol("FOO_EQ_US", map)).toBe("FOO_EQ_US");
  });
  it("survives an empty map", () => {
    expect(yahooQuerySymbol("AAPL", new Map())).toBe("AAPL");
  });
});

describe("mkProfileRow", () => {
  const yahooQuoteSummary = { ticker: "NBIS", name: null, sectorRaw: "Technology", industryRaw: "Software - Infrastructure", assetType: "EQUITY" };
  const finnhubRow = { ticker: "NBIS", name: "Nebius Group", sector_raw: null, industry_raw: "Technology", sector: "Technologie", asset_type: "EQUITY", source: "finnhub", fetched_at: ago(1) };
  const at = new Date(NOW).toISOString();

  it("does NOT null out a name it did not fetch", () => {
    // parseYahooProfile returns name:null on the quoteSummary branch — Yahoo's assetProfile
    // module has no name field. This worker re-fetches every source='finnhub' row, so a naive
    // `name: profile.name` wipes every name the edge function wrote on the very first run.
    const row = mkProfileRow("NBIS", yahooQuoteSummary, finnhubRow, { sector: "Technologie", source: "yahoo", missCount: 0, at });
    expect(row.name).toBe("Nebius Group");
    expect(row.sector_raw).toBe("Technology"); // fresh value wins where there IS one
    expect(row.source).toBe("yahoo");
    expect(row.yahoo_miss_count).toBe(0);
  });

  it("prefers a freshly fetched name over the stored one", () => {
    const searchShape = { ...yahooQuoteSummary, name: "Nebius Group N.V." };
    expect(mkProfileRow("NBIS", searchShape, finnhubRow, { sector: "Technologie", source: "yahoo", missCount: 0, at }).name)
      .toBe("Nebius Group N.V.");
  });

  it("never demotes a resolved sector back to null", () => {
    const row = mkProfileRow("NBIS", null, finnhubRow, { sector: null, source: null, missCount: 1, at });
    expect(row.sector).toBe("Technologie");
    expect(row.source).toBe("finnhub");
  });

  it("carries the stored asset_type forward rather than defaulting an ETF to EQUITY", () => {
    const etf = { ...finnhubRow, asset_type: "ETF", sector: "ETF" };
    expect(mkProfileRow("VUAA", null, etf, { missCount: 1, at }).asset_type).toBe("ETF");
  });

  it("writes nothing at all for a brand-new unresolved ticker", () => {
    const row = mkProfileRow("XYZ", null, undefined, { sector: null, source: null, missCount: 1, at });
    expect(row).toEqual({
      ticker: "XYZ", name: null, sector_raw: null, industry_raw: null, sector: null,
      asset_type: "EQUITY", source: null, yahoo_miss_count: 1, fetched_at: at,
    });
  });

  it("NEVER carries finnhub_miss_count in the payload", () => {
    // A PostgREST upsert only writes the columns present in the payload, so leaving this one
    // out is what keeps the other provider's backoff out of this job's hands.
    for (const row of [
      mkProfileRow("NBIS", yahooQuoteSummary, finnhubRow, { sector: "Technologie", source: "yahoo", missCount: 0, at }),
      mkProfileRow("XYZ", null, undefined, { missCount: 1, at }),
    ]) {
      expect(row).not.toHaveProperty("finnhub_miss_count");
    }
  });

  it("gives every row the identical key set — PostgREST rejects a ragged batch", () => {
    const a = Object.keys(mkProfileRow("A", yahooQuoteSummary, finnhubRow, { sector: "Technologie", source: "yahoo", missCount: 0, at })).sort();
    const b = Object.keys(mkProfileRow("B", null, undefined, { missCount: 3, at })).sort();
    expect(a).toEqual(b);
  });
});

describe("assetType", () => {
  it("passes the three values the CHECK constraint accepts", () => {
    for (const v of ["EQUITY", "ETF", "CRYPTO"]) expect(assetType(v)).toBe(v);
  });
  it("normalises case and whitespace", () => {
    expect(assetType(" etf ")).toBe("ETF");
  });
  it("falls back to EQUITY for anything else — one bad value aborts the whole upsert", () => {
    for (const v of ["MUTUALFUND", "", null, undefined, 7, {}]) expect(assetType(v)).toBe("EQUITY");
  });
});
