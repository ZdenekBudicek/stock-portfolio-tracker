// Last step of an on-demand run: mark the requests done/failed only after BOTH statements and
// price history were attempted, so the app reloads once everything it shows is in place.
//   done   = statements stored (status ok with periods)
//   failed = no statements (ETF, unknown symbol); last_error says why, incl. missing prices
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ONLY_SYMBOLS (tickers as the user's data spells them).
import { pathToFileURL } from 'node:url';
import { parseOnlySymbols } from './only-symbols.mjs';

const up = (v) => String(v ?? '').trim().toUpperCase();

export async function finishRequests({ url, key, tickers, fetchFn = fetch, now = Date.now() }) {
  const root = `${url.replace(/\/$/, '')}/rest/v1/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path) => {
    const r = await fetchFn(root + path, { headers });
    if (!r.ok) throw new Error(`Read ${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  };
  const list = (xs) => xs.map((x) => `"${String(x).replace(/"/g, '')}"`).join(',');
  const variants = [...new Set(tickers.flatMap((t) => [t, up(t)]))];
  const aliases = await get(`ticker_alias?select=alias,canonical&alias=in.(${encodeURIComponent(list(variants))})`);
  const canonical = (t) => up(aliases.find((a) => up(a.alias) === up(t))?.canonical) || up(t);
  const symbols = [...new Set(tickers.map(canonical))];
  const rows = await get(`company_fundamentals?select=symbol,status,last_error,annual:data->annual->periods,quarterly:data->quarterly->periods&symbol=in.(${encodeURIComponent(list(symbols))})`);
  const prices = await get(`price_history?select=symbol&symbol=in.(${encodeURIComponent(list(tickers))})&limit=1000`);
  const priced = new Set(prices.map((p) => p.symbol));
  const out = [];
  for (const t of tickers) {
    const symbol = canonical(t);
    const row = rows.find((r) => up(r.symbol) === symbol);
    const has = row && row.status === 'ok' && ((row.annual?.length ?? 0) + (row.quarterly?.length ?? 0)) > 0;
    const notes = [];
    if (!has) notes.push(row?.last_error ? `statements: ${row.last_error}` : 'statements: none');
    if (!priced.has(t)) notes.push('price history: none');
    out.push({ symbol, status: has ? 'done' : 'failed', finished_at: new Date(now).toISOString(), last_error: notes.length ? notes.join('; ').slice(0, 500) : null });
  }
  const r = await fetchFn(`${root}fundamentals_requests?on_conflict=symbol`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(out),
  });
  if (!r.ok) throw new Error(`Write fundamentals_requests: HTTP ${r.status}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tickers = parseOnlySymbols(process.env.ONLY_SYMBOLS);
    if (!tickers) throw new Error('ONLY_SYMBOLS is required');
    finishRequests({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY, tickers })
      .then((out) => console.log(out.map((o) => `${o.symbol}: ${o.status}${o.last_error ? ` (${o.last_error})` : ''}`).join('\n')))
      .catch((e) => { console.error(e.message); process.exitCode = 1; });
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
