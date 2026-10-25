import { describe, expect, it, vi } from "vitest";
import { toBrokerSummary } from "@/lib/brokerSummary";
import { useBrokerSummary } from "@/hooks/useExtras";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => options }));

describe("standalone broker mapper", () => {
  it("preserves numeric strings, account identity and sync metadata", () => {
    expect(toBrokerSummary({ account_summary: { currency: "USD", total: "1000", free: "250", invested: "650", ppl: "100", result: "50", total_net_deposits_usd: "850", account: 123 }, last_sync_at: "2025-01-02" }))
      .toEqual({ currency: "USD", total: 1000, free: 250, invested: 650, ppl: 100, result: 50, netDepositsUsd: 850, account: "123", lastSyncAt: "2025-01-02" });
  });

  it.each([null, undefined, false, 1, "unexpected", []])("rejects a non-object summary: %s", account_summary => {
    expect(toBrokerSummary({ account_summary })).toBeNull();
  });

  it("keeps legacy defaults and validates unknown nested fields", () => {
    expect(toBrokerSummary({ account_summary: {} })).toEqual({ currency: null, total: 0, free: 0, invested: 0, ppl: 0, result: 0, netDepositsUsd: null, account: null, lastSyncAt: null });
    expect(toBrokerSummary({ account_summary: { total: Infinity, ppl: {}, result: true, currency: {}, account: {}, total_net_deposits_usd: "bad" } }))
      .toMatchObject({ total: 0, ppl: 0, result: 0, currency: null, account: null, netDepositsUsd: null });
  });

  it("does not select another broker as T212", async () => {
    rpc.mockResolvedValue({ data: [{ broker: "OTHER", account_summary: { total: 999 } }], error: null });
    const query = useBrokerSummary("T212") as unknown as { queryFn: () => Promise<unknown> };
    expect(await query.queryFn()).toBeNull();
    rpc.mockResolvedValue({ data: [{ broker: "OTHER", account_summary: { total: 999 } }, { broker: "T212", account_summary: { total: 1000, account: "connected" } }], error: null });
    expect(await query.queryFn()).toMatchObject({ total: 1000, account: "connected" });
    expect(rpc).toHaveBeenCalledWith("get_broker_connection_status");
  });
});
