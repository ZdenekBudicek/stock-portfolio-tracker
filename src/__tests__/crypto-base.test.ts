import { describe, it, expect } from "vitest";
import { cryptoBase, CRYPTO_TO_GECKO } from "../../supabase/functions/_shared/crypto.js";

describe("cryptoBase", () => {
  it("rozpozná holý symbol", () => {
    expect(cryptoBase("BTC")).toBe("BTC");
  });
  it("odstraní příponu USD", () => {
    expect(cryptoBase("ETHUSD")).toBe("ETH");
  });
  it("je case-insensitive", () => {
    expect(cryptoBase("sol")).toBe("SOL");
  });
  it("vrací null pro akcii", () => {
    expect(cryptoBase("AAPL")).toBeNull();
  });
  it("vrací null pro prázdný vstup", () => {
    expect(cryptoBase("")).toBeNull();
  });
  it("neustřihne USD u neznámého symbolu", () => {
    // Guards the strip branch: a future "return stripped if non-empty" edit would
    // silently turn every *USD ticker into a fake crypto symbol.
    expect(cryptoBase("FOOUSD")).toBeNull();
  });
  it("zvládne malá písmena i s příponou zároveň", () => {
    expect(cryptoBase("btcusd")).toBe("BTC");
  });
  it("stablecoiny NEjsou rozpoznané — známá mezera", () => {
    // USDT/USDC don't end in a strippable "USD" suffix and aren't in the map, so
    // sync-sectors will send them to the stock-profile API and accumulate miss_count.
    // Pinned deliberately: adding them here would change how refresh-prices prices
    // them too, which is a separate decision.
    expect(cryptoBase("USDT")).toBeNull();
    expect(cryptoBase("USDC")).toBeNull();
  });
  it("mapa je zmrazená — sdílí ji tři konzumenti", () => {
    expect(Object.isFrozen(CRYPTO_TO_GECKO)).toBe(true);
  });
  it("mapa obsahuje gecko id pro každý symbol", () => {
    // Explicit type argument: tsconfig.app.json has no allowJs and includes only src/,
    // so TS never reads crypto.js and infers [string, unknown][] without it.
    for (const [sym, id] of Object.entries<string>(CRYPTO_TO_GECKO)) {
      expect(sym).toMatch(/^[A-Z0-9]+$/);
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
