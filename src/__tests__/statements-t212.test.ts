import { describe, it, expect } from "vitest";
import { parseT212Activity, parseT212Account, parseRevolutAccount } from "../lib/statements";

// Real column layout of a Trading 212 "Výpis aktivit" (Účet Invest – uskutečněné obchody):
// ČAS | INSTRUMENT | ISIN | MĚNA | ID PŘÍKAZU | SMĚR | MNOŽSTVÍ | PROVEDENÍ | HODNOTA |
// TYP | MÍSTO | RELACE | FX POMĚR | MĚNA TRANSAKCE | FX POPLATEK | POPLATKY | NÁVRATNOST | HODNOTA
const header = [
  "ZÁKAZNICKÉ ID  JMÉNO ZÁKAZNÍKA",
  " 9000001  Jan Novak",
  " Výpis aktivit",
  " Číslo účtu: 1234567  Číslo účtu: 87654321",
  " Účet Invest - uskutečněné obchody",
];

describe("parseT212Activity", () => {
  it("parses a normal trade row (qty, price, value all present)", () => {
    const text = [...header,
      "2025-01-07 11:45:22   ASML   USN070592100   USD   26200811995   Koupit   1.3924424   776.19   1080.7999   Trh   OTC   Předběžný trh   1   USD   -   -   -   1080.8",
    ].join("\n");
    const rows = parseT212Activity(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      broker: "T212", kind: "TRADE", ticker: "ASML", isin: "USN070592100", ccy: "USD",
      side: "BUY", shares: 1.3924424, price_ccy: 776.19, value_ccy: 1080.7999,
      external_id: "t212:act:26200811995",
    });
  });

  // Regression: T212 leaves the per-trade HODNOTA cell empty on some rows (seen on large
  // sells). The old regex demanded three numbers after the side and silently DROPPED the
  // whole trade — a 909.6-share NU sell vanished, leaving the position ~2x too big.
  it("parses a trade row whose HODNOTA (value) cell is missing", () => {
    const text = [...header,
      "2026-06-16 16:28:57   NU   KYG6683N1034   USD   52764143703   Prodat   909.60208779   12.67   Trh   OTC   Běžné hodiny   1   USD   -   -   -3001.99   11524.66",
    ].join("\n");
    const rows = parseT212Activity(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "TRADE", ticker: "NU", side: "SELL", shares: 909.60208779, price_ccy: 12.67,
      external_id: "t212:act:52764143703",
    });
    // value is derived from qty × price when the column is absent
    expect(rows[0].value_ccy).toBeCloseTo(909.60208779 * 12.67, 2);
  });

  it("never lets the trailing HODNOTA column be mistaken for the trade value", () => {
    // qty 909.60208779 × 12.67 = 11524.7 -> must NOT pick up 11524.66 as `value` for a
    // row where the value column IS missing, nor mis-assign the FX ratio.
    const text = [...header,
      "2026-06-16 16:28:57   NU   KYG6683N1034   USD   52764143703   Prodat   909.60208779   12.67   Trh   OTC   Běžné hodiny   1   USD   -   -   -3001.99   11524.66",
    ].join("\n");
    const r = parseT212Activity(text)[0];
    expect(r.shares).toBe(909.60208779);
    expect(r.price_ccy).toBe(12.67);
  });

  it("deduplicates repeated order ids", () => {
    const line = "2025-01-07 11:45:22   ASML   USN070592100   USD   26200811995   Koupit   1.3924424   776.19   1080.7999   Trh   OTC   Předběžný trh   1   USD   -   -   -   1080.8";
    expect(parseT212Activity([...header, line, line].join("\n"))).toHaveLength(1);
  });

  it("tags every row with the Invest account the statement belongs to", () => {
    const text = [...header,
      "2025-01-07 11:45:22   ASML   USN070592100   USD   26200811995   Koupit   1.3924424   776.19   1080.7999   Trh   OTC   Předběžný trh   1   USD   -   -   -   1080.8",
    ].join("\n");
    expect(parseT212Activity(text)[0].account).toBe("1234567");
  });
});

describe("parseT212Account", () => {
  it("reads the Invest account number (first 'Číslo účtu')", () => {
    expect(parseT212Account(header.join("\n"))).toBe("1234567");
  });
  it("falls back to the customer id when no account number is printed", () => {
    expect(parseT212Account("ZÁKAZNICKÉ ID  JMÉNO ZÁKAZNÍKA\n 9604040  Jan Novak\n Výpis aktivit")).toBe("9604040");
  });
  it("returns null for a non-T212 document", () => {
    expect(parseT212Account("Account Statement\nGenerated on the 22 Jul 2026")).toBeNull();
  });
});

describe("parseRevolutAccount", () => {
  it("reads the Revolut account number", () => {
    expect(parseRevolutAccount("Josefa Hory Period   01 Feb 2025 - 22 Jul 2026\nAccount number   12345678\nTřešť")).toBe("12345678");
  });
  it("returns null when absent", () => {
    expect(parseRevolutAccount("no account here")).toBeNull();
  });
});
