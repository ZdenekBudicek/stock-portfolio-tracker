// Company-profile fetchers + parsers. Parsers are pure and unit-tested; the fetchers are
// thin wrappers, like _shared/price-providers.ts — except that these ones do NOT collapse
// every failure into null. See ProfileFetch below: callers keep a per-provider miss counter
// and must be able to tell "the provider says it has nothing for this symbol" apart from
// "we never got an answer", because only the first one is the symbol's fault.
//
// Provider split is forced by the network, not by preference:
//   - From the Supabase edge IP, Yahoo answers 401 (see refresh-prices/index.ts). Only
//     Finnhub works there.
//   - From GitHub Actions the IP is clean, so the nightly worker uses Yahoo, whose
//     sector+industry pair maps far more precisely than Finnhub's single coarse string.
//
// The shape below is the exact input contract of mapSector() in _shared/sectors.js —
// same field names, no adapter in between. Do not rename a field here without renaming
// it there.

export interface RawProfile {
  ticker: string;
  name: string | null;
  sectorRaw: string | null;
  industryRaw: string | null;
  // "CRYPTO" is never produced by the parsers below — crypto tickers are filtered out by
  // cryptoBase() before any profile API is called. The member exists so callers can build
  // a crypto row directly without widening the type.
  assetType: "EQUITY" | "ETF" | "CRYPTO";
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

/** Finnhub /stock/profile2 — returns finnhubIndustry only, never a sector. */
export function parseFinnhubProfile(ticker: string, json: unknown): RawProfile | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const industryRaw = str(o.finnhubIndustry);
  if (!industryRaw) return null; // {} is what Finnhub sends for ETFs and unknown symbols
  return { ticker, name: str(o.name), sectorRaw: null, industryRaw, assetType: "EQUITY" };
}

/**
 * Yahoo. Accepts both shapes we may get:
 *  - quoteSummary?modules=assetProfile  -> { quoteSummary: { result: [{ assetProfile }] } }
 *  - v1/finance/search?q=TICKER         -> { quotes: [{ symbol, sector, industry, quoteType }] }
 * The search endpoint is the crumb-free fallback.
 *
 * `name` is null on the quoteSummary branch on purpose: the assetProfile module carries
 * address/sector/industry/officers but NO company-name field (the name lives in the
 * separate `price` / `quoteType` modules). Only the search shape gives us a name.
 */
export function parseYahooProfile(ticker: string, json: unknown): RawProfile | null {
  const root = rec(json);
  if (!root) return null;

  const result = rec(root.quoteSummary)?.result;
  const assetProfile = Array.isArray(result) ? rec(rec(result[0])?.assetProfile) : null;
  if (assetProfile) {
    const sectorRaw = str(assetProfile.sector);
    const industryRaw = str(assetProfile.industry);
    if (!sectorRaw && !industryRaw) return null;
    return { ticker, name: null, sectorRaw, industryRaw, assetType: "EQUITY" };
  }

  // Guarded and hoisted: a null ticker would otherwise throw here while the Finnhub parser
  // tolerates it, and the nightly worker is plain JS with no typechecking — one throw
  // inside its loop aborts the whole batch.
  const want = String(ticker ?? "").trim().toUpperCase();
  const quote = Array.isArray(root.quotes)
    ? rec(root.quotes.find((q) => str(rec(q)?.symbol)?.toUpperCase() === want))
    : null;
  if (quote) {
    const assetType = str(quote.quoteType)?.toUpperCase() === "ETF" ? "ETF" : "EQUITY";
    const sectorRaw = str(quote.sector);
    const industryRaw = str(quote.industry);
    // An ETF is worth returning with no taxonomy at all — mapSector buckets it on
    // assetType alone. An equity with neither field tells us nothing, so drop it.
    if (assetType !== "ETF" && !sectorRaw && !industryRaw) return null;
    return { ticker, name: str(quote.shortname) ?? str(quote.longname), sectorRaw, industryRaw, assetType };
  }

  return null;
}

/**
 * The outcome of one profile lookup. The three cases must stay distinct all the way to the
 * call site:
 *   ok    — we have a profile.
 *   empty — the provider answered and has nothing for this symbol. The symbol's fault, and
 *           the ONLY case a miss counter may be incremented for.
 *   error — rate limit, 5xx, bad key, timeout, unparseable body. Says nothing whatsoever
 *           about the symbol, so the stored row must be left exactly as it is.
 * Collapsing these into `RawProfile | null` is how a ticker gets frozen out permanently by
 * one bad afternoon at the provider: five 429s and it is past MAX_MISSES for good.
 */
export type ProfileFetch =
  | { status: "ok"; profile: RawProfile }
  | { status: "empty" }
  | { status: "error"; detail: string };

/**
 * The status mapping, pure and exported so it can be tested without a network.
 *
 * Finnhub answers 200 with `{}` for ETFs and for symbols it does not know — that, and only
 * that, is "empty". EVERY non-2xx is an error, deliberately wider than just 429/5xx: a 401
 * or 403 means our key is wrong or out of plan, which is even less the symbol's fault than
 * a rate limit is, and Finnhub does not use 404 to mean "unknown symbol".
 */
export function finnhubFetchResult(httpStatus: number, parsed: RawProfile | null): ProfileFetch {
  if (httpStatus < 200 || httpStatus >= 300) return { status: "error", detail: `HTTP ${httpStatus}` };
  return parsed ? { status: "ok", profile: parsed } : { status: "empty" };
}

/** Finnhub profile fetch, one symbol per call (its API takes no batches). */
export async function fetchFinnhubProfile(ticker: string, apiKey: string): Promise<ProfileFetch> {
  if (!apiKey) return { status: "error", detail: "no api key" };
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`,
      // Deno's fetch has no default timeout. Without this, one hung socket outlives any
      // budget the caller keeps (it can only check BETWEEN calls) and takes the whole run
      // with it when the platform kills the function.
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return finnhubFetchResult(r.status, null);
    return finnhubFetchResult(r.status, parseFinnhubProfile(ticker, await r.json()));
  } catch (e) {
    // Transport failure, abort/timeout, or a body that is not JSON. Never the symbol's fault.
    return { status: "error", detail: (e as Error)?.name || "fetch failed" };
  }
}
