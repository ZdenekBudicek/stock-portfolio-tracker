import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import StatementImport from "@/components/StatementImport";
import Watchlist from "@/components/Watchlist";
import SplitsBanner from "@/components/SplitsBanner";
import BrokerConnect from "@/components/BrokerConnect";
import YearlyGrowth from "@/components/YearlyGrowth";
import DividendTracker from "@/components/DividendTracker";
import TransactionHistory from "@/components/TransactionHistory";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({ remove: vi.fn(), dismiss: vi.fn(), parse: vi.fn(), invoke: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/statementImport", () => ({ parseStatementFile: mocks.parse, planImport: vi.fn(), executeImport: vi.fn() }));
vi.mock("@/hooks/usePortfolio", () => ({
  useLivePrices: () => ({ data: null }), usePositions: () => ({ data: [] }), useDailySnapshots: () => ({ data: [] }),
  useTransactions: () => ({ data: Array.from({ length: 21 }, (_, i) => ({ id: String(i), ticker: "AAPL", side: "BUY", shares: 1, price_usd: 10, executed_at: "2026-10-25" })) }),
  useComputedPortfolio: () => ({ positions: [], totalValue: 0, usdLocal: 22 }), computeTradeFlows: () => new Map(),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "fixture-user" } }) }));
vi.mock("@/contexts/CurrencyContext", () => ({ useCurrency: () => ({ format: String, local: "CZK" }) }));
vi.mock("@/hooks/useInsights", () => ({ useDividendModel: () => ({ annualTotal: 0 }) }));
vi.mock("@/hooks/useExtras", () => ({
  useWatchlist: () => ({ data: [{ id: "w", ticker: "AAPL", name: "Apple" }] }),
  useAddWatch: () => ({ mutateAsync: vi.fn() }), useRemoveWatch: () => ({ mutate: mocks.remove }),
  useSplits: () => ({ data: [{ id: "s", ticker: "AAPL", ratio: 4, split_date: "2026-10-25" }] }),
  useApplySplit: () => ({ mutateAsync: vi.fn() }), useDismissSplit: () => ({ mutate: mocks.dismiss }),
  useAddSplitManual: () => ({ mutateAsync: vi.fn() }),
  useDividends: () => ({ data: [{ id: "d", ticker: "AAPL", ex_date: `${new Date().getFullYear()}-10-25`, pay_date: "2026-10-25", amount_per_share: 1, total_amount_usd: 1, shares_held: 1, status: "paid" }] }),
  useUpsertDividend: () => ({ mutateAsync: vi.fn() }), useDeleteDividend: () => ({ mutate: mocks.remove }),
}));
vi.mock("@/components/TickerLogo", () => ({ TickerLogo: () => null }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc, functions: { invoke: mocks.invoke } } }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const show = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

it("R2 exposes a native, focusable statement upload button and opens the file chooser", () => {
  const view = show(<StatementImport />);
  const button = screen.getByRole("button", { name: i18n.t("legacy.statementImport.dropAStatementHereOrClickToSelect") });
  expect(button.tagName).toBe("BUTTON");
  expect(button).toHaveClass("focus-visible:ring-2");
  button.focus();
  expect(button).toHaveFocus();
  const click = vi.spyOn(view.container.querySelector('input[type="file"]') as HTMLInputElement, "click");
  fireEvent.click(button); // Native buttons provide Enter/Space activation in the browser.
  expect(click).toHaveBeenCalledOnce();
});

it("R2 names the watchlist delete and split dismiss controls by ticker", () => {
  show(<><Watchlist /><SplitsBanner /></>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.watchlist.removeTicker", { ticker: "AAPL" }) }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.splitsBanner.dismissTicker", { ticker: "AAPL" }) }));
  expect(mocks.remove).toHaveBeenCalledWith("w");
  expect(mocks.dismiss).toHaveBeenCalledWith("s");
});

it("R4 offers only a live connection", async () => {
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  await act(async () => { show(<BrokerConnect />); });
  expect(screen.queryByRole("option", { name: i18n.t("legacy.brokerConnect.demoPractice") })).toBeNull();
  expect(screen.getByText(i18n.t("legacy.brokerConnect.liveAccount"))).toBeInTheDocument();
});

it("R2 names the goal editing controls", () => {
  show(<YearlyGrowth />);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.yearlyGrowth.editGoal") }));
  expect(screen.getByRole("button", { name: i18n.t("legacy.yearlyGrowth.saveGoal") })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.yearlyGrowth.cancelGoal") }));
});

it("R2 names dividend deletion by ticker", () => {
  show(<DividendTracker />);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.dividendTracker.deleteTicker", { ticker: "AAPL" }) }));
  expect(mocks.remove).toHaveBeenCalledWith("d");
});

it("R2 names transaction pagination", () => {
  show(<TransactionHistory />);
  expect(screen.getByRole("button", { name: i18n.t("legacy.transactionHistory.previousPage") })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.transactionHistory.nextPage") }));
  expect(screen.getByRole("button", { name: i18n.t("legacy.transactionHistory.previousPage") })).not.toBeDisabled();
});

it("R4 requires explicit confirmation before retrying a different live account", async () => {
  mocks.rpc.mockResolvedValue({ data: [{ broker: "T212", environment: "live" }], error: null });
  mocks.invoke.mockResolvedValue({ data: { code: "account_changed", error: "account_changed", account: "B" }, error: null });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  show(<BrokerConnect />);
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("legacy.brokerConnect.sync") }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  mocks.invoke.mockResolvedValueOnce({ data: { code: "account_changed", error: "account_changed", account: "B" }, error: null })
    .mockResolvedValue({ data: { done: true, positions: 1 }, error: null });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("legacy.brokerConnect.sync") }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("sync-broker", { body: { broker: "T212", restart: true, confirmAccount: "B" } }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("legacy.brokerConnect.sync") })).not.toBeDisabled());
});
