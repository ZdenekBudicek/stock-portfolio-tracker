import { describe, it, expect } from "vitest";
import { isUsMarketOpen, usMarketSession } from "@/lib/marketHours";

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

describe("NYSE holidays and early closes", () => {
  const noon = (date: string) => `${date}T17:00:00Z`; // 12:00 or 13:00 in New York, inside any session
  it("is closed on every 2026 NYSE holiday", () => {
    for (const d of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) {
      expect(usMarketSession(new Date(noon(d)))).toMatchObject({ open: false, closedDay: "holiday" });
    }
  });

  it("moves weekend holidays to the nearest weekday, but not New Year's Day to the Friday before", () => {
    expect(usMarketSession(new Date(noon("2027-06-18"))).closedDay).toBe("holiday"); // Juneteenth on a Saturday
    expect(usMarketSession(new Date(noon("2027-07-05"))).closedDay).toBe("holiday"); // 4 July on a Sunday
    expect(usMarketSession(new Date(noon("2027-12-24"))).closedDay).toBe("holiday"); // Christmas on a Saturday
    expect(at(noon("2027-12-31"))).toBe(true); // 1. 1. 2028 is a Saturday: 31. 12. trades normally
  });

  it("closes at 13:00 New York time the day after Thanksgiving and on Christmas Eve", () => {
    expect(at("2026-11-27T17:59:00Z")).toBe(true);  // 12:59 EST
    expect(at("2026-11-27T18:00:00Z")).toBe(false); // 13:00 EST
    expect(usMarketSession(new Date("2026-12-24T15:00:00Z")).closesAt).toBe(13 * 60);
    expect(usMarketSession(new Date("2026-12-23T15:00:00Z")).closesAt).toBe(16 * 60);
  });

  it("stays open on ordinary weekdays", () => {
    expect(usMarketSession(new Date(noon("2026-10-26")))).toEqual({ open: true, closedDay: null, closesAt: 16 * 60 });
  });
});
