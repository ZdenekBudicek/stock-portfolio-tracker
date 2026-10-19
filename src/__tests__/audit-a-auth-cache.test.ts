import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the auth listener so the test can drive identity changes by hand.
const h = vi.hoisted(() => ({
  listener: null as null | ((event: string, s: unknown) => void),
  initial: null as unknown,
  rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, s: unknown) => void) => {
        h.listener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      getSession: () => Promise.resolve({ data: { session: h.initial } }),
      signOut: () => Promise.resolve({ error: null }),
    },
    rpc: h.rpc,
  },
}));

import { AuthProvider } from "@/contexts/AuthContext";

const session = (id: string) => ({ user: { id, email: `${id}@example.test` } });

async function mount(qc: QueryClient) {
  render(createElement(QueryClientProvider, { client: qc }, createElement(AuthProvider, null, null)));
  await act(async () => { await Promise.resolve(); });
}

describe("AuthProvider — query cache follows the signed-in identity", () => {
  beforeEach(() => { h.listener = null; h.initial = null; h.rpc.mockClear(); });

  it("drops the previous user's cached data on sign-out and on a different user's sign-in", async () => {
    const qc = new QueryClient();
    h.initial = session("user-a");
    await mount(qc);
    await act(async () => { h.listener!("INITIAL_SESSION", session("user-a")); });

    qc.setQueryData(["positions"], [{ ticker: "AAPL", shares: 10 }]);
    // Same user (token refresh): the cache stays.
    await act(async () => { h.listener!("TOKEN_REFRESHED", session("user-a")); });
    expect(qc.getQueryData(["positions"])).toBeDefined();

    // Sign-out of A: nothing of A's survives.
    await act(async () => { h.listener!("SIGNED_OUT", null); });
    expect(qc.getQueryData(["positions"])).toBeUndefined();

    // Data cached while signed out (or by A) never reaches B.
    qc.setQueryData(["transactions"], [{ ticker: "MSFT" }]);
    await act(async () => { h.listener!("SIGNED_IN", session("user-b")); });
    expect(qc.getQueryData(["transactions"])).toBeUndefined();
  });

  it("no longer calls the removed claim_orphan_data RPC after sign-in", async () => {
    const qc = new QueryClient();
    await mount(qc);
    await act(async () => { h.listener!("SIGNED_IN", session("user-c")); });
    expect(h.rpc).not.toHaveBeenCalledWith("claim_orphan_data", expect.anything());
  });
});
