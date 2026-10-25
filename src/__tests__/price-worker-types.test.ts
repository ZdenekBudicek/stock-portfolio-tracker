import { beforeAll, describe, expect, it } from 'vitest';
import { isCryptoHolding } from '../../supabase/functions/_shared/crypto.js';

let declaredTypes: (rows: { ticker: string; type: string | null; user_id: string }[]) => Map<string, string>;
beforeAll(async () => {
  // price-worker reads its env at import; give it dummies (main() only runs when executed directly).
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:1'; process.env.SUPABASE_SERVICE_KEY ??= 'dummy';
  ({ declaredTypes } = await import('../../scripts/price-worker.mjs'));
});
// What the worker finally prices: crypto (a coin pair) or the security.
const pricedAsCrypto = (ticker: string, rows: { type: string | null; user_id: string }[]) =>
  isCryptoHolding(ticker, declaredTypes(rows.map(r => ({ ...r, ticker }))).get(ticker));

describe('shared instrument type by the explicit holders\' majority (audit + codex review)', () => {
  it('an explicit ETF is not overridden by default "Stock" rows nor by a single "Crypto"', () => {
    expect(pricedAsCrypto('NEAR', [{ type: 'ETF', user_id: 'a' }, { type: 'Stock', user_id: 'b' }, { type: 'Stock', user_id: 'c' }])).toBe(false);
    expect(pricedAsCrypto('ATOM', [{ type: 'ETF', user_id: 'a' }, { type: 'ETF', user_id: 'b' }, { type: 'Crypto', user_id: 'c' }])).toBe(false);
    expect(pricedAsCrypto('ATOM', [{ type: 'ETF', user_id: 'a' }, { type: 'Crypto', user_id: 'b' }])).toBe(false);
  });
  it('an explicit crypto majority, or no explicit type for a coin ticker, prices the coin', () => {
    expect(pricedAsCrypto('ATOM', [{ type: 'Crypto', user_id: 'a' }, { type: 'Crypto', user_id: 'b' }, { type: 'ETF', user_id: 'c' }])).toBe(true);
    expect(pricedAsCrypto('BTC', [{ type: 'Stock', user_id: 'a' }])).toBe(true);
    expect(declaredTypes([{ ticker: 'Y', type: 'Crypto', user_id: 'a' }, { ticker: 'Y', type: 'Crypto', user_id: 'a' }, { ticker: 'Y', type: 'ETF', user_id: 'b' }]).get('Y')).toBe('ETF');
  });
  it('a non-coin ticker is never crypto whatever anyone types', () => {
    expect(pricedAsCrypto('AAPL', [{ type: 'Crypto', user_id: 'a' }])).toBe(false);
  });
});
