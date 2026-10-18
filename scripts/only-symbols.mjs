// ONLY_SYMBOLS for an on-demand run (workflow_dispatch input `symbols`): the tickers as the
// user's data spells them (case kept — aliases like 'BATSl' are case-sensitive).
//
// Absent/empty → null (a full nightly run). Present but with anything invalid → throws: a
// typo must never silently turn into a run over every user's data.
const TICKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
export const ONLY_MAX = 25;

/** @param {string | undefined} raw @returns {string[] | null} */
export function parseOnlySymbols(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const list = [...new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean))];
  const bad = list.filter((x) => !TICKER.test(x));
  if (list.length === 0 || bad.length || list.length > ONLY_MAX) {
    throw new Error(`Invalid ONLY_SYMBOLS (${bad.length ? `bad: ${bad.slice(0, 3).join(', ')}` : `count ${list.length}`}) — refusing to run`);
  }
  return list;
}
