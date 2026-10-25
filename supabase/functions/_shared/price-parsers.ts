// Pure quote parsers: no fetch, no hosts. Shared by price-providers.ts (cron fetchers) and the
// agent Edge function, which must not bundle the Yahoo fetchers.
export type Quote = { price: number; prev: number; pct: number };

export const finite = (x: unknown) => Number.isFinite(Number(x)) && Number(x) > 0;
export const pctOf = (price: number, prev: number) => (prev ? ((price - prev) / prev) * 100 : 0);

export function parseFinnhubQuote(symbol: string, j: { c?: unknown; pc?: unknown; dp?: unknown }): Quote | null {
  const price = Number(j?.c), prev = Number(j?.pc);
  if (!finite(price) || !finite(prev)) return null;
  const pct = Number.isFinite(Number(j?.dp)) ? Number(j.dp) : pctOf(price, prev);
  return { price, prev, pct };
}

interface TwelveQuote { message?: string; code?: unknown; close?: unknown; price?: unknown; previous_close?: unknown }

export function parseTwelveData(symbols: string[], json: TwelveQuote | Record<string, TwelveQuote>): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const quotes: Record<string, TwelveQuote> = symbols.length === 1 ? { [symbols[0]]: json as TwelveQuote } : json as Record<string, TwelveQuote>;
  for (const s of symbols) {
    const q = quotes?.[s];
    if (!q || q.code) continue;
    const price = Number(q.close ?? q.price);
    const prev = Number(q.previous_close);
    if (finite(price) && finite(prev)) out.set(s, { price, prev, pct: pctOf(price, prev) });
  }
  return out;
}

export function parseBinance(ticker: string, j: { lastPrice?: unknown; priceChangePercent?: unknown; prevClosePrice?: unknown }): Quote | null {
  const price = Number(j?.lastPrice), pct = Number(j?.priceChangePercent);
  if (!finite(price)) return null;
  const prev = finite(j?.prevClosePrice) ? Number(j.prevClosePrice) : (pct ? price / (1 + pct / 100) : price);
  return { price, prev, pct: Number.isFinite(pct) ? pct : pctOf(price, prev) };
}

export function parseCoinGecko(tickerToId: Record<string, string>, json: Record<string, { usd?: number; usd_24h_change?: number }>): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const [ticker, id] of Object.entries(tickerToId)) {
    const q = json?.[id];
    if (q?.usd) {
      const pct = q.usd_24h_change ?? 0;
      out.set(ticker, { price: q.usd, prev: pct ? q.usd / (1 + pct / 100) : q.usd, pct });
    }
  }
  return out;
}
