import type { InstrumentRegistry } from '../_lib/trackora-lib.js';
import type { TickerResolution } from './marketTypes.ts';
import { CRYPTO_TO_GECKO, CRYPTO_YAHOO } from '../../_shared/crypto.js';
import { companyName, companyTicker } from './companyNames.ts';

export const validTicker = (value: string) => /^[A-Z][A-Z0-9.-]{0,19}$/.test(value);
const up = (value: string) => value.trim().toUpperCase();
const collisions = new Set(['LTC', 'TRX', 'ATOM', 'APT', 'NEAR', 'LINK']);

/**
 * Registry first (aliases, held names, profiles, coin collisions); a popular company name outside it ("CoreWeave") is
 * its built-in symbol (Běh 24).
 */
export function resolveMarketTicker(input: string, registry: InstrumentRegistry): TickerResolution {
  const local = resolveRegistryTicker(input, registry);
  if (local.status !== 'unknown') return local;
  // The built-in names' own symbols (CRWV, NVDA…) are known instruments too.
  const named = companyTicker(input) ?? (companyName(up(input)) ? up(input) : null);
  if (!named) return local;
  const held = named === up(input) ? local : resolveRegistryTicker(named, registry);
  return held.status === 'resolved' ? held : { status: 'resolved', ticker: named, assetType: CRYPTO_TO_GECKO[named] ? 'crypto' : 'stock' };
}
function resolveRegistryTicker(input: string, registry: InstrumentRegistry): TickerResolution {
  const text = up(input);
  // A coin name equal to some ticker ("near" = NEAR) is a ticker spelling, so the collision check below decides it.
  const coin = CRYPTO_TO_GECKO[text] ? undefined
    : Object.keys(CRYPTO_TO_GECKO).find(t => up(CRYPTO_TO_GECKO[t]) === text || CRYPTO_YAHOO[t] === text);
  if (coin) return { status: 'resolved', ticker: coin, assetType: 'crypto' };
  const matches = new Map<string, Set<'stock' | 'etf' | 'crypto'>>();
  const add = (ticker: string, kind: 'stock' | 'etf' | 'crypto') => {
    if (!validTicker(ticker)) return;
    if (!matches.has(ticker)) matches.set(ticker, new Set());
    matches.get(ticker)!.add(kind);
  };
  const canonicals = new Set(registry.aliases.filter(a => up(a.alias) === text || up(a.canonical) === text).map(a => up(a.canonical)));
  for (const p of registry.positions) if (up(p.ticker) === text || up(p.name ?? '') === text) canonicals.add(up(p.ticker));
  for (const p of registry.profiles) if (up(p.ticker) === text) canonicals.add(up(p.ticker));
  for (const ticker of canonicals) {
    const pins = registry.aliases.filter(a => up(a.canonical) === ticker && a.yahoo_symbol);
    for (const pin of pins) add(ticker, Object.values(CRYPTO_YAHOO).includes(pin.yahoo_symbol!) ? 'crypto' : 'stock');
    const profiles = registry.profiles.filter(p => up(p.ticker) === ticker);
    for (const p of profiles) {
      if (/crypto/i.test(p.asset_type)) add(ticker, 'crypto');
      else if (/etf|fund/i.test(p.asset_type)) add(ticker, 'etf');
      else if (/stock|equity/i.test(p.asset_type)) add(ticker, 'stock');
    }
    if (!matches.has(ticker)) {
      const types = registry.positions.filter(p => up(p.ticker) === ticker).map(p => p.type);
      if (types.some(t => /crypto/i.test(t))) add(ticker, 'crypto');
      else if (types.some(t => /etf|fund/i.test(t))) add(ticker, 'etf');
      else if (!collisions.has(ticker)) add(ticker, CRYPTO_TO_GECKO[ticker] ? 'crypto' : 'stock');
      else { add(ticker, 'stock'); add(ticker, 'crypto'); }
    }
  }
  if (!matches.size && validTicker(text) && CRYPTO_TO_GECKO[text]) {
    add(text, 'crypto'); if (collisions.has(text)) add(text, 'stock');
  }
  const candidates = [...matches.keys()].sort();
  if (candidates.length === 1 && matches.get(candidates[0])!.size === 1) {
    return { status: 'resolved', ticker: candidates[0], assetType: [...matches.get(candidates[0])!][0] };
  }
  return { status: candidates.length ? 'ambiguous' : 'unknown', candidates };
}
