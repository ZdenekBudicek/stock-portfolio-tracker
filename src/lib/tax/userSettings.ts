// Stored user settings (table user_settings) → what the app uses.
import { normalizeBaseCurrency, normalizeResidence, type BaseCurrency, type TaxResidence } from "@/lib/tax/jurisdictions";

export interface UserSettings {
  taxResidence: TaxResidence;
  baseCurrency: BaseCurrency;
  /** The user has answered the first-login question. */
  confirmed: boolean;
  /** The settings table could be read (false: fall back to the defaults, never ask). */
  available: boolean;
}

/** When the settings table does not exist yet (migration not applied): the Czech rules the app always applied. */
export const DEFAULT_USER_SETTINGS: UserSettings = { taxResidence: "CZ", baseCurrency: "CZK", confirmed: true, available: false };

/** Row → settings; no row = a user who has not answered yet (Czech rules meanwhile). */
export function settingsFromRow(row: { tax_residence?: string | null; base_currency?: string | null; confirmed_at?: string | null } | null | undefined): UserSettings {
  if (!row) return { taxResidence: "CZ", baseCurrency: "CZK", confirmed: false, available: true };
  return {
    taxResidence: normalizeResidence(row.tax_residence),
    baseCurrency: normalizeBaseCurrency(row.base_currency),
    confirmed: !!row.confirmed_at,
    available: true,
  };
}

/**
 * The table does not exist (migration not applied yet) — a permanent state, not an outage:
 * the app then keeps the Czech rules it has always applied. Any OTHER error is transient and
 * must not be read as "Czech resident".
 */
export function isMissingTableError(err: { code?: string | null } | null | undefined): boolean {
  return err?.code === "PGRST205" || err?.code === "42P01";
}

/** Fetch result → settings; throws on a transient error so React Query retries. */
export function settingsFromResponse(res: { data: unknown[] | null; error: { code?: string | null; message?: string } | null }): UserSettings {
  if (res.error) {
    if (isMissingTableError(res.error)) return DEFAULT_USER_SETTINGS;
    throw res.error;
  }
  const rows = (res.data ?? []) as Parameters<typeof settingsFromRow>[0][];
  return settingsFromRow(rows[rows.length - 1]);
}

/* Last known setting per user, so an outage on a later visit keeps the user's own rules. */
const lastKey = (userId: string) => `user-settings:${userId}`;

export function readLastSettings(userId: string | null | undefined): UserSettings | null {
  if (!userId) return null;
  try {
    const v = JSON.parse(localStorage.getItem(lastKey(userId)) ?? "null");
    if (!v || typeof v !== "object") return null;
    return { taxResidence: normalizeResidence(v.taxResidence), baseCurrency: normalizeBaseCurrency(v.baseCurrency), confirmed: !!v.confirmed, available: true };
  } catch { return null; }
}

export function writeLastSettings(userId: string | null | undefined, s: UserSettings) {
  if (!userId || !s.available) return;
  try { localStorage.setItem(lastKey(userId), JSON.stringify({ taxResidence: s.taxResidence, baseCurrency: s.baseCurrency, confirmed: s.confirmed })); } catch { /* ignore */ }
}

/**
 * What the app applies: the fetched setting, else the last known one, else nothing (null =
 * unknown — show no Czech tax outputs until it is known).
 */
export function effectiveSettings(fetched: UserSettings | undefined, lastKnown: UserSettings | null): UserSettings | null {
  return fetched ?? lastKnown ?? null;
}
