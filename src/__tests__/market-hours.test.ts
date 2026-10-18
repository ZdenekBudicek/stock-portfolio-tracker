import { describe, it, expect } from "vitest";
import { isUsMarketOpen } from "@/lib/marketHours";

const at = (iso: string) => isUsMarketOpen(new Date(iso));

describe("isUsMarketOpen", () => {
  it("opens at 9:30 New York time while US daylight saving time is on (13:30 UTC)", () => {
    expect(at("2026-10-30T13:29:00Z")).toBe(false);
    expect(at("2026-10-30T13:30:00Z")).toBe(true);
    expect(at("2026-10-30T19:59:00Z")).toBe(true);
    expect(at("2026-10-30T20:00:00Z")).toBe(false);
  });

  it("follows New York after daylight saving time ends on 1. 11. 2026 (14:30–21:00 UTC)", () => {
    expect(at("2026-11-02T13:45:00Z")).toBe(false); // 8:45 EST — fixed UTC hours said open
    expect(at("2026-11-02T14:30:00Z")).toBe(true);
    expect(at("2026-11-02T20:30:00Z")).toBe(true);  // 15:30 EST — fixed UTC hours said closed
    expect(at("2026-11-02T21:00:00Z")).toBe(false);
  });

  it("is closed at weekends on the New York calendar", () => {
    expect(at("2026-10-31T15:00:00Z")).toBe(false); // Saturday
    expect(at("2026-11-01T15:00:00Z")).toBe(false); // Sunday
    // Friday 23:30 in New York is already Saturday in UTC — still a closed Friday evening.
    expect(at("2026-10-31T03:30:00Z")).toBe(false);
  });
});
