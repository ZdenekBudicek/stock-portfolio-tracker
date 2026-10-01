import { describe, it, expect } from "vitest";
import {
  parseYahooQuotes,
  parseFinnhubQuote,
  parseTwelveData,
  parseStooqCsv,
  parseBinance,
  parseCoinGecko,
} from "../../supabase/functions/_shared/price-providers";

describe("parseYahooQuotes", () => {
  it("maps regularMarketPrice + previousClose to quotes", () => {
    const payload = { quoteResponse: { result: [
      { symbol: "AAPL", regularMarketPrice: 200, regularMarketPreviousClose: 190 },
    ] } };
    expect(parseYahooQuotes(payload).get("AAPL")).toEqual({ price: 200, prev: 190, pct: ((200 - 190) / 190) * 100 });
  });
  it("skips entries without a finite price", () => {
    const payload = { quoteResponse: { result: [{ symbol: "X", regularMarketPreviousClose: 10 }] } };
    expect(parseYahooQuotes(payload).size).toBe(0);
  });
});

describe("parseFinnhubQuote", () => {
  it("maps c/pc to a quote", () => {
    expect(parseFinnhubQuote("AAPL", { c: 200, pc: 190, dp: 5.26 })).toEqual({ price: 200, prev: 190, pct: 5.26 });
  });
  it("returns null when current price missing", () => {
    expect(parseFinnhubQuote("AAPL", { pc: 190 })).toBeNull();
  });
});

describe("parseTwelveData", () => {
  it("maps multi-symbol response", () => {
    const json = { AAPL: { close: "200", previous_close: "190" }, MSFT: { close: "400", previous_close: "390" } };
    const m = parseTwelveData(["AAPL", "MSFT"], json);
    expect(m.get("AAPL")).toEqual({ price: 200, prev: 190, pct: ((200 - 190) / 190) * 100 });
    expect(m.get("MSFT")!.price).toBe(400);
  });
  it("handles single-symbol (flat) response", () => {
    expect(parseTwelveData(["AAPL"], { close: "200", previous_close: "190" }).get("AAPL")!.price).toBe(200);
  });
  it("skips error rows", () => {
    expect(parseTwelveData(["BAD"], { BAD: { code: 400, message: "x" } }).size).toBe(0);
  });
});

describe("parseStooqCsv", () => {
  it("parses CSV and strips .US suffix; uses open as prev", () => {
    const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-06-22,22:00:02,190,206,189,200,1000";
    const m = parseStooqCsv(csv);
    expect(m.get("AAPL")).toEqual({ price: 200, prev: 190, pct: ((200 - 190) / 190) * 100 });
  });
  it("returns empty for header-only", () => {
    expect(parseStooqCsv("Symbol,Date,Time,Open,High,Low,Close,Volume").size).toBe(0);
  });
});

describe("parseBinance", () => {
  it("uses prevClosePrice when present", () => {
    expect(parseBinance("BTC", { lastPrice: "65000", prevClosePrice: "64000", priceChangePercent: "1.56" }))
      .toEqual({ price: 65000, prev: 64000, pct: 1.56 });
  });
  it("returns null without a price", () => {
    expect(parseBinance("BTC", { priceChangePercent: "1" })).toBeNull();
  });
});

describe("parseCoinGecko", () => {
  it("maps ticker->id and derives prev from 24h change", () => {
    const m = parseCoinGecko({ BTC: "bitcoin" }, { bitcoin: { usd: 101, usd_24h_change: 1 } });
    const q = m.get("BTC")!;
    expect(q.price).toBe(101);
    expect(q.pct).toBe(1);
    expect(q.prev).toBeCloseTo(101 / 1.01);
  });
});
