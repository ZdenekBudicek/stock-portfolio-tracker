// Crypto ticker recognition, shared by refresh-prices (which needs CoinGecko ids) and
// sync-sectors (which only needs to know "this is not a stock, don't call the profile API").
// Plain JS so Deno edge functions and Node scripts can both import it.

// The JSDoc type is load-bearing for TypeScript consumers: without it, TS widens the
// frozen literal's values and Object.entries() yields [string, unknown][], so callers
// cannot use the gecko id as a string.
/** @type {Readonly<Record<string, string>>} */
export const CRYPTO_TO_GECKO = Object.freeze({
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", ADA: "cardano",
  DOGE: "dogecoin", DOT: "polkadot", AVAX: "avalanche-2", LINK: "chainlink",
  BNB: "binancecoin", EGLD: "elrond-erd-2", LTC: "litecoin", TRX: "tron",
  MATIC: "matic-network", ATOM: "cosmos", NEAR: "near", APT: "aptos",
});

/**
 * @param {string} t broker ticker, e.g. "BTC" or "ETHUSD"
 * @returns {string|null} the base crypto symbol, or null when it is not crypto
 */
export function cryptoBase(t) {
  if (!t) return null;
  const upper = String(t).toUpperCase();
  const stripped = upper.replace(/USD$/, "");
  if (Object.hasOwn(CRYPTO_TO_GECKO, stripped)) return stripped;
  if (Object.hasOwn(CRYPTO_TO_GECKO, upper)) return upper;
  return null;
}
