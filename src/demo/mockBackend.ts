// In-memory stand-in for the Supabase backend, used only in the demo build (vite --mode demo).
// It is handed to createClient() as `global.fetch`, so every hook and component keeps calling
// supabase.from()/rpc()/functions.invoke()/auth exactly as in production — the requests just
// never leave the browser. Supports the subset of PostgREST the app uses: select projection,
// eq/neq/gt/gte/lt/lte/like/ilike/is/in (+ not.), order, limit/offset, single/maybeSingle,
// count, and insert/update/delete that write into the in-memory tables.
import { DEMO_EMAIL, DEMO_USER_ID, generateDemoData, type DemoData } from "./data";

let db: DemoData | null = null;
const state = { brokerConnected: true, lastSync: new Date(Date.now() - 42 * 60_000).toISOString() };
const getDb = () => (db ??= generateDemoData());

/* ───────── auth ───────── */

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const FAR_FUTURE = 4102444800; // 2100-01-01

export const demoUser = {
  id: DEMO_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: DEMO_EMAIL,
  email_confirmed_at: "2023-03-01T08:00:00Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Demo uživatel" },
  identities: [],
  created_at: "2023-03-01T08:00:00Z",
  updated_at: "2023-03-01T08:00:00Z",
  is_anonymous: false,
};

export function demoSession() {
  const access_token = [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ sub: DEMO_USER_ID, email: DEMO_EMAIL, role: "authenticated", aud: "authenticated", exp: FAR_FUTURE, iat: 1700000000 }),
    "demo-signature",
  ].join(".");
  return {
    access_token,
    refresh_token: "demo-refresh-token",
    token_type: "bearer",
    expires_in: FAR_FUTURE - Math.floor(Date.now() / 1000),
    expires_at: FAR_FUTURE,
    user: demoUser,
  };
}

/** Auth storage that always holds the demo session (sign-in state lives in memory only). */
export function createDemoAuthStorage() {
  const mem = new Map<string, string>();
  return {
    getItem: (key: string) => {
      if (mem.has(key)) return mem.get(key)!;
      if (key.endsWith("-auth-token")) return JSON.stringify(demoSession());
      return null;
    },
    setItem: (key: string, value: string) => void mem.set(key, value),
    removeItem: (key: string) => void mem.delete(key),
  };
}

/* ───────── helpers ───────── */

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
const empty = (status = 204) => new Response(null, { status });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let idSeq = 1;
const newId = () => `d3m0ffff-0000-4000-8000-${(idSeq++).toString(16).padStart(12, "0")}`;

function coerce(raw: string): string | number | boolean | null {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw.replace(/^"(.*)"$/, "$1");
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function likeToRegex(p: string, flags: string) {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "%");
  return new RegExp(`^${esc.replace(/%/g, ".*").replace(/_/g, ".")}$`, flags);
}

function matchOne(val: unknown, expr: string): boolean {
  let negate = false;
  if (expr.startsWith("not.")) { negate = true; expr = expr.slice(4); }
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  let ok: boolean;
  switch (op) {
    case "eq": ok = cmp(val, coerce(arg)) === 0 && val != null; break;
    case "neq": ok = val != null && cmp(val, coerce(arg)) !== 0; break;
    case "gt": ok = val != null && cmp(val, arg) > 0; break;
    case "gte": ok = val != null && cmp(val, arg) >= 0; break;
    case "lt": ok = val != null && cmp(val, arg) < 0; break;
    case "lte": ok = val != null && cmp(val, arg) <= 0; break;
    case "like": ok = val != null && likeToRegex(arg, "").test(String(val)); break;
    case "ilike": ok = val != null && likeToRegex(arg, "i").test(String(val)); break;
    case "is": ok = arg === "null" ? val == null : String(val) === arg; break;
    case "in": {
      const list = arg.replace(/^\(|\)$/g, "").split(",").map((s) => String(coerce(s.trim())));
      ok = val != null && list.includes(String(val));
      break;
    }
    default: ok = true; // unsupported operator: don't filter
  }
  return negate ? !ok : ok;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function applyFilters(rows: any[], params: URLSearchParams): any[] {
  let out = rows;
  params.forEach((expr, col) => {
    if (RESERVED.has(col) || col.includes(".")) return;
    out = out.filter((r) => matchOne(r[col], expr));
  });
  return out;
}

function applyOrder(rows: any[], order: string | null): any[] {
  if (!order) return rows;
  const keys = order.split(",").map((k) => {
    const [col, dir = "asc"] = k.split(".");
    return { col, desc: dir === "desc" };
  });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const c = cmp(a[k.col], b[k.col]);
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  });
}

function project(rows: any[], select: string | null): any[] {
  if (!select || select.trim() === "*") return rows.map((r) => ({ ...r }));
  const cols = select.split(",").map((c) => c.trim()).filter(Boolean);
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
}

/* ───────── "database triggers" ───────── */

/** Mirrors trg_update_position_on_transaction + the cash trigger, simplified. */
function afterTransactionWrite(tables: Record<string, any[]>, inserted: any[] = []) {
  const positions = tables.positions;
  const cashRow = positions.find((p) => p.ticker === "CASH");
  for (const t of inserted) {
    const amount = Number(t.shares) * Number(t.price_usd);
    if (t.ticker === "CASH") {
      if (cashRow) cashRow.shares = Math.max(0, Number(cashRow.shares) + (t.side === "BUY" ? amount : -amount));
      continue;
    }
    if (cashRow) cashRow.shares = Math.max(0, Number(cashRow.shares) + (t.side === "BUY" ? -(amount + Number(t.fee_usd || 0)) : amount - Number(t.fee_usd || 0)));
    if (!positions.some((p) => p.ticker === t.ticker)) {
      positions.push({ id: newId(), user_id: DEMO_USER_ID, ticker: t.ticker, name: t.ticker, type: "Stock", shares: 0, avg_cost_usd: 0, sector: null, holding_start_date: String(t.executed_at).slice(0, 10) });
    }
  }
  // Recompute share counts + average buy price from the ledger for every non-cash ticker.
  for (const p of positions) {
    if (p.ticker === "CASH") continue;
    const list = tables.transactions.filter((t) => t.ticker === p.ticker);
    if (!list.length) continue;
    const buys = list.filter((t) => t.side === "BUY");
    const q = buys.reduce((s, t) => s + Number(t.shares), 0);
    p.shares = list.reduce((s, t) => s + (t.side === "BUY" ? 1 : -1) * Number(t.shares), 0);
    if (q > 0) p.avg_cost_usd = buys.reduce((s, t) => s + Number(t.shares) * Number(t.price_usd), 0) / q;
  }
}

/* ───────── PostgREST ───────── */

async function handleRest(table: string, method: string, url: URL, headers: Headers, body: string | null): Promise<Response> {
  const { tables } = getDb();
  const rows = (tables[table] ??= []);
  const params = url.searchParams;
  const prefer = headers.get("Prefer") ?? "";
  const accept = headers.get("Accept") ?? "";
  const wantsObject = accept.includes("vnd.pgrst.object");
  const returnRep = prefer.includes("return=representation");

  const respond = (data: any[], total?: number) => {
    const extra: Record<string, string> = {};
    if (/count=/.test(prefer)) {
      const n = total ?? data.length;
      extra["Content-Range"] = `${data.length ? `0-${data.length - 1}` : "*"}/${n}`;
    }
    if (method === "HEAD") return new Response(null, { status: 200, headers: extra });
    if (wantsObject) {
      if (data.length !== 1) {
        return json({ code: "PGRST116", details: `The result contains ${data.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" }, 406);
      }
      return json(data[0], 200, extra);
    }
    return json(data, 200, extra);
  };

  if (method === "GET" || method === "HEAD") {
    const filtered = applyOrder(applyFilters(rows, params), params.get("order"));
    const offset = Number(params.get("offset") ?? 0);
    const limit = params.get("limit") != null ? Number(params.get("limit")) : undefined;
    const page = filtered.slice(offset, limit != null ? offset + limit : undefined);
    return respond(project(page, params.get("select")), filtered.length);
  }

  if (method === "POST") {
    const payload = body ? JSON.parse(body) : [];
    let list: any[] = Array.isArray(payload) ? payload : [payload];
    // upsert(…, { onConflict }): merge into the existing row instead of adding a duplicate
    // (a second user_settings row would break every .maybeSingle() read).
    const conflict = params.get("on_conflict")?.split(",").map((c) => c.trim()).filter(Boolean);
    const merged: any[] = [];
    if (conflict?.length && prefer.includes("resolution=")) {
      list = list.filter((r) => {
        // As in Postgres, a NULL in a conflict column never conflicts (user_id defaults to the demo user).
        const key = (row: any, c: string) => (c === "user_id" ? row[c] ?? DEMO_USER_ID : row[c]);
        const hit = rows.find((x) => conflict.every((c) => key(x, c) != null && key(r, c) != null && String(key(x, c)) === String(key(r, c))));
        if (!hit) return true;
        if (prefer.includes("resolution=merge-duplicates")) Object.assign(hit, r);
        merged.push(hit);
        return false;
      });
      if (list.length === 0) {
        if (table === "transactions") afterTransactionWrite(tables);
        return returnRep ? respond(project(merged, params.get("select"))) : empty(201);
      }
    }
    const created = list.map((r) => ({
      id: newId(),
      user_id: DEMO_USER_ID,
      created_at: new Date().toISOString(),
      ...(table === "transactions" ? { fee_usd: 0, note: null, ext_id: null, broker: null, broker_account: null } : {}),
      ...r,
    }));
    rows.push(...created);
    if (table === "transactions") afterTransactionWrite(tables, created);
    return returnRep ? respond(project([...merged, ...created], params.get("select"))) : empty(201);
  }

  if (method === "PATCH") {
    const patch = body ? JSON.parse(body) : {};
    const hit = applyFilters(rows, params);
    for (const r of hit) Object.assign(r, patch);
    if (table === "transactions") afterTransactionWrite(tables);
    return returnRep ? respond(project(hit, params.get("select"))) : empty(204);
  }

  if (method === "DELETE") {
    const hit = new Set(applyFilters(rows, params));
    tables[table] = rows.filter((r) => !hit.has(r));
    if (table === "transactions") afterTransactionWrite(tables);
    return returnRep ? respond(project([...hit], params.get("select"))) : empty(204);
  }

  return json({ message: `Demo: ${method} not supported` }, 405);
}

async function handleRpc(fn: string, body: string | null): Promise<Response> {
  const { tables } = getDb();
  const args = body ? JSON.parse(body) : {};
  switch (fn) {
    case "get_broker_connection_status":
      return json(state.brokerConnected
        ? [{ broker: "T212", environment: "live", last_sync_at: state.lastSync, status: "ok", account_summary: null }]
        : []);
    case "set_broker_connection":
      state.brokerConnected = true;
      return json(null);
    case "delete_broker_connection":
      state.brokerConnected = false;
      return json(null);
    case "apply_split":
    case "dismiss_split": {
      const s = tables.splits.find((x) => x.id === args.split_id);
      if (s) s.status = fn === "apply_split" ? "applied" : "dismissed";
      return json(null);
    }
    default:
      // claim_orphan_data, seed_ticker_aliases, reconcile_broker_account, …
      return json(null);
  }
}

async function handleFunction(name: string): Promise<Response> {
  const d = getDb();
  switch (name) {
    case "get-live-prices":
      return json({ prices: d.prices, usdCzk: d.usdCzk, fetchedAt: new Date().toISOString(), stale: false, error: null });
    case "sync-broker":
      await wait(700);
      state.lastSync = new Date().toISOString();
      return json({ done: true, positions: d.tables.positions.filter((p) => p.ticker !== "CASH" && Number(p.shares) > 0).length });
    case "backfill-snapshots":
      await wait(400);
      return json({ done: true, snapshots: d.tables.daily_snapshots.length });
    default:
      // sync-sectors, sync-earnings, …
      await wait(400);
      return json({ ok: true });
  }
}

async function handleAuth(path: string, method: string): Promise<Response> {
  if (path.startsWith("user")) return json(demoUser);
  if (path.startsWith("token") || path.startsWith("signup") || path.startsWith("verify")) return json(demoSession());
  if (path.startsWith("logout")) return empty(204);
  if (path.startsWith("settings")) return json({ external: { email: true, google: true }, disable_signup: false });
  if (method === "POST") return json({});
  return json({});
}

/* ───────── entry point ───────── */

export const demoFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? init.body : null;
  const path = url.pathname;

  try {
    if (path.startsWith("/rest/v1/rpc/")) return await handleRpc(path.slice("/rest/v1/rpc/".length), body);
    if (path.startsWith("/rest/v1/")) return await handleRest(decodeURIComponent(path.slice("/rest/v1/".length)), method, url, headers, body);
    if (path.startsWith("/functions/v1/")) return await handleFunction(path.slice("/functions/v1/".length));
    if (path.startsWith("/auth/v1/")) return await handleAuth(path.slice("/auth/v1/".length), method);
  } catch (e: any) {
    console.error("[demo backend]", e);
    return json({ message: e?.message ?? "demo backend error" }, 500);
  }
  return json({ message: "Not available in demo" }, 404);
};
