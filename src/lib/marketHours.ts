// US regular session, 9:30–16:00 in New York, Mon–Fri. Read on the New York clock, not as
// fixed UTC hours: the UTC window moves by an hour when US daylight saving time starts and
// ends (it ends on 1. 11. 2026), and "13:30–20:00 UTC" is right only half of the year.
// Exchange holidays and early closes are not modelled.

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function isUsMarketOpen(now: Date): boolean {
  const parts = Object.fromEntries(NY.formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
