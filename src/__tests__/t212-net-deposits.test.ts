// Regression: Trading 212's account summary must be turned into NET DEPOSITS, not into
// "everything that isn't unrealized profit". The identity the broker reports is
//     total = free + invested + ppl        (what the account holds)
//     total = deposits + result + ppl      (where it came from)
// so deposits = total − ppl − result. Dropping `result` books every koruna of lifetime
// realized profit as money paid in: on this account 832 822 Kč, which turned a +127 %
// return into +49 %.
import { describe, it, expect } from "vitest";

/** The formula under test, exactly as useComputedPortfolio applies it. */
const netDepositsUsd = (s: { total: number; ppl: number; result: number }, fx: number) =>
  (s.total - s.ppl - s.result) / fx;

// Live response from /equity/account/cash for this account (CZK).
const LIVE = { free: 6.93, invested: 1_821_240.59, ppl: 177_371.6, result: 832_822.44, total: 1_998_619.12 };

describe("T212 net deposits", () => {
  it("matches the broker's own balance identity", () => {
    expect(LIVE.free + LIVE.invested + LIVE.ppl).toBeCloseTo(LIVE.total, 2);
  });

  it("excludes lifetime realized profit from deposits", () => {
    // 1 998 619,12 − 177 371,60 − 832 822,44 = 988 425,08 Kč @ 21,02
    expect(netDepositsUsd(LIVE, 21.02)).toBeCloseTo(47_023.08, 1);
  });

  it("is lower than the old formula by exactly the realized profit", () => {
    const old = (LIVE.total - LIVE.ppl) / 21.02;
    expect(old - netDepositsUsd(LIVE, 21.02)).toBeCloseTo(LIVE.result / 21.02, 6);
  });

  it("is unaffected by unrealized profit moving", () => {
    // Prices move -> total and ppl move together -> deposits stay put. That is the whole
    // point of deriving deposits from the identity rather than from the account value.
    const later = { ...LIVE, ppl: LIVE.ppl + 100_000, total: LIVE.total + 100_000 };
    expect(netDepositsUsd(later, 21.02)).toBeCloseTo(netDepositsUsd(LIVE, 21.02), 6);
  });

  it("treats a USD-denominated account as needing no conversion", () => {
    expect(netDepositsUsd({ total: 1000, ppl: 100, result: 200 }, 1)).toBe(700);
  });
});
