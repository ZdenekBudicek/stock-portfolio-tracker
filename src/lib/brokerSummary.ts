export interface BrokerSummary {
  currency: string | null;
  total: number;     // total account value (account currency)
  free: number;      // free cash
  invested: number;  // cost basis of open positions
  ppl: number;       // unrealised P&L on open positions
  result: number;    // lifetime realised P&L
  netDepositsUsd: number | null; // combined net deposits across all brokers, in USD (if known)
  /** Last finished sync of the connection (null when never synced). */
  lastSyncAt: string | null;
  /**
   * T212 account number the summary belongs to (null on summaries stored before scoping).
   * computeNetDeposits needs it to tell the connected account's rows from another T212
   * account imported from statements — without it every T212 row counted as connected.
   */
  account: string | null;
}

/** Maps one get_broker_connection_status row to a BrokerSummary (null without a summary). */
export function toBrokerSummary(row: { account_summary?: unknown; last_sync_at?: string | null } | null | undefined): BrokerSummary | null {
  const s = row?.account_summary;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const fields = s as Record<string, unknown>;
  const numeric = (value: unknown): number | null => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const account = fields.account;
  return {
    currency: typeof fields.currency === "string" ? fields.currency : null,
    total: numeric(fields.total) ?? 0,
    free: numeric(fields.free) ?? 0,
    invested: numeric(fields.invested) ?? 0,
    ppl: numeric(fields.ppl) ?? 0,
    result: numeric(fields.result) ?? 0,
    netDepositsUsd: numeric(fields.total_net_deposits_usd),
    lastSyncAt: row?.last_sync_at ?? null,
    account: typeof account === "string" && account !== "" ? account : typeof account === "number" && Number.isFinite(account) ? String(account) : null,
  };
}
