// The donut's data derivation, as a pure function. Getting the resolution order or the
// lookup key wrong is invisible in the UI — the chart just shows "Ostatní" and looks
// exactly like a broken sync — so every rung of the chain is pinned here.
import { describe, it, expect, vi } from "vitest";

// useTickerProfiles imports the Supabase client (and, through usePortfolio, useExtras).
// Instantiating it needs VITE_ env vars that do not exist under vitest; nothing below
// touches the network, so a stub is enough. Same approach as import-plan-scope.test.ts.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({}) } }));

const { resolveSector, buildProfileMap } = await import("@/hooks/useTickerProfiles");

const profiles = (...rows: [string, string | null][]) =>
  buildProfileMap(rows.map(([ticker, sector]) => ({ ticker, sector })), []);

describe("resolveSector — pořadí zdrojů", () => {
  it("manuální sektor v positions přebíjí API", () => {
    // Hand-typed override wins even when the API disagrees: the autofill trigger is gone,
    // so anything in positions.sector was put there by a human.
    expect(resolveSector("NBIS", "Moje škatulka", profiles(["NBIS", "Technologie"]))).toBe("Moje škatulka");
  });

  it("API přebíjí statickou mapu", () => {
    // AAPL is "Technologie" in TICKER_SECTORS; the API answer must be what shows.
    expect(resolveSector("AAPL", null, profiles(["AAPL", "Zdravotnictví"]))).toBe("Zdravotnictví");
  });

  it("statická mapa se použije, když API ticker nezná", () => {
    expect(resolveSector("AAPL", null, profiles(["MSFT", "Technologie"]))).toBe("Technologie");
  });

  it("statická mapa se použije i bez načtených profilů", () => {
    expect(resolveSector("RKLB", null, undefined)).toBe("Letectví & obrana");
    expect(resolveSector("RKLB", null, null)).toBe("Letectví & obrana");
  });

  it("neznámý ticker končí na Ostatní", () => {
    expect(resolveSector("NBIS", null, profiles())).toBe("Ostatní");
    expect(resolveSector("MELI", null, undefined)).toBe("Ostatní");
  });

  it("NBIS a MELI — dnes 17,6 % v Ostatní — dostanou sektor z API", () => {
    const p = profiles(["NBIS", "Technologie"], ["MELI", "Spotřební zboží"]);
    expect(resolveSector("NBIS", null, p)).toBe("Technologie");
    expect(resolveSector("MELI", null, p)).toBe("Spotřební zboží");
  });
});

describe("resolveSector — prázdné hodnoty propadávají dál", () => {
  it("prázdný manuální sektor není override", () => {
    const p = profiles(["NBIS", "Technologie"]);
    expect(resolveSector("NBIS", "", p)).toBe("Technologie");
    expect(resolveSector("NBIS", "   ", p)).toBe("Technologie");
    expect(resolveSector("NBIS", null, p)).toBe("Technologie");
  });

  it("nevyřešený profil (sector NULL) propadne na statickou mapu, ne na prázdný řádek", () => {
    // Every row the providers came back empty on looks like this.
    expect(resolveSector("AAPL", null, profiles(["AAPL", null]))).toBe("Technologie");
    expect(resolveSector("NBIS", null, profiles(["NBIS", null]))).toBe("Ostatní");
  });
});

describe("resolveSector — klíč se hledá stejně, jak ho zapisují writery", () => {
  it("ticker se dohledá bez ohledu na velikost písmen", () => {
    // ticker_profiles.ticker is a case-sensitive text PK and both writers upper-case, so a
    // position held as 'batsl' must still find the row filed as 'BATSL'.
    const p = profiles(["BATSL", "Spotřební zboží"]);
    expect(resolveSector("batsl", null, p)).toBe("Spotřební zboží");
    expect(resolveSector("BATSl", null, p)).toBe("Spotřební zboží");
    expect(resolveSector(" batsl ", null, p)).toBe("Spotřební zboží");
  });

  it("statická mapa se hledá taky přes upper-case", () => {
    expect(resolveSector("aapl", null, profiles())).toBe("Technologie");
  });
});

describe("buildProfileMap — ticker_alias", () => {
  const rows = [{ ticker: "META", sector: "Technologie" }];

  it("pozice držená pod aliasem najde profil kanonického tickeru", () => {
    // sync-sectors files FB's profile under META; a position still held as FB must find it.
    const map = buildProfileMap(rows, [{ alias: "FB", canonical: "META" }]);
    expect(resolveSector("FB", null, map)).toBe("Technologie");
    expect(resolveSector("META", null, map)).toBe("Technologie");
  });

  it("alias se páruje case-insensitive (ticker_alias má smíšenou velikost)", () => {
    const map = buildProfileMap(
      [{ ticker: "BATSL", sector: "Spotřební zboží" }],
      [{ alias: "BATSl", canonical: "BATSl" }],
    );
    expect(resolveSector("BATSl", null, map)).toBe("Spotřební zboží");
  });

  it("alias bez existujícího profilu se nepřidá", () => {
    const map = buildProfileMap(rows, [{ alias: "IPOE", canonical: "SOFI" }]);
    expect(map.get("IPOE")).toBeUndefined();
    // …a padá na statickou mapu, kde IPOE není, ale to je pořád jen "Ostatní", ne prázdno.
    expect(resolveSector("IPOE", null, map)).toBe("Ostatní");
  });

  it("alias nikdy nepřepíše skutečný řádek profilu", () => {
    // A bogus alias row must not redirect a ticker that has its own profile.
    const map = buildProfileMap(
      [{ ticker: "META", sector: "Technologie" }, { ticker: "SOFI", sector: "Fintech" }],
      [{ alias: "SOFI", canonical: "META" }],
    );
    expect(resolveSector("SOFI", null, map)).toBe("Fintech");
  });

  it("prázdný canonical ticker nikam nemapuje", () => {
    const map = buildProfileMap(rows, [{ alias: "FB", canonical: "" }]);
    expect(map.get("FB")).toBeUndefined();
  });

  it("nevyřešený profil pod aliasem propadne na statickou mapu kanonického tickeru", () => {
    // FB is not in TICKER_SECTORS; META is. The canonical comes from the profile row.
    const map = buildProfileMap([{ ticker: "META", sector: null }], [{ alias: "FB", canonical: "META" }]);
    expect(resolveSector("FB", null, map)).toBe("Technologie");
  });
});
