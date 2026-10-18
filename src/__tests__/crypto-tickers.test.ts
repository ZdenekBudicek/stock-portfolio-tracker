import { describe, it, expect } from "vitest";
import {
  CRYPTO_TICKERS,
  cryptoBase,
  isCryptoTicker,
  CRYPTO_TO_GECKO,
  CRYPTO_YAHOO,
  CRYPTO_TWELVEDATA,
  geckoId,
  yahooCryptoSymbol,
  twelveCryptoSymbol,
} from "../../supabase/functions/_shared/crypto.js";

// Bare crypto tickers that Yahoo (and Twelve Data) resolve to a REAL, unrelated security.
// Verified against Yahoo on 2026-08-10 — these are the collisions that poisoned
// price_history when a provider map missed and the code fell back to the bare ticker.
const COLLIDES_WITH_EQUITY: Record<string, string> = {
  LTC: "LTC Properties Inc (NYSE REIT, ~$40)",
  TRX: "TRX Gold Corp (NYSE American, ~$1)",
  ATOM: "Atomera Inc (NasdaqCM, ~$5.5)",
  APT: "Alpha Pro Tech Ltd (NYSE American, ~$5.3)",
  NEAR: "iShares Short Duration Bond Active ETF (~$50)",
  LINK: "Interlink Electronics Inc (NasdaqCM, ~$5.1)",
};

describe("cryptoBase / isCryptoTicker", () => {
  it("recognises a bare symbol", () => {
    expect(cryptoBase("BTC")).toBe("BTC");
    expect(isCryptoTicker("BTC")).toBe(true);
  });

  it("strips a USD suffix", () => {
    expect(cryptoBase("ETHUSD")).toBe("ETH");
    expect(cryptoBase("btcusd")).toBe("BTC");
  });

  it("is case-insensitive", () => {
    expect(cryptoBase("sol")).toBe("SOL");
  });

  it("returns null for a stock", () => {
    expect(cryptoBase("AAPL")).toBeNull();
    expect(isCryptoTicker("AAPL")).toBe(false);
  });

  it("returns null for empty / nullish input", () => {
    expect(cryptoBase("")).toBeNull();
    expect(cryptoBase(undefined as unknown as string)).toBeNull();
  });

  it("does not invent crypto by stripping USD off an unknown ticker", () => {
    expect(cryptoBase("FOOUSD")).toBeNull();
  });

  it("treats stablecoins as not-crypto (they are not priced as holdings)", () => {
    expect(cryptoBase("USDT")).toBeNull();
    expect(cryptoBase("USDC")).toBeNull();
  });

  it("exposes an immutable canonical set", () => {
    expect(Object.isFrozen(CRYPTO_TICKERS)).toBe(true);
    expect(CRYPTO_TICKERS).toHaveLength(17);
  });
});

// The actual bug class: three provider maps drifted to three different key sets
// (17 / 11 / 10), and a miss fell through to an equity lookup. Membership is now
// single-sourced, so every provider map must cover the canonical set exactly.
describe("provider maps cover the canonical key set", () => {
  const maps: Array<[string, Readonly<Record<string, string>>]> = [
    ["CoinGecko", CRYPTO_TO_GECKO],
    ["Yahoo", CRYPTO_YAHOO],
    ["TwelveData", CRYPTO_TWELVEDATA],
  ];

  for (const [name, map] of maps) {
    it(`${name} has an entry for every canonical symbol and no extras`, () => {
      expect(Object.keys(map).sort()).toEqual([...CRYPTO_TICKERS].sort());
    });

    it(`${name} is frozen`, () => {
      expect(Object.isFrozen(map)).toBe(true);
    });

    it(`${name} never maps a symbol to its own bare ticker`, () => {
      // A bare ticker is exactly what resolves to the wrong security. If a provider
      // format ever degenerates to the input, the collision is back.
      for (const [sym, value] of Object.entries<string>(map)) {
        expect(value, `${name}[${sym}]`).not.toBe(sym);
      }
    });
  }
});

describe("symbols that previously fell through to an equity", () => {
  for (const [sym, wrong] of Object.entries(COLLIDES_WITH_EQUITY)) {
    it(`${sym} is recognised as crypto (bare lookup would hit ${wrong})`, () => {
      expect(isCryptoTicker(sym)).toBe(true);
      expect(yahooCryptoSymbol(sym)).not.toBe(sym);
      expect(twelveCryptoSymbol(sym)).not.toBe(sym);
      expect(geckoId(sym)).toBeTruthy();
    });
  }

  it("resolves the six symbols the nightly worker was missing", () => {
    for (const sym of ["LTC", "TRX", "ATOM", "APT", "MATIC", "NEAR"]) {
      expect(yahooCryptoSymbol(sym), sym).toBeTruthy();
    }
    expect(yahooCryptoSymbol("LTC")).toBe("LTC-USD");
  });

  it("uses Yahoo's disambiguated symbols where the -USD form is another coin", () => {
    // APT-USD is "Apricot Finance" (~$0.0001), not Aptos. MATIC-USD is the dead
    // pre-rebrand Polygon symbol and returns zero daily bars. Verified 2026-08-10.
    expect(CRYPTO_YAHOO.APT).toBe("APT21794-USD");
    expect(CRYPTO_YAHOO.MATIC).toBe("POL28321-USD");
  });
});

describe("provider lookups fail loudly rather than falling back", () => {
  it("returns null for a non-crypto ticker instead of echoing it", () => {
    expect(yahooCryptoSymbol("AAPL")).toBeNull();
    expect(twelveCryptoSymbol("AAPL")).toBeNull();
    expect(geckoId("AAPL")).toBeNull();
  });

  it("resolves through a USD-suffixed alias", () => {
    expect(yahooCryptoSymbol("BTCUSD")).toBe("BTC-USD");
    expect(twelveCryptoSymbol("BTCUSD")).toBe("BTC/USD");
  });
});

describe("isCryptoHolding — the position type disambiguates a ticker", () => {
  it("treats the default type Stock as unknown (every position carries it); an explicit ETF is a security", async () => {
    const { isCryptoHolding } = await import("../../supabase/functions/_shared/crypto.js");
    expect(isCryptoHolding("LINK", "Stock")).toBe(true); // manual buy of the coin, default type
    expect(isCryptoHolding("LTC", "ETF")).toBe(false);
  });
  it("keeps crypto when typed Crypto or when the type is unknown", async () => {
    const { isCryptoHolding } = await import("../../supabase/functions/_shared/crypto.js");
    expect(isCryptoHolding("ATOM", "Crypto")).toBe(true);
    expect(isCryptoHolding("BTC", null)).toBe(true);
    expect(isCryptoHolding("ETHUSD", undefined)).toBe(true);
  });
  it("never makes an equity ticker crypto", async () => {
    const { isCryptoHolding } = await import("../../supabase/functions/_shared/crypto.js");
    expect(isCryptoHolding("AAPL", "Crypto")).toBe(false);
  });
});
