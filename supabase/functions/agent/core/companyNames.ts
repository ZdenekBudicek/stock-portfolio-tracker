// Popular company and coin names → their symbols (Běh 24): "Co se děje s CoreWeave?" names no ticker, yet everyone
// means CRWV. A small built-in map only — anything else is resolved by the market source (Finnhub symbol search when a
// key exists). Czech/Slovak case endings ("Nvidii", "Teslou", "Microsoftu") are accepted on the name stems.

type Entry = { ticker: string; name: string; stems: string[]; caseSensitive?: boolean };
const ENTRIES: Entry[] = [
  { ticker: 'CRWV', name: 'CoreWeave', stems: ['coreweave', 'core weave'] },
  { ticker: 'NBIS', name: 'Nebius Group', stems: ['nebius'] },
  { ticker: 'NVDA', name: 'Nvidia', stems: ['nvidia', 'nvidi'] },
  { ticker: 'AAPL', name: 'Apple', stems: ['apple', 'applu', 'applem'] },
  { ticker: 'MSFT', name: 'Microsoft', stems: ['microsoft'] },
  { ticker: 'TSLA', name: 'Tesla', stems: ['tesla', 'tesl'] },
  { ticker: 'META', name: 'Meta Platforms', stems: ['Meta', 'Metu', 'Mety', 'Metou', 'Metě', 'Mete', 'Meta Platforms'], caseSensitive: true },
  { ticker: 'GOOGL', name: 'Alphabet', stems: ['alphabet', 'google', 'googl'] },
  { ticker: 'AMZN', name: 'Amazon', stems: ['amazon'] },
  { ticker: 'PLTR', name: 'Palantir', stems: ['palantir'] },
  { ticker: 'AMD', name: 'Advanced Micro Devices', stems: ['advanced micro devices'] },
  { ticker: 'AVGO', name: 'Broadcom', stems: ['broadcom'] },
  { ticker: 'ORCL', name: 'Oracle', stems: ['oracle', 'oraclu', 'oraclem'] },
  { ticker: 'BTC', name: 'Bitcoin', stems: ['bitcoin'] },
  { ticker: 'ETH', name: 'Ethereum', stems: ['ethereum'] },
  { ticker: 'SOL', name: 'Solana', stems: ['solana', 'solan'] },
];
// Case endings a stem may carry (cs/sk): "Nvidii", "Teslou", "Microsoftem", "Nebiusu", "Palantiru", "Solanou".
const ENDING = '(?:a|u|y|e|ě|i|í|ou|em|om|ovi|ov|ách|ami|ím)?';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = ENTRIES.map(e => ({ e, re: e.caseSensitive
  ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${e.stems.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'u')
  : new RegExp(`(?<![\\p{L}\\p{N}])(?:${e.stems.map(escape).join('|')})${ENDING}(?![\\p{L}\\p{N}])`, 'iu') }));

/** Symbols of the popular company or coin names written in a text, in the order of the map. */
export function companyTickersIn(text: string): string[] {
  const normalized = text.normalize('NFC');
  return PATTERNS.filter(({ re }) => re.test(normalized)).map(({ e }) => e.ticker);
}
/** The symbol of an instrument written as a popular name ("CoreWeave", "nvidie", "Google"); null otherwise. */
export function companyTicker(input: string): string | null {
  const text = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  for (const { e, re } of PATTERNS) {
    const m = re.exec(text);
    // The whole input must be the name (with an optional corporate suffix), not a sentence that mentions it.
    if (m && text.replace(m[0], '').replace(/\b(?:inc|corp|corporation|group|n\.?v|plc|ltd|co)\.?/giu, '').replace(/[\s.,]/g, '') === '') return e.ticker;
  }
  return null;
}
/** The company name of a built-in symbol (search keywords when no stored profile exists). */
export const companyName = (ticker: string): string | null => ENTRIES.find(e => e.ticker === ticker.toUpperCase())?.name ?? null;
