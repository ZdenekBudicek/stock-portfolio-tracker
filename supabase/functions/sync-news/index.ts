// Pull recent Yahoo Finance news (headline + summary) for every held/watchlisted ticker,
// translate both to Czech (Google Translate free endpoint), and store in stock_news. The
// stock detail page shows the headline; clicking it expands the Czech summary, then links
// out to the source. Yahoo's RSS feed carries a real summary paragraph per item.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME_BUDGET = 135_000;

function decode(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function publisherFromUrl(url: string): string {
  try { const h = new URL(url).hostname.replace(/^www\./, ""); return h === "finance.yahoo.com" ? "Yahoo Finance" : h; } catch { return ""; }
}

async function fetchRss(sym: string): Promise<{ title: string; summary: string; url: string; ts: number | null }[]> {
  try {
    const r = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`, { headers: UA });
    if (!r.ok) return [];
    const xml = await r.text();
    const out: { title: string; summary: string; url: string; ts: number | null }[] = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const title = decode((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? "");
      const summary = decode((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] ?? "");
      const url = decode((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] ?? "");
      const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
      const t = pub ? Math.floor(new Date(pub).getTime() / 1000) : null;
      if (title) out.push({ title, summary: summary.slice(0, 600), url, ts: Number.isFinite(t as number) ? t : null });
    }
    return out;
  } catch { return []; }
}

async function translate(text: string): Promise<string> {
  if (!text) return "";
  try {
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=cs&dt=t&q=${encodeURIComponent(text)}`, { headers: UA });
    if (!r.ok) return text;
    const j = await r.json();
    return (j?.[0] ?? []).map((x: any) => x[0]).join("") || text;
  } catch { return text; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const started = Date.now();
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [{ data: pos }, { data: watch }, { data: aliases }] = await Promise.all([
      svc.from("positions").select("ticker").neq("type", "Cash"),
      svc.from("watchlist").select("ticker"),
      svc.from("ticker_alias").select("alias,yahoo_symbol").not("yahoo_symbol", "is", null),
    ]);
    const aliasMap = new Map<string, string>((aliases ?? []).map((a: any) => [a.alias, a.yahoo_symbol]));
    const tickers = Array.from(new Set([
      ...(pos ?? []).map((p: any) => p.ticker),
      ...(watch ?? []).map((w: any) => w.ticker),
    ])).filter((t: string) => t && t.toUpperCase() !== "CASH");
    // Process the stalest (and never-fetched) tickers first, so if a run hits the time budget
    // the next run continues with the ones it missed instead of always the same tail.
    const { data: existing } = await svc.from("stock_news").select("symbol,fetched_at");
    const fetchedAt = new Map<string, number>((existing ?? []).map((r: any) => [r.symbol, new Date(r.fetched_at).getTime()]));
    tickers.sort((a, b) => (fetchedAt.get(a) ?? 0) - (fetchedAt.get(b) ?? 0));

    let updated = 0, empty = 0, skipped = 0;
    for (const t of tickers) {
      if (Date.now() - started > TIME_BUDGET) { skipped++; continue; }
      const q = aliasMap.get(t) ?? t;
      let raw = await fetchRss(q);
      if (!raw.length && q !== t) raw = await fetchRss(t);
      raw = raw.slice(0, 3);
      const items: any[] = [];
      for (const x of raw) {
        // One translate call per item: title + summary joined, then split back.
        const joined = x.summary ? `${x.title}\n\n${x.summary}` : x.title;
        const cs = await translate(joined);
        const [titleCs, ...rest] = cs.split(/\n\n/);
        items.push({
          en: x.title, cs: (titleCs ?? x.title).trim(),
          sumEn: x.summary, sumCs: rest.join("\n\n").trim(),
          publisher: publisherFromUrl(x.url), url: x.url, ts: x.ts,
        });
        await sleep(80);
      }
      if (!items.length) { empty++; continue; }
      await svc.from("stock_news").upsert({ symbol: t, items, fetched_at: new Date().toISOString() }, { onConflict: "symbol" });
      updated++;
    }
    return new Response(JSON.stringify({ ok: true, updated, empty, skipped, total: tickers.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
