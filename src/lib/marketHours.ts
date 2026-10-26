// US regular session, 9:30–16:00 in New York, Mon–Fri. Read on the New York clock, not as
// fixed UTC hours: the UTC window moves by an hour when US daylight saving time starts and
// ends (it ends on 1. 11. 2026), and "13:30–20:00 UTC" is right only half of the year.
// NYSE holidays and its 13:00 early closes follow the exchange's published rules; a one-off
// closure (a national day of mourning) is not modelled.

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const EARLY_CLOSE = 13 * 60;

/** Day of the week (0 = Sunday) of a calendar date; month is 1-based. */
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const key = (y: number, m: number, d: number) => `${y}-${m}-${d}`;
const shift = (y: number, m: number, d: number, days: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()] as const;
};
/** The n-th given weekday of a month (n = -1: the last one). */
const nthWeekday = (y: number, m: number, wd: number, n: number) => {
  if (n > 0) return 1 + ((wd - weekday(y, m, 1) + 7) % 7) + (n - 1) * 7;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((weekday(y, m, last) - wd + 7) % 7);
};
/** Easter Sunday (anonymous Gregorian algorithm). */
const easter = (y: number) => {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1] as const;
};
/** A fixed-date holiday on Saturday is observed on Friday, on Sunday on Monday. */
const observed = (y: number, m: number, d: number) => {
  const wd = weekday(y, m, d);
  return wd === 6 ? shift(y, m, d, -1) : wd === 0 ? shift(y, m, d, 1) : ([y, m, d] as const);
};

const cache = new Map<number, { holidays: Set<string>; early: Set<string> }>();
function calendar(y: number) {
  const hit = cache.get(y);
  if (hit) return hit;
  const holidays = new Set<string>();
  const add = (date: readonly [number, number, number]) => holidays.add(key(...date));
  // New Year's Day on a Saturday is not moved to the Friday before (NYSE rule 7.2).
  if (weekday(y, 1, 1) !== 6) add(observed(y, 1, 1));
  add([y, 1, nthWeekday(y, 1, 1, 3)]); // Martin Luther King Jr. Day
  add([y, 2, nthWeekday(y, 2, 1, 3)]); // Washington's Birthday
  const [em, ed] = easter(y);
  add(shift(y, em, ed, -2)); // Good Friday
  add([y, 5, nthWeekday(y, 5, 1, -1)]); // Memorial Day
  if (y >= 2022) add(observed(y, 6, 19)); // Juneteenth
  add(observed(y, 7, 4));
  add([y, 9, nthWeekday(y, 9, 1, 1)]); // Labor Day
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  add([y, 11, thanksgiving]);
  add(observed(y, 12, 25));
  const early = new Set<string>();
  const earlyIfOpen = (m: number, d: number) => {
    const wd = weekday(y, m, d);
    if (wd !== 0 && wd !== 6 && !holidays.has(key(y, m, d))) early.add(key(y, m, d));
  };
  earlyIfOpen(7, 3);
  earlyIfOpen(11, thanksgiving + 1);
  earlyIfOpen(12, 24);
  const out = { holidays, early };
  cache.set(y, out);
  return out;
}

export type UsMarketSession = {
  open: boolean;
  /** Why the market is closed for the whole day, if it is. */
  closedDay: 'weekend' | 'holiday' | null;
  /** Today's closing time in New York minutes after midnight (13:00 on an early-close day). */
  closesAt: number;
};

export function usMarketSession(now: Date): UsMarketSession {
  const p = Object.fromEntries(NY.formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const wd = weekday(y, m, d);
  const { holidays, early } = calendar(y);
  const closesAt = early.has(key(y, m, d)) ? EARLY_CLOSE : CLOSE;
  const closedDay = wd === 0 || wd === 6 ? 'weekend' : holidays.has(key(y, m, d)) ? 'holiday' : null;
  return { open: !closedDay && minutes >= OPEN && minutes < closesAt, closedDay, closesAt };
}

export function isUsMarketOpen(now: Date): boolean {
  return usMarketSession(now).open;
}
