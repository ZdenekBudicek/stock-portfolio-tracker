import { finite, parseBinance, parseCoinGecko, parseFinnhubQuote, parseTwelveData, pctOf, type Quote } from "./price-parsers.ts";

// The provider-neutral parsers live in price-parsers.ts so the agent Edge function can import
// them without this module's fetchers (Yahoo among them); re-exported for existing callers.
export { parseBinance, parseCoinGecko, parseFinnhubQuote, parseTwelveData } from "./price-parsers.ts";
export type { Quote } from "./price-parsers.ts";

/* ----------------------------- pure parsers ----------------------------- */

export function parseYahooQuotes(json: { quoteResponse?: { result?: { symbol: string; regularMarketPrice?: unknown; regularMarketPreviousClose?: unknown }[] } }): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const r of json?.quoteResponse?.result ?? []) {
    const price = Number(r.regularMarketPrice);
    const prev = Number(r.regularMarketPreviousClose ?? r.regularMarketPrice);
    if (finite(price) && finite(prev)) out.set(r.symbol, { price, prev, pct: pctOf(price, prev) });
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

export type FinnhubOptions = {
  /** Most calls this run (free tier: 60/min). Default: all symbols. */
  maxCalls?: number;
  /** Minimum spacing between call starts in ms (1100 ≈ 55/min). Default 0 (no pacing). */
  minIntervalMs?: number;
  /** Epoch ms after which no further call is started. */
  deadline?: number;
  /** Filled with every symbol a call was made for (to tell "failed" from "not tried"). */
  attempted?: Set<string>;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Finnhub quotes, one call per symbol, in the given order (callers put the stalest first).
 * Paced so a run stays under the free tier's 60 calls/min, and it STOPS on HTTP 429: the
 * symbols not reached stay for the next run instead of all failing against the rate limit.
 */
export async function fetchFinnhub(symbols: string[], apiKey: string, opts: FinnhubOptions = {}): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!apiKey) return out;
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const max = opts.maxCalls ?? symbols.length;
  let calls = 0;
  let lastStart = -Infinity;
  for (const s of symbols) {
    if (calls >= max) break;
    const gap = (opts.minIntervalMs ?? 0) - (now() - lastStart);
    if (gap > 0) await wait(gap);
    if (opts.deadline != null && now() >= opts.deadline) break;
    lastStart = now();
    calls++;
    opts.attempted?.add(s);
    try {
      const r = await doFetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${apiKey}`);
      if (r.status === 429) { opts.attempted?.delete(s); break; } // rate limited: leave the rest for the next run
      const q = parseFinnhubQuote(s, await r.json());
      if (q) out.set(s, q);
    } catch (_e) { /* skip */ }
  }
  return out;
}

/* ----------------------------- PostgREST paging ----------------------------- */

type PageResult<T> = { data: T[] | null; error: { message?: string } | null };

/**
 * Every row of a select. PostgREST caps one response at 1000 rows, so a plain select silently
 * drops the rest; pass a query with a deterministic ORDER BY (paging an unordered select can
 * skip or repeat rows). A failed read THROWS — it must never look like "no rows".
 */
export async function fetchAllRows<T>(label: string, page: (from: number, to: number) => PromiseLike<PageResult<T>>, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += pageSize) {
    const { data, error } = await page(f, f + pageSize - 1);
    if (error) throw new Error(`read ${label} failed: ${error.message ?? error}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

/** Rows for the given symbols, `.in("symbol", …)` in chunks (URL length) and fully paged. */
export async function fetchRowsBySymbols<T>(
  symbols: string[],
  query: (chunk: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
  chunkSize = 100,
): Promise<T[]> {
  const uniq = [...new Set(symbols)];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    out.push(...await fetchAllRows(label, (f, t) => query(chunk, f, t)));
  }
  return out;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Latest positive close per symbol from price_history. Per chunk of 50 symbols it reads only
 * the last `windowDays` (ordered symbol, date desc, fully paged) and keeps the first row per
 * symbol; a symbol with nothing in that window gets one `limit(1)` query of its own. Never the
 * newest N rows globally, which drops symbols whose latest close is older than the others'.
 */
export async function latestCloses(client: Pick<import("./t212-types.ts").T212Client, "from">, symbols: string[], opts: { windowDays?: number; now?: number } = {}): Promise<Map<string, { date: string; close: number }>> {
  const since = isoDay((opts.now ?? Date.now()) - (opts.windowDays ?? 14) * 86_400_000);
  const out = new Map<string, { date: string; close: number }>();
  const rows = await fetchRowsBySymbols(symbols, (chunk, f, t) => client.from("price_history").select("symbol,date,close")
    .in("symbol", chunk).gt("close", 0).gte("date", since)
    .order("symbol", { ascending: true }).order("date", { ascending: false }).range(f, t), "price_history", 50);
  for (const r of rows) if (!out.has(r.symbol)) out.set(r.symbol, { date: String(r.date), close: Number(r.close) });
  for (const s of new Set(symbols)) {
    if (out.has(s)) continue;
    const { data, error } = await client.from("price_history").select("symbol,date,close")
      .eq("symbol", s).gt("close", 0).order("date", { ascending: false }).limit(1);
    if (error) throw new Error(`read price_history failed: ${error.message ?? error}`);
    const r = (data ?? [])[0];
    if (r) out.set(s, { date: String(r.date), close: Number(r.close) });
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

/** CZK per 1 EUR / GBP / PLN right now (for the app's display currencies); null when unavailable. */
export async function fetchFxCzk(currency: "EUR" | "GBP" | "PLN"): Promise<number | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${currency}CZK=X?interval=1d&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p && Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
  } catch (_e) { /* fall back to the daily source */ }
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${currency}`);
    const j = await r.json();
    if (Number(j?.rates?.CZK) > 0) return Number(j.rates.CZK);
  } catch (_e) { /* give up */ }
  return null;
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
