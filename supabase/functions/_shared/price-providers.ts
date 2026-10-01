export type Quote = { price: number; prev: number; pct: number };

const finite = (x: unknown) => Number.isFinite(Number(x)) && Number(x) > 0;
const pctOf = (price: number, prev: number) => (prev ? ((price - prev) / prev) * 100 : 0);

/* ----------------------------- pure parsers ----------------------------- */

export function parseYahooQuotes(json: any): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const r of json?.quoteResponse?.result ?? []) {
    const price = Number(r.regularMarketPrice);
    const prev = Number(r.regularMarketPreviousClose ?? r.regularMarketPrice);
    if (finite(price) && finite(prev)) out.set(r.symbol, { price, prev, pct: pctOf(price, prev) });
  }
  return out;
}

export function parseFinnhubQuote(symbol: string, j: any): Quote | null {
  const price = Number(j?.c), prev = Number(j?.pc);
  if (!finite(price) || !finite(prev)) return null;
  const pct = Number.isFinite(Number(j?.dp)) ? Number(j.dp) : pctOf(price, prev);
  return { price, prev, pct };
}

export function parseTwelveData(symbols: string[], json: any): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const quotes: Record<string, any> = symbols.length === 1 ? { [symbols[0]]: json } : json;
  for (const s of symbols) {
    const q = quotes?.[s];
    if (!q || q.code) continue;
    const price = Number(q.close ?? q.price);
    const prev = Number(q.previous_close);
    if (finite(price) && finite(prev)) out.set(s, { price, prev, pct: pctOf(price, prev) });
  }
  return out;
}

// Stooq EOD CSV: "Symbol,Date,Time,Open,High,Low,Close,Volume". US tickers carry a ".US" suffix.
export function parseStooqCsv(text: string): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return out;
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c.length < 7) continue;
    const sym = c[0].replace(/\.US$/i, "").toUpperCase();
    const open = Number(c[3]), close = Number(c[6]);
    if (!finite(close)) continue;
    const prev = finite(open) ? open : close;
    out.set(sym, { price: close, prev, pct: pctOf(close, prev) });
  }
  return out;
}

export function parseBinance(ticker: string, j: any): Quote | null {
  const price = Number(j?.lastPrice), pct = Number(j?.priceChangePercent);
  if (!finite(price)) return null;
  const prev = finite(j?.prevClosePrice) ? Number(j.prevClosePrice) : (pct ? price / (1 + pct / 100) : price);
  return { price, prev, pct: Number.isFinite(pct) ? pct : pctOf(price, prev) };
}

export function parseCoinGecko(tickerToId: Record<string, string>, json: any): Map<string, Quote> {
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

/* ----------------------------- fetchers (stocks) ----------------------------- */

export async function fetchYahoo(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(","))}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) continue;
      parseYahooQuotes(await r.json()).forEach((v, k) => out.set(k, v));
    } catch (_e) { /* best-effort */ }
  }
  return out;
}

export async function fetchFinnhub(symbols: string[], apiKey: string): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!apiKey) return out;
  for (const s of symbols) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${apiKey}`);
      const q = parseFinnhubQuote(s, await r.json());
      if (q) out.set(s, q);
    } catch (_e) { /* skip */ }
  }
  return out;
}

export async function fetchTwelveData(symbols: string[], apiKey: string): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!apiKey || !symbols.length) return out;
  // Free tier: 8 credits/min — fetch at most 8 symbols per invocation.
  const batch = symbols.slice(0, 8);
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(batch.join(","))}&apikey=${apiKey}`;
    const r = await fetch(url);
    parseTwelveData(batch, await r.json()).forEach((v, k) => out.set(k, v));
  } catch (_e) { /* skip */ }
  return out;
}

export async function fetchStooq(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!symbols.length) return out;
  const s = symbols.map((t) => `${t.toLowerCase()}.us`).join(",");
  try {
    const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`);
    if (r.ok) parseStooqCsv(await r.text()).forEach((v, k) => out.set(k, v));
  } catch (_e) { /* skip */ }
  return out;
}

/* ----------------------------- fetchers (crypto / fx) ----------------------------- */

export async function fetchCoinGecko(tickerToId: Record<string, string>): Promise<Map<string, Quote>> {
  const ids = Object.values(tickerToId).join(",");
  if (!ids) return new Map();
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    return parseCoinGecko(tickerToId, await r.json());
  } catch (_e) { return new Map(); }
}

export async function fetchBinance(tickers: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (const t of tickers) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${t.toUpperCase()}USDT`);
      if (!r.ok) continue;
      const q = parseBinance(t, await r.json());
      if (q) out.set(t, q);
    } catch (_e) { /* skip */ }
  }
  return out;
}

export async function fetchFxUsdCzk(): Promise<number | null> {
  // Prefer the real-time mid-market rate (Yahoo, same source as the stock quotes) — it
  // tracks USD/CZK intraday and matches what brokers convert at far better than the
  // once-a-day open.er-api rate (which can be a full day stale). Daily APIs are fallbacks.
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDCZK=X?interval=1d&range=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p && Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
  } catch (_e) { /* fall back to daily sources */ }
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    if (j?.rates?.CZK) return j.rates.CZK;
  } catch (_e) { /* try fallback */ }
  try {
    const r = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CZK");
    const j = await r.json();
    if (j?.rates?.CZK) return j.rates.CZK;
  } catch (_e) { /* give up */ }
  return null;
}
