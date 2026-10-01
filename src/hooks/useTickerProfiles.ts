// Read side of public.ticker_profiles — the shared, user-agnostic sector per instrument
// that sync-sectors (Finnhub, after every broker sync) and scripts/sector-worker.mjs
// (Yahoo, nightly) fill in. This replaces the hardcoded ~90-entry map in src/lib/sectors.ts
// as the PRIMARY source for the donut; that map stays as the offline fallback.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/hooks/usePortfolio";
import { sectorForTicker } from "@/lib/sectors";

/**
 * Only what the chart needs. The table also carries name/sector_raw/industry_raw/
 * asset_type/source and the two miss counters; those are the sync jobs' bookkeeping and
 * nothing in the UI reads them, so they are not fetched.
 *
 * `ticker` is the CANONICAL ticker the row is filed under, which is not necessarily the
 * ticker the position is held as — see buildProfileMap().
 */
export interface TickerProfile {
  ticker: string;
  sector: string | null;
}

export type TickerProfileMap = ReadonlyMap<string, TickerProfile>;

/**
 * A sector changes on the order of never, and the table is refreshed by background jobs
 * (nightly worker + after each broker sync), never by anything the user does in this tab.
 * Refetching it on every window focus would be pure noise.
 */
const PROFILES_STALE_MS = 24 * 60 * 60 * 1000;

const up = (t: unknown): string => String(t ?? "").trim().toUpperCase();

/**
 * Build the lookup the chart uses, keyed by UPPERCASE ticker.
 *
 * Two things have to line up with the writers or the chart silently reads nothing:
 *
 *  1. CASE. `ticker_profiles.ticker` is a case-SENSITIVE text primary key and both writers
 *     upper-case before writing (sync-sectors' canon(), sector-worker.mjs' up()). A
 *     position held as 'BATSl' is filed under 'BATSL'.
 *
 *  2. ALIASES. Both writers file a profile under canon(ticker) — the ticker_alias
 *     resolution — so FB/IPOE/VACQ share one row with META/SOFI/RKLB. positions.ticker is
 *     normally already canonical (sync-broker resolves the alias BEFORE writing, and
 *     refresh-prices uses positions.ticker verbatim as the provider symbol, which is what
 *     `canonical` means), but "normally" is not "always": ticker_alias rows are also
 *     written by paths this repo cannot inspect (the seed_ticker_aliases RPC called from
 *     statementImport.ts is not in supabase/migrations/), and a statement-imported ticker
 *     can acquire a divergent canonical afterwards. Rather than bet on the alias table
 *     being the identity for everything we hold, apply the SAME resolution the writers
 *     apply: then the key matches by construction whether or not aliasing is a no-op.
 *
 * The alias entries are added as extra KEYS pointing at the canonical row, so consumers
 * stay a plain `map.get(ticker.toUpperCase())`. A real profile row is never shadowed by an
 * alias entry, and an alias whose canonical has no profile row is skipped — the map holds
 * only rows that actually exist.
 */
export function buildProfileMap(
  rows: { ticker: string; sector: string | null }[],
  aliases: { alias: string; canonical: string }[],
): TickerProfileMap {
  const byTicker = new Map<string, TickerProfile>();
  for (const r of rows) {
    const ticker = up(r.ticker);
    if (!ticker) continue;
    byTicker.set(ticker, { ticker, sector: r.sector ?? null });
  }
  for (const a of aliases) {
    const alias = up(a.alias);
    const canonical = up(a.canonical);
    // A blank canonical would map a real ticker onto "" — sector-worker.mjs filters the
    // same case out for the same reason.
    if (!alias || !canonical || alias === canonical || byTicker.has(alias)) continue;
    const profile = byTicker.get(canonical);
    if (profile) byTicker.set(alias, profile);
  }
  return byTicker;
}

/**
 * Resolution order for one position, first non-empty wins:
 *
 *   positions.sector (manual override) -> ticker_profiles.sector (API) -> TICKER_SECTORS
 *   (offline fallback) -> "Ostatní"
 *
 * positions.sector is a MANUAL override only: 20260809100000_ticker_profiles.sql drops the
 * autofill trigger and clears every value the old hardcoded map had produced, so anything
 * left there was typed by a human and must beat the API.
 *
 * Empty strings are treated as absent at every level — a manual sector cleared to '' in the
 * DB, or a profile row that exists but has not been resolved yet (sector NULL, which is
 * every row the providers came back empty on), must fall through rather than render a blank
 * slice.
 *
 * Pure on purpose: the whole chain is testable without mounting anything.
 */
export function resolveSector(
  ticker: string,
  manualSector: string | null | undefined,
  profiles?: TickerProfileMap | null,
): string {
  const manual = String(manualSector ?? "").trim();
  if (manual) return manual;

  const key = up(ticker);
  const profile = profiles?.get(key);
  const api = String(profile?.sector ?? "").trim();
  if (api) return api;

  // Static map, tried under the ticker as held and then under the canonical it resolves to:
  // a position held as 'FB' is not in TICKER_SECTORS, but 'META' is. Only reachable when a
  // profile row exists (that is where the canonical comes from) but carries no sector yet.
  return sectorForTicker(key, "") || sectorForTicker(profile?.ticker ?? "", "") || "Ostatní";
}

/**
 * The whole table, keyed by UPPERCASE ticker. No WHERE clause on purpose: it holds one row
 * per instrument ANYONE has ever held (it is shared reference data, not per-user), which is
 * both why it is small enough to load whole and why there is no user column to filter on.
 * Paged like every other read in this app — PostgREST caps a select at 1000 rows and
 * returns the first page silently.
 */
export function useTickerProfiles() {
  return useQuery({
    queryKey: ["ticker-profiles"],
    queryFn: async (): Promise<TickerProfileMap> => {
      const [rows, aliases] = await Promise.all([
        fetchAllRows<{ ticker: string; sector: string | null }>((from, to) =>
          supabase.from("ticker_profiles").select("ticker,sector").order("ticker").range(from, to),
        ),
        fetchAllRows<{ alias: string; canonical: string }>((from, to) =>
          supabase.from("ticker_alias").select("alias,canonical").order("alias").range(from, to),
        ),
      ]);
      return buildProfileMap(rows, aliases);
    },
    staleTime: PROFILES_STALE_MS,
  });
}
