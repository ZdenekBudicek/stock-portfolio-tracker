import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Taxes from "@/pages/Taxes";
import { InternationalTaxes } from "@/components/tax/InternationalTaxes";
import { computeCzTaxModel } from "@/lib/czTaxModel";
import { computeRealized } from "@/lib/realizedModel";
import { createInternationalFixture, createSaleFixture } from "@/test/agentPortfolioFixture";

const state = vi.hoisted(() => ({ tax: null as ReturnType<typeof computeCzTaxModel> & { loading: boolean }, realized: null as ReturnType<typeof computeRealized> & { loading: boolean }, transactions: null as ReturnType<typeof createSaleFixture>["transactions"],
  profiles: null as Record<string, unknown>, registry: null as Record<string, unknown>, residence: "CZ", loading: false, error: false }));
vi.mock("react-i18next", async importOriginal => ({ ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useInsights", () => ({ useTaxModel: () => state.tax, todayPrague: () => "2026-10-23" }));
vi.mock("@/hooks/useRealized", () => ({ useRealizedModel: () => state.realized }));
vi.mock("@/hooks/usePortfolio", () => ({ useTransactions: () => ({ data: state.transactions, isLoading: state.loading, isError: state.error }),
  useComputedPortfolio: () => ({ positions: [{ ticker: "AAPL", currentPrice: 150 }], usdCzk: 25 }),
  usePositions: () => ({ data: state.registry.positions, isLoading: state.loading, isError: state.error }), fetchAllRows: vi.fn() }));
vi.mock("@/hooks/useExtras", () => ({ useDividends: () => ({ data: [], isLoading: state.loading, isError: state.error }) }));
vi.mock("@/hooks/useAssetKinds", () => ({ useInstrumentRegistry: () => ({ registry: state.registry, loading: state.loading, error: state.error }),
  useAssetKindResolver: () => () => ({ kind: "security", resolved: true }) }));
vi.mock("@/hooks/useTaxProfiles", () => ({ useTaxProfiles: () => ({ data: state.profiles, isLoading: state.loading, isError: state.error }),
  profileKey: (country: string, year: number) => `${country}-${year}` }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.registry, isLoading: state.loading, isError: state.error }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/hooks/useTaxPrefs", () => ({ useTaxPrefs: () => [{ fxMethod: "cnb-daily", limitIncludesExempt: true }] }));
vi.mock("@/hooks/useTaxResidence", () => ({ useTaxResidence: () => ({ known: true, taxResidence: state.residence,
  jurisdiction: { caps: { taxEstimate: state.residence === "CZ" } } }) }));
vi.mock("@/contexts/CurrencyContext", () => ({ useCurrency: () => ({ currency: "CZK", hidden: false, rate: 25,
  format: String, formatAt: String }) }));
vi.mock("@/components/TaxReport", () => ({ default: () => <div>full-report</div> }));
vi.mock("@/components/TaxResidence", () => ({ ResidenceLoadError: () => null }));
vi.mock("@/components/TickerLogo", () => ({ TickerLogo: () => null }));
vi.mock("@/components/v2/widgets", () => ({ fmtDate: (value: string) => value }));
vi.mock("@/components/tax/TaxProfileForm", () => ({ TaxProfileForm: () => <div>profile-form</div>,
  CURRENCY_OF: { SK: "EUR" } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const fixture = createSaleFixture();
  state.tax = { ...computeCzTaxModel({ ...fixture, positions: [{ ...fixture.positions[0], ticker: "AAPL", currentPrice: 150 }] }), loading: false };
  state.realized = { ...computeRealized(fixture), loading: false };
  state.transactions = fixture.transactions;
  state.registry = fixture.registry;
  state.profiles = createInternationalFixture().storedProfiles.profiles;
  state.loading = false; state.error = false; state.residence = "CZ";
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("tax page shared models", () => {
  it.each(["CZ", "OTHER"])("hides %s incomplete warnings until initial loading finishes", residence => {
    state.residence = residence;
    state.tax.loading = true; state.tax.report.complete = false;
    state.realized.loading = true; state.realized.report.complete = false;
    const view = render(<Taxes />);
    expect(view.container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText("taxes.est.incomplete")).toBeNull();
    expect(screen.queryByText("residence.realized.incomplete")).toBeNull();
    state.tax.loading = false; state.realized.loading = false;
    view.rerender(<Taxes />);
    expect(screen.getByText(residence === "CZ" ? "taxes.est.incomplete" : "residence.realized.incomplete")).toBeTruthy();
  });

  it("defaults to the account with most shares and allows changing it", () => {
    const fixture = createSaleFixture();
    fixture.transactions.find(tx => tx.broker_account === "B" && tx.side === "BUY")!.shares = 12;
    state.transactions = fixture.transactions;
    state.tax = { ...computeCzTaxModel({ ...fixture, positions: [{ ...fixture.positions[0], ticker: "AAPL", currentPrice: 150 }] }), loading: false };
    render(<Taxes />);
    expect((screen.getByLabelText("taxes.sim.account") as HTMLSelectElement).value).toBe("SYNTHETIC|B");
    expect(screen.getByText("taxes.sim.lots")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("taxes.sim.account"), { target: { value: "SYNTHETIC|A" } });
    expect((screen.getByLabelText("taxes.sim.account") as HTMLSelectElement).value).toBe("SYNTHETIC|A");
    expect(screen.getByText("taxes.sim.lots")).toBeTruthy();
  });

  it("does not replace an explicitly invalid quantity with a default sale", () => {
    render(<Taxes />);
    fireEvent.change(screen.getByLabelText("taxes.sim.account"), { target: { value: "SYNTHETIC|A" } });
    fireEvent.change(screen.getByLabelText("taxes.sim.shares"), { target: { value: "0" } });
    expect(screen.queryByText("taxes.sim.lots")).toBeNull();
    expect(screen.getByText("taxes.sim.invalid")).toBeTruthy();
  });

  it("retains international loading, read error, profile form, and report states", () => {
    state.loading = true;
    const view = render(<MemoryRouter><InternationalTaxes country="SK" /></MemoryRouter>);
    expect(view.container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText("intl.status.blocked")).toBeNull();
    state.loading = false; state.error = true;
    view.rerender(<MemoryRouter><InternationalTaxes country="SK" /></MemoryRouter>);
    expect(screen.getByText("intl.error.load")).toBeTruthy();
    state.error = false; state.profiles = {};
    view.rerender(<MemoryRouter><InternationalTaxes country="SK" /></MemoryRouter>);
    expect(screen.getByText("profile-form")).toBeTruthy();
    state.profiles = createInternationalFixture().storedProfiles.profiles;
    view.rerender(<MemoryRouter><InternationalTaxes country="SK" /></MemoryRouter>);
    expect(screen.getByText("intl.est.title")).toBeTruthy();
    expect(screen.getByText("intl.kpi.health")).toBeTruthy();
  });
});
