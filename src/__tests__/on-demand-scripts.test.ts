import { describe, expect, it } from 'vitest';
import { parseOnlySymbols } from '../../scripts/only-symbols.mjs';
import { finishRequests } from '../../scripts/finish-fundamentals-requests.mjs';

const reply = (body: unknown, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status });

describe('parseOnlySymbols', () => {
  it('keeps the case of tickers and treats an absent input as a full run', () => {
    expect(parseOnlySymbols('NBIS, BATSl ,NBIS')).toEqual(['NBIS', 'BATSl']);
    expect(parseOnlySymbols(undefined)).toBeNull();
    expect(parseOnlySymbols('')).toBeNull();
  });
  it('refuses an invalid list instead of silently running for everyone', () => {
    expect(() => parseOnlySymbols('!!!')).toThrow('Invalid ONLY_SYMBOLS');
    expect(() => parseOnlySymbols('A;rm -rf')).toThrow('Invalid ONLY_SYMBOLS');
    expect(() => parseOnlySymbols(Array.from({ length: 30 }, (_, i) => `T${i}`).join(','))).toThrow('count 30');
  });
});

describe('finishRequests', () => {
  it('marks done only with stored statements and notes missing prices', async () => {
    const posted: unknown[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posted.push(...JSON.parse(String(init.body))); return reply(null, 201); }
      if (url.includes('/ticker_alias?')) return reply([{ alias: 'FB', canonical: 'META' }]);
      if (url.includes('/company_fundamentals?')) return reply([
        { symbol: 'META', status: 'ok', annual: ['2025-12-31'], quarterly: [] },
        { symbol: 'VUSA', status: 'error', last_error: 'Yahoo returned no usable fundamentals', annual: [], quarterly: [] },
      ]);
      if (url.includes('/price_history?')) return reply([{ symbol: 'FB' }]);
      throw new Error('unexpected ' + url);
    };
    const out = await finishRequests({ url: 'https://db.example', key: 'k', tickers: ['FB', 'VUSA'], fetchFn: fetchFn as typeof fetch, now: 0 });
    expect(out.map((o) => [o.symbol, o.status])).toEqual([['META', 'done'], ['VUSA', 'failed']]);
    expect(out[1].last_error).toContain('price history: none');
    expect(posted).toHaveLength(2);
  });
});
