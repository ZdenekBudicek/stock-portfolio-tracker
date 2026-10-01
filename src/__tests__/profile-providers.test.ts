import { describe, it, expect } from "vitest";
import { finnhubFetchResult, parseFinnhubProfile, parseYahooProfile } from "../../supabase/functions/_shared/profile-providers";

describe("parseFinnhubProfile", () => {
  it("maps finnhubIndustry to industryRaw and leaves sectorRaw null", () => {
    expect(parseFinnhubProfile("NBIS", { name: "Nebius Group", finnhubIndustry: "Technology" }))
      .toEqual({ ticker: "NBIS", name: "Nebius Group", sectorRaw: null, industryRaw: "Technology", assetType: "EQUITY" });
  });
  it("returns null for the empty object Finnhub sends for ETFs and unknown symbols", () => {
    expect(parseFinnhubProfile("SPY", {})).toBeNull();
  });
  it("returns null when finnhubIndustry is missing", () => {
    expect(parseFinnhubProfile("X", { name: "X" })).toBeNull();
  });
  it("returns null on a non-object payload", () => {
    expect(parseFinnhubProfile("X", null)).toBeNull();
  });
});

describe("parseYahooProfile", () => {
  const payload = (profile: unknown) => ({ quoteSummary: { result: [{ assetProfile: profile }] } });

  it("maps sector and industry", () => {
    expect(parseYahooProfile("MELI", payload({ sector: "Consumer Cyclical", industry: "Internet Retail" })))
      .toEqual({ ticker: "MELI", name: null, sectorRaw: "Consumer Cyclical", industryRaw: "Internet Retail", assetType: "EQUITY" });
  });
  it("returns null when the result array is empty", () => {
    expect(parseYahooProfile("X", { quoteSummary: { result: [] } })).toBeNull();
  });
  it("returns null when assetProfile carries neither sector nor industry", () => {
    expect(parseYahooProfile("X", payload({ country: "US" }))).toBeNull();
  });
  it("returns null on an error envelope", () => {
    expect(parseYahooProfile("X", { quoteSummary: { result: null, error: "Not Found" } })).toBeNull();
  });
});

describe("parseYahooProfile — search fallback shape", () => {
  it("maps a quotes[] entry when quoteSummary is unavailable", () => {
    const json = { quotes: [{ symbol: "NBIS", sector: "Technology", industry: "Software - Infrastructure", quoteType: "EQUITY", shortname: "Nebius" }] };
    expect(parseYahooProfile("NBIS", json))
      .toEqual({ ticker: "NBIS", name: "Nebius", sectorRaw: "Technology", industryRaw: "Software - Infrastructure", assetType: "EQUITY" });
  });
  it("picks up ETF quoteType", () => {
    const json = { quotes: [{ symbol: "SPY", quoteType: "ETF", shortname: "SPDR S&P 500" }] };
    expect(parseYahooProfile("SPY", json)?.assetType).toBe("ETF");
  });
  it("ignores quotes for a different symbol", () => {
    const json = { quotes: [{ symbol: "OTHER", sector: "Technology", quoteType: "EQUITY" }] };
    expect(parseYahooProfile("NBIS", json)).toBeNull();
  });
  it("finds the exact match inside a realistic multi-entry response", () => {
    // The worker calls ?quotesCount=5, so production payloads are mixed arrays where the
    // match is rarely first and siblings may be junk. Guards against a future
    // "just take quotes[0]" simplification, which would still pass every test above
    // while silently returning the wrong company for NU vs NUE vs NUVL.
    const json = { quotes: [
      null,
      { symbol: "NUE", sector: "Basic Materials", industry: "Steel", quoteType: "EQUITY", shortname: "Nucor" },
      "junk",
      { symbol: "NU", sector: "Financial Services", industry: "Banks - Regional", quoteType: "EQUITY", shortname: "Nu Holdings" },
      { symbol: "NUVL", sector: "Healthcare", industry: "Biotechnology", quoteType: "EQUITY" },
    ] };
    expect(parseYahooProfile("NU", json)).toEqual({
      ticker: "NU", name: "Nu Holdings", sectorRaw: "Financial Services",
      industryRaw: "Banks - Regional", assetType: "EQUITY",
    });
  });
  it("matches the symbol case-insensitively", () => {
    const json = { quotes: [{ symbol: "nbis", sector: "Technology", quoteType: "EQUITY" }] };
    expect(parseYahooProfile("NBIS", json)?.sectorRaw).toBe("Technology");
  });
  it("nevyhodí výjimku na chybějícím tickeru", () => {
    // The nightly worker is plain JS; a throw in its loop would abort the whole batch.
    const json = { quotes: [{ symbol: "NBIS", sector: "Technology", quoteType: "EQUITY" }] };
    expect(parseYahooProfile(undefined as unknown as string, json)).toBeNull();
  });
});

describe("finnhubFetchResult", () => {
  const profile = { ticker: "NBIS", name: "Nebius", sectorRaw: null, industryRaw: "Technology", assetType: "EQUITY" } as const;

  it("200 with a parsed profile is ok", () => {
    expect(finnhubFetchResult(200, { ...profile })).toEqual({ status: "ok", profile: { ...profile } });
  });
  it("200 with nothing parsed is empty — the only case that counts against the symbol", () => {
    // Finnhub answers 200 {} for ETFs and symbols it does not know.
    expect(finnhubFetchResult(200, null)).toEqual({ status: "empty" });
  });

  // The whole point of the type. sync-sectors increments finnhub_miss_count on "empty" and
  // gives up at 5, so anything below being misread as "empty" freezes a ticker out of the
  // sector chart permanently on the strength of a bad afternoon at the provider.
  it("429 is an error, NOT an empty answer", () => {
    expect(finnhubFetchResult(429, null)).toEqual({ status: "error", detail: "HTTP 429" });
  });
  it.each([500, 502, 503])("%i is an error", (code) => {
    expect(finnhubFetchResult(code, null).status).toBe("error");
  });
  it("401 is an error — a bad or out-of-plan key is not the symbol's fault", () => {
    expect(finnhubFetchResult(401, null).status).toBe("error");
  });
  it("404 is an error — Finnhub does not use it to mean 'unknown symbol'", () => {
    expect(finnhubFetchResult(404, null).status).toBe("error");
  });
  it("no non-2xx status is ever empty", () => {
    for (const code of [301, 400, 401, 403, 404, 418, 429, 500, 503, 504]) {
      expect(finnhubFetchResult(code, null).status).toBe("error");
      // even if a body somehow parsed, a non-2xx answer is not trustworthy
      expect(finnhubFetchResult(code, { ...profile }).status).toBe("error");
    }
  });
});

describe("parseFinnhubProfile — the string that must not become a sector", () => {
  it("SOFI's Financial Services stays in industryRaw", () => {
    // If this ever lands in sectorRaw, mapSector translates it to Bankovnictví and SOFI
    // silently becomes a bank. This is the exact input that breaks the asymmetry.
    expect(parseFinnhubProfile("SOFI", { finnhubIndustry: "Financial Services" }))
      .toEqual({ ticker: "SOFI", name: null, sectorRaw: null, industryRaw: "Financial Services", assetType: "EQUITY" });
  });
});
