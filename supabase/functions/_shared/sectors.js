// Single source of truth for classifying a ticker into one of the app's sector buckets.
//
// Plain JS (not TS) on purpose: the Deno edge function `sync-sectors` and the Node worker
// `scripts/sector-worker.mjs` both import it directly, same trick as _shared/history.js.
// Pure function, no IO — everything here is unit-testable without the network.
//
// Two input vocabularies, one output:
//   Yahoo    -> sectorRaw ("Technology") + industryRaw ("Software - Infrastructure")
//   Finnhub  -> industryRaw only ("Technology"), sectorRaw is always null
// That asymmetry is why the industry RULES below run ONLY on industryRaw. Yahoo's
// "Financial Services" is a SECTOR (JPM, BAC -> Bankovnictví), while Finnhub's
// "Financial Services" is an INDUSTRY it hands to card/lending shops (SOFI, PYPL, V
// -> Fintech). Same string, opposite meaning, disambiguated by which field it arrives in.

// The complete set of buckets mapSector can emit. Exported so tests can assert the
// module never invents a new one — a typo or a well-meaning extra bucket would
// otherwise show up as an unlabelled slice in the allocation chart.
export const SECTOR_BUCKETS = Object.freeze([
  "Technologie", "Fintech", "Bankovnictví", "Spotřební zboží", "Automotive",
  "Letectví & obrana", "Zdravotnictví", "Energetika", "Průmysl", "Nemovitosti",
  "Materiály", "Utility", "Komunikace", "ETF", "Krypto",
]);

// Step 0. Per-ticker overrides — ONLY for tickers the rules below classify WRONG,
// never for tickers they merely fail to classify. Every entry needs a reason.
// Keys are looked up after `ticker.trim().toUpperCase()`, so every key here must
// already be upper-cased or it is silently dead on arrival.
export const TICKER_OVERRIDES = Object.freeze({
  NU: "Fintech", // Yahoo: "Banks - Regional". Nu Holdings really is a licensed bank,
                 // but it belongs next to SOFI, not next to JPM.
  // Yahoo sector is Communication Services; Finnhub industry is just "Media" — both
  // too coarse to separate these from DIS/WBD. All three belong in Technologie here.
  META: "Technologie",
  GOOGL: "Technologie",
  GOOG: "Technologie",
  MSTR: "Krypto",  // Yahoo industry: "Software - Infrastructure"; it's a bitcoin treasury company.
  MARA: "Krypto",  // Yahoo industry: "Capital Markets"; bitcoin miner.
  RIOT: "Krypto",  // Yahoo industry: "Capital Markets"; bitcoin miner.
  HOOD: "Fintech", // Yahoo industry: "Capital Markets"; retail brokerage, belongs with SOFI, not GS.
});

// Step 2. Industry rules, first match wins. Run against industryRaw ONLY — see the
// header comment for why sectorRaw must never reach these.
//
// Deliberately excludes "capital markets": Yahoo hands that exact industry to Goldman
// Sachs and Morgan Stanley (real investment banks -> Bankovnictví) AND to bitcoin
// miners like MARA/RIOT (-> Krypto). No shared regex can resolve that split, so the
// miners (plus HOOD, plus the MSTR treasury-company case) are handled as ticker
// overrides above instead, and "Capital Markets" here falls through to the plain
// sectorRaw translation below, which correctly reads it as Bankovnictví.
// Exported for tests and introspection ONLY — always classify through mapSector(), never
// by reading this table directly, or the precedence logic gets re-fragmented across callers.
// Frozen because this module is the single source of truth and it is imported by both
// writers — the sync-sectors edge function and scripts/sector-worker.mjs: a mutable live
// binding would let either of them silently reclassify every ticker for the other.
// (The frontend does NOT import this module; it falls back to src/lib/sectors.ts.)
export const INDUSTRY_RULES = Object.freeze([
  [/aerospace|defen[cs]e/i, "Letectví & obrana"],
  // No current provider value triggers this — kept in case either provider ever
  // labels an industry as explicitly crypto/blockchain-related. Costs nothing.
  [/crypto|blockchain|digital asset/i, "Krypto"],
  [/bank/i, "Bankovnictví"],
  [/credit services|financial data|financial services/i, "Fintech"],
  [/auto manufacturers|auto parts|automobiles/i, "Automotive"],
  [/internet content|interactive media/i, "Technologie"],
]);

// Step 3. Plain translation, applied to sectorRaw first and then to industryRaw.
// Lower-cased keys; covers both the Yahoo/Morningstar sector list and the coarse
// Finnhub industry list, which behaves like a sector list.
// Exported and frozen for the same reasons as INDUSTRY_RULES above.
export const TRANSLATIONS = Object.freeze({
  // Yahoo / Morningstar sectors
  "technology": "Technologie",
  "consumer cyclical": "Spotřební zboží",
  "consumer defensive": "Spotřební zboží",
  "healthcare": "Zdravotnictví",
  "energy": "Energetika",
  "industrials": "Průmysl",
  "financial services": "Bankovnictví",
  "real estate": "Nemovitosti",
  "basic materials": "Materiály",
  "utilities": "Utility",
  "communication services": "Komunikace",
  // Finnhub coarse industries
  "retail": "Spotřební zboží",
  // Unreachable while the /bank/i industry rule above exists (it always matches
  // "banking" first) — kept as belt-and-braces in case that rule ever narrows.
  "banking": "Bankovnictví",
  "insurance": "Bankovnictví",
  "media": "Komunikace",
  "telecommunication": "Komunikace",
  "pharmaceuticals": "Zdravotnictví",
  "biotechnology": "Zdravotnictví",
  "health care": "Zdravotnictví",
  "life sciences tools & services": "Zdravotnictví",
  "semiconductors": "Technologie",
  "machinery": "Průmysl",
  "logistics & transportation": "Průmysl",
  "constr. & engineering": "Průmysl",
  "building": "Průmysl",
  "chemicals": "Materiály",
  "metals & mining": "Materiály",
  "food products": "Spotřební zboží",
  "beverages": "Spotřební zboží",
  "consumer products": "Spotřební zboží",
  "textiles, apparel & luxury goods": "Spotřební zboží",
  "hotels, restaurants & leisure": "Spotřební zboží",
  "oil & gas": "Energetika",
  "airlines": "Průmysl",
  "software": "Technologie",
  "industrial conglomerates": "Průmysl",
  "tobacco": "Spotřební zboží",
  "electronic equipment": "Technologie",
});

const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/**
 * @param {{ticker?: string, sectorRaw?: string|null, industryRaw?: string|null, assetType?: string}} [input]
 * @returns {string|null} Czech sector bucket, or null when nothing matched.
 */
export function mapSector(input) {
  const { ticker, sectorRaw, industryRaw, assetType } = input || {};

  const t = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  if (t && Object.hasOwn(TICKER_OVERRIDES, t)) return TICKER_OVERRIDES[t];

  // Step 1. Instrument type wins over any provider taxonomy.
  const at = typeof assetType === "string" ? assetType.trim().toUpperCase() : "";
  if (at === "ETF") return "ETF";
  if (at === "CRYPTO") return "Krypto";

  const ind = norm(industryRaw);
  if (ind) {
    for (const [re, bucket] of INDUSTRY_RULES) if (re.test(ind)) return bucket;
  }

  const sec = norm(sectorRaw);
  if (sec && Object.hasOwn(TRANSLATIONS, sec)) return TRANSLATIONS[sec];
  if (ind && Object.hasOwn(TRANSLATIONS, ind)) return TRANSLATIONS[ind];

  return null;
}
