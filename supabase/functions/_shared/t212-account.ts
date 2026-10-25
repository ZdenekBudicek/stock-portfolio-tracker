/** The app has one real-money ledger; practice accounts must never write to it. */
export function t212AccountGuard(environment: string, stored: string | null, incoming: string | null, confirmed?: string): "practice_account" | "account_unknown" | "account_changed" | null {
  if (environment !== "live") return "practice_account";
  if (!incoming) return "account_unknown";
  if (stored && stored !== incoming && confirmed !== incoming) return "account_changed";
  return null;
}
