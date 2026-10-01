import { describe, it, expect } from "vitest";
import {
  mapSector,
  TICKER_OVERRIDES,
  SECTOR_BUCKETS,
  TRANSLATIONS,
  INDUSTRY_RULES,
} from "../../supabase/functions/_shared/sectors.js";

// Yahoo gives sector + industry; Finnhub gives only a coarse industry string.
const yahoo = (ticker: string, sectorRaw: string, industryRaw: string) =>
  mapSector({ ticker, sectorRaw, industryRaw, assetType: "EQUITY" });
const finnhub = (ticker: string, industryRaw: string) =>
  mapSector({ ticker, sectorRaw: null, industryRaw, assetType: "EQUITY" });

describe("mapSector — aktuální portfolio, cesta přes Yahoo", () => {
  it("META → Technologie (override, ne Komunikace)", () => {
    expect(yahoo("META", "Communication Services", "Internet Content & Information")).toBe("Technologie");
  });
  it("GOOGL → Technologie (override)", () => {
    expect(yahoo("GOOGL", "Communication Services", "Internet Content & Information")).toBe("Technologie");
  });
  it("RKLB → Letectví & obrana (pravidlo podle industry, ne Průmysl)", () => {
    expect(yahoo("RKLB", "Industrials", "Aerospace & Defense")).toBe("Letectví & obrana");
  });
  it("NBIS → Technologie (překlad sektoru)", () => {
    expect(yahoo("NBIS", "Technology", "Software - Infrastructure")).toBe("Technologie");
  });
  it("SOFI → Fintech (pravidlo Credit Services)", () => {
    expect(yahoo("SOFI", "Financial Services", "Credit Services")).toBe("Fintech");
  });
  it("NU → Fintech (override vyhrává nad pravidlem Banks)", () => {
    expect(yahoo("NU", "Financial Services", "Banks - Regional")).toBe("Fintech");
  });
  it("TSLA → Automotive", () => {
    expect(yahoo("TSLA", "Consumer Cyclical", "Auto Manufacturers")).toBe("Automotive");
  });
  it("MELI → Spotřební zboží (překlad sektoru)", () => {
    expect(yahoo("MELI", "Consumer Cyclical", "Internet Retail")).toBe("Spotřební zboží");
  });
});

describe("mapSector — aktuální portfolio, cesta přes Finnhub", () => {
  it("META → Technologie i když Finnhub řekne jen Media", () => {
    expect(finnhub("META", "Media")).toBe("Technologie");
  });
  it("RKLB → Letectví & obrana", () => {
    expect(finnhub("RKLB", "Aerospace & Defense")).toBe("Letectví & obrana");
  });
  it("NBIS → Technologie", () => {
    expect(finnhub("NBIS", "Technology")).toBe("Technologie");
  });
  it("SOFI → Fintech (Financial Services jako industry znamená fintech)", () => {
    expect(finnhub("SOFI", "Financial Services")).toBe("Fintech");
  });
  it("TSLA → Automotive", () => {
    expect(finnhub("TSLA", "Automobiles")).toBe("Automotive");
  });
  it("MELI → Spotřební zboží", () => {
    expect(finnhub("MELI", "Retail")).toBe("Spotřební zboží");
  });
});

describe("mapSector — Yahoo sektor Financial Services není fintech", () => {
  it("JPM → Bankovnictví (pravidla kroku 2 běží jen na industry)", () => {
    expect(yahoo("JPM", "Financial Services", "Banks - Diversified")).toBe("Bankovnictví");
  });
  it("Finnhub Banking → Bankovnictví", () => {
    expect(finnhub("JPM", "Banking")).toBe("Bankovnictví");
  });
});

describe("mapSector — typ instrumentu", () => {
  it("ETF vyhrává nad vším ostatním", () => {
    expect(mapSector({ ticker: "SPY", sectorRaw: null, industryRaw: null, assetType: "ETF" })).toBe("ETF");
  });
  it("krypto vyhrává nad vším ostatním", () => {
    expect(mapSector({ ticker: "BTC", sectorRaw: null, industryRaw: null, assetType: "CRYPTO" })).toBe("Krypto");
  });
  it("override tickeru vyhrává i nad typem", () => {
    expect(mapSector({ ticker: "NU", sectorRaw: null, industryRaw: null, assetType: "ETF" })).toBe("Fintech");
  });
});

describe("mapSector — degradace", () => {
  it("prázdný vstup vrací null, ne výjimku", () => {
    expect(mapSector({})).toBeNull();
  });
  it("nezname hodnoty vrací null", () => {
    expect(yahoo("XYZ", "Something Made Up", "Also Made Up")).toBeNull();
  });
  it("undefined argument vrací null", () => {
    expect(mapSector()).toBeNull();
  });
  it("case a whitespace nerozhodují", () => {
    expect(yahoo("NBIS", "  TECHNOLOGY  ", "")).toBe("Technologie");
  });
});

describe("TICKER_OVERRIDES", () => {
  it("zůstává malý — je to seznam výjimek, ne číselník", () => {
    expect(Object.keys(TICKER_OVERRIDES).length).toBeLessThanOrEqual(10);
  });
});

describe("mapSector — 'Capital Markets' rozlišení (regrese proti src/lib/sectors.ts)", () => {
  it("GS → Bankovnictví (investiční banka, ne fintech)", () => {
    expect(yahoo("GS", "Financial Services", "Capital Markets")).toBe("Bankovnictví");
  });
  it("MS → Bankovnictví (investiční banka, ne fintech)", () => {
    expect(yahoo("MS", "Financial Services", "Capital Markets")).toBe("Bankovnictví");
  });
  it("COIN → Fintech (pravidlo financial data nesmí se rozbít)", () => {
    expect(yahoo("COIN", "Financial Services", "Financial Data & Stock Exchanges")).toBe("Fintech");
  });
  it("SOFI přes Finnhub → Fintech (tvrdý požadavek, nesmí se rozbít)", () => {
    expect(finnhub("SOFI", "Financial Services")).toBe("Fintech");
  });
});

describe("mapSector — bitcoin miners a treasury společnosti (ticker overrides)", () => {
  it("MARA → Krypto (industry Capital Markets, ale je to miner)", () => {
    expect(yahoo("MARA", "Financial Services", "Capital Markets")).toBe("Krypto");
  });
  it("RIOT → Krypto (industry Capital Markets, ale je to miner)", () => {
    expect(yahoo("RIOT", "Financial Services", "Capital Markets")).toBe("Krypto");
  });
  it("MSTR → Krypto (bitcoin treasury company, ne software firma)", () => {
    expect(yahoo("MSTR", "Technology", "Software - Infrastructure")).toBe("Krypto");
  });
  it("HOOD → Fintech (retailová brokerage, patří k SOFI, ne ke GS)", () => {
    expect(yahoo("HOOD", "Financial Services", "Capital Markets")).toBe("Fintech");
  });
});

describe("SECTOR_BUCKETS — invariant výstupu", () => {
  it("každá hodnota v TRANSLATIONS je platný bucket", () => {
    for (const bucket of Object.values(TRANSLATIONS)) {
      expect(SECTOR_BUCKETS).toContain(bucket);
    }
  });
  it("každá hodnota v INDUSTRY_RULES je platný bucket", () => {
    for (const [, bucket] of INDUSTRY_RULES) {
      expect(SECTOR_BUCKETS).toContain(bucket);
    }
  });
  it("každá hodnota v TICKER_OVERRIDES je platný bucket", () => {
    for (const bucket of Object.values(TICKER_OVERRIDES)) {
      expect(SECTOR_BUCKETS).toContain(bucket);
    }
  });
  it("každý klíč v TICKER_OVERRIDES je už normalizovaný (trim + uppercase)", () => {
    for (const key of Object.keys(TICKER_OVERRIDES)) {
      expect(key).toBe(key.trim().toUpperCase());
    }
  });
});

describe("mapSector — normalizace assetType", () => {
  it("'etf' malými písmeny funguje stejně jako 'ETF'", () => {
    expect(mapSector({ ticker: "SPY", sectorRaw: null, industryRaw: null, assetType: "etf" })).toBe("ETF");
  });
  it("' Etf ' s mezerami a smíšeným caseem funguje stejně", () => {
    expect(mapSector({ ticker: "SPY", sectorRaw: null, industryRaw: null, assetType: " Etf " })).toBe("ETF");
  });
  it("'crypto' malými písmeny funguje stejně jako 'CRYPTO'", () => {
    expect(mapSector({ ticker: "BTC", sectorRaw: null, industryRaw: null, assetType: "crypto" })).toBe("Krypto");
  });
});

describe("mapSector — bezpečnost proti prototype pollution", () => {
  it("sectorRaw 'constructor' vrací null, ne Object konstruktor", () => {
    expect(yahoo("ZZZ", "constructor", "")).toBeNull();
  });
  it("sectorRaw '__proto__' vrací null, ne Object.prototype", () => {
    expect(yahoo("ZZZ", "__proto__", "")).toBeNull();
  });
  it("industryRaw 'constructor' vrací null", () => {
    expect(yahoo("ZZZ", "", "constructor")).toBeNull();
  });
  it("industryRaw '__proto__' vrací null", () => {
    expect(yahoo("ZZZ", "", "__proto__")).toBeNull();
  });
  it("ticker 'constructor' vrací null, ne Object konstruktor z TICKER_OVERRIDES", () => {
    expect(mapSector({ ticker: "constructor", assetType: "EQUITY" })).toBeNull();
  });
});

describe("mapSector — nové Finnhub překlady", () => {
  it("'Oil & Gas' → Energetika", () => {
    expect(finnhub("XOM", "Oil & Gas")).toBe("Energetika");
  });
  it("'Software' → Technologie", () => {
    expect(finnhub("CRM", "Software")).toBe("Technologie");
  });
  it("'Airlines' → Průmysl", () => {
    expect(finnhub("DAL", "Airlines")).toBe("Průmysl");
  });
});
