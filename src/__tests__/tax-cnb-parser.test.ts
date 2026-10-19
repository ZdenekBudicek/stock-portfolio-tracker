import { describe, expect, it } from "vitest";
import { parseCnbCurrencies, parseCnbYear } from "../../scripts/update-cnb-rates.mjs";

describe("CNB multi-currency yearly parser", () => {
  it("retains the USD parser contract and divides quoted units", () => {
    const text = "Datum|1 USD|1 EUR|1 GBP|100 PLN\n02.01.2024|22,526|24,725|28,550|568,3\n";
    expect(parseCnbYear(text)).toEqual({ "2024-01-02": 22.526 });
    expect(parseCnbCurrencies(text)).toEqual({ "2024-01-02": { USD: 22.526, EUR: 24.725, GBP: 28.55, PLN: 5.683 } });
  });
  it("handles changing column order in repeated headers and rejects missing legs", () => {
    const text = "Datum|1 USD|1 EUR|1 GBP|1 PLN\n02.01.2024|23|25|29|5\nDatum|1 PLN|1 GBP|1 EUR|1 USD\n03.01.2024|6|30|26|24\n04.01.2024||30|26|24\n";
    expect(parseCnbCurrencies(text)).toEqual({ "2024-01-02": { USD: 23, EUR: 25, GBP: 29, PLN: 5 }, "2024-01-03": { USD: 24, EUR: 26, GBP: 30, PLN: 6 } });
    expect(parseCnbYear(text)["2024-01-04"]).toBe(24);
  });
});
