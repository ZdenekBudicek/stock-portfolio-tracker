// Crypto ticker recognition — ONE key set for every site that has to tell a coin from a
// stock. Plain JS so Deno edge functions and Node scripts can both import it.
//
// WHY THIS EXISTS. Recognition used to be copy-pasted into every caller, and the copies
// drifted to three different key sets (17 / 11 / 10). Worse, each copy fell back to the
// BARE TICKER on a miss, and a bare crypto ticker is very often a real, unrelated
// security: LTC is an NYSE REIT, ATOM is Atomera, APT is Alpha Pro Tech, TRX is TRX Gold,
// NEAR is an iShares bond ETF, LINK is Interlink Electronics. Yahoo happily returned that
// company's prices, so they were written into the shared price_history table as the
// coin's history — a chart of the wrong company next to a correct live price.
//
// THE RULE: membership comes from CRYPTO_TICKERS below, and a provider lookup that misses
// returns null so the caller can SKIP AND LOG. Never fall back to the bare ticker.
//
// The per-provider VALUE formats are genuinely different and are deliberately NOT merged
// or derived from one another — they are separate maps that happen to share a key set,
// which the test in src/__tests__/crypto-tickers.test.ts pins.

/**
 * The canonical set. Adding a coin means adding it here AND to all three maps below;
 * the test fails until every provider covers it.
 * @type {readonly string[]}
 */
export const CRYPTO_TICKERS = Object.freeze([
  "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "AVAX", "LINK",
  "BNB", "EGLD", "LTC", "TRX", "MATIC", "ATOM", "NEAR", "APT",
]);

// Kept module-private: Object.freeze does not stop Set.prototype.add, so exporting a Set
// would look immutable and not be. The frozen array above is the public surface.
const TICKER_SET = new Set(CRYPTO_TICKERS);

/**
 * The base crypto symbol for a broker ticker, or null when it is not crypto.
 * @param {string} t broker ticker, e.g. "BTC" or "ETHUSD"
 * @returns {string|null}
 */
export function cryptoBase(t) {
  if (!t) return null;
  const upper = String(t).toUpperCase();
  const stripped = upper.replace(/USD$/, "");
  if (TICKER_SET.has(stripped)) return stripped;
  if (TICKER_SET.has(upper)) return upper;
  return null;
}

/**
 * Membership predicate — the one question every caller actually asks.
 * @param {string} t
 * @returns {boolean}
 */
export function isCryptoTicker(t) {
  return cryptoBase(t) !== null;
}

/**
 * Crypto for pricing purposes. The ticker alone is ambiguous (ATOM is also Atomera, LTC an
 * NYSE REIT), but positions.type cannot settle it either: "Stock" is the DEFAULT that every
 * manual trade, sync and trigger writes, crypto included. So "Stock" (or no type) means
 * "unknown" and the key set decides; only an explicitly different type (ETF, Fund, Bond, ...)
 * marks a crypto-named ticker as a security. A real stock with a coin ticker is pinned via
 * ticker_alias.yahoo_symbol, which the worker always prefers.
 * @param {string} t
 * @param {string|null|undefined} type positions.type, if known
 * @returns {boolean}
 */
export function isCryptoHolding(t, type) {
  if (!isCryptoTicker(t)) return false;
  const ty = String(type ?? "").trim().toLowerCase();
  return !ty || ty === "stock" || ty.includes("crypto");
}

// ---- provider-format value maps --------------------------------------------
// Same keys, three different value formats. Each is frozen; the JSDoc type is
// load-bearing for TypeScript consumers (without it TS widens the frozen literal and
// Object.entries() yields [string, unknown][], so callers cannot use the value as a
// string).

/** CoinGecko ids, for refresh-prices. @type {Readonly<Record<string, string>>} */
export const CRYPTO_TO_GECKO = Object.freeze({
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", ADA: "cardano",
  DOGE: "dogecoin", DOT: "polkadot", AVAX: "avalanche-2", LINK: "chainlink",
  BNB: "binancecoin", EGLD: "elrond-erd-2", LTC: "litecoin", TRX: "tron",
  MATIC: "matic-network", ATOM: "cosmos", NEAR: "near", APT: "aptos",
});

/**
 * Yahoo chart symbols. Every entry verified against
 * query1.finance.yahoo.com/v8/finance/chart on 2026-08-10 to return
 * instrumentType CRYPTOCURRENCY with live daily bars.
 *
 * Two are NOT the obvious "<TICKER>-USD" form, and getting them wrong swaps one wrong
 * instrument for another rather than fixing anything:
 *   APT-USD   is "Apricot Finance" (~$0.00013), NOT Aptos -> APT21794-USD.
 *   MATIC-USD is the dead pre-rebrand Polygon symbol and returns zero daily bars;
 *             POL-USD is "Proof Of Liquidity", a third wrong coin -> POL28321-USD.
 * @type {Readonly<Record<string, string>>}
 */
export const CRYPTO_YAHOO = Object.freeze({
  BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", XRP: "XRP-USD", ADA: "ADA-USD",
  DOGE: "DOGE-USD", DOT: "DOT-USD", AVAX: "AVAX-USD", LINK: "LINK-USD",
  BNB: "BNB-USD", EGLD: "EGLD-USD", LTC: "LTC-USD", TRX: "TRX-USD",
  MATIC: "POL28321-USD", ATOM: "ATOM-USD", NEAR: "NEAR-USD", APT: "APT21794-USD",
});

/**
 * Twelve Data pair symbols. Used by backfill-snapshots (primary) and by the nightly
 * worker's fallback + cross-check, which previously passed a bare ticker here too and so
 * cross-checked the REIT against itself.
 *
 * NOT independently verified — Twelve Data needs an API key this checkout does not have.
 * That is safe by construction now: a symbol Twelve Data does not know returns no values,
 * and the callers skip and log instead of writing a tombstone. MATIC and APT are the two
 * worth confirming first if a key becomes available (see the Yahoo note above).
 * @type {Readonly<Record<string, string>>}
 */
export const CRYPTO_TWELVEDATA = Object.freeze({
  BTC: "BTC/USD", ETH: "ETH/USD", SOL: "SOL/USD", XRP: "XRP/USD", ADA: "ADA/USD",
  DOGE: "DOGE/USD", DOT: "DOT/USD", AVAX: "AVAX/USD", LINK: "LINK/USD",
  BNB: "BNB/USD", EGLD: "EGLD/USD", LTC: "LTC/USD", TRX: "TRX/USD",
  MATIC: "MATIC/USD", ATOM: "ATOM/USD", NEAR: "NEAR/USD", APT: "APT/USD",
});

/** @param {string} t @returns {string|null} CoinGecko id, or null when not crypto. */
export function geckoId(t) {
  const b = cryptoBase(t);
  return b ? CRYPTO_TO_GECKO[b] ?? null : null;
}

/** @param {string} t @returns {string|null} Yahoo symbol, or null when not crypto. */
export function yahooCryptoSymbol(t) {
  const b = cryptoBase(t);
  return b ? CRYPTO_YAHOO[b] ?? null : null;
}

/** @param {string} t @returns {string|null} Twelve Data symbol, or null when not crypto. */
export function twelveCryptoSymbol(t) {
  const b = cryptoBase(t);
  return b ? CRYPTO_TWELVEDATA[b] ?? null : null;
}
