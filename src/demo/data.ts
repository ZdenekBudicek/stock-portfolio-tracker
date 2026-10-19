import { demoFundamentals } from "./fundamentals";
// Demo-mode data set. EVERYTHING in here is invented: tickers are real symbols so logos and
// the TradingView embed work, but every share count, trade, price path, deposit and dividend
// is generated from a seeded PRNG. Nothing is derived from any real account or statement.
//
// Prices follow a Brownian bridge through a handful of hand-picked waypoints (so the curve
// looks like a market, not noise) up to the build date, then keep walking day by day, so a
// demo opened months after the build still has a live-looking "today".

declare const __DEMO_ANCHOR_DATE__: string | undefined;

/* ───────── deterministic helpers ───────── */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const DAY_MS = 86_400_000;
const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => isoDay(parseDay(d) + n * DAY_MS);
const addMonths = (d: string, n: number) => {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, day));
  return isoDay(t.getTime());
};
const isWeekend = (d: string) => {
  const w = new Date(parseDay(d)).getUTCDay();
  return w === 0 || w === 6;
};
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Stable uuid-shaped id, so rows look like the real ones. */
const uid = (kind: number, n: number) =>
  `d3m0${kind.toString(16).padStart(4, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const DEMO_USER_ID = "d3m0d3m0-0000-4000-8000-000000000001";
export const DEMO_EMAIL = "demo@example.com";

/* ───────── instruments ───────── */

type Kind = "Stock" | "Crypto" | "Index" | "FX";
interface Inst {
  ticker: string;
  name: string;
  kind: Kind;
  vol: number; // daily log-return sigma
  pts: number[]; // price at each WAYPOINT (last = anchor/build date)
  sector?: string;
}

const SERIES_START = "2023-03-01";

// Share of each instrument's daily move that comes from a common "market" shock, so the
// portfolio has a realistic volatility and moves with the S&P instead of diversifying away.
const MARKET_BETA: Record<Kind, number> = { Stock: 0.6, Crypto: 0.35, Index: 1, FX: -0.15 };
const WAYPOINT_DATES = ["2023-03-01", "2023-09-01", "2024-03-01", "2024-09-02", "2025-03-03", "2025-09-01", "2026-03-02"];

// Held / previously held / watched instruments. Prices are loose, invented levels.
const INSTRUMENTS: Inst[] = [
  { ticker: "AAPL", name: "Apple Inc.", kind: "Stock", vol: 0.016, pts: [151, 186, 181, 221, 236, 231, 252, 247], sector: "Technologie" },
  { ticker: "MSFT", name: "Microsoft Corp.", kind: "Stock", vol: 0.015, pts: [254, 327, 409, 412, 393, 503, 478, 538], sector: "Technologie" },
  { ticker: "NVDA", name: "NVIDIA Corp.", kind: "Stock", vol: 0.028, pts: [23.6, 47.5, 81, 109, 114, 169, 183, 191], sector: "Technologie" },
  { ticker: "ASML", name: "ASML Holding N.V.", kind: "Stock", vol: 0.02, pts: [642, 688, 948, 852, 731, 758, 1006, 979], sector: "Technologie" },
  { ticker: "GOOGL", name: "Alphabet Inc. (A)", kind: "Stock", vol: 0.018, pts: [93.8, 135, 138, 157, 171, 211, 229, 249], sector: "Technologie" },
  { ticker: "AMZN", name: "Amazon.com Inc.", kind: "Stock", vol: 0.019, pts: [93.5, 138, 176, 177, 206, 224, 213, 229], sector: "Spotřební zboží" },
  { ticker: "META", name: "Meta Platforms Inc.", kind: "Stock", vol: 0.022, pts: [186, 296, 489, 521, 642, 758, 702, 781], sector: "Technologie" },
  { ticker: "V", name: "Visa Inc.", kind: "Stock", vol: 0.011, pts: [221, 243, 281, 273, 341, 344, 353, 347], sector: "Fintech" },
  { ticker: "KO", name: "Coca-Cola Co.", kind: "Stock", vol: 0.009, pts: [59.4, 57.2, 60.8, 71.3, 69.8, 68.2, 70.4, 69.1], sector: "Spotřební zboží" },
  { ticker: "O", name: "Realty Income Corp.", kind: "Stock", vol: 0.012, pts: [63.1, 54.6, 53.2, 62.4, 56.1, 58.3, 57.2, 55.2], sector: "Nemovitosti" },
  { ticker: "SAP", name: "SAP SE", kind: "Stock", vol: 0.016, pts: [118, 137, 186, 214, 271, 268, 237, 226], sector: "Technologie" },
  { ticker: "BTC", name: "Bitcoin", kind: "Crypto", vol: 0.027, pts: [22400, 25900, 62100, 58300, 88200, 109800, 96400, 112600], sector: "Krypto" },
  { ticker: "ETH", name: "Ethereum", kind: "Crypto", vol: 0.034, pts: [1565, 1642, 3410, 2490, 2160, 4340, 3010, 3360], sector: "Krypto" },
  // closed positions
  { ticker: "INTC", name: "Intel Corp.", kind: "Stock", vol: 0.022, pts: [25.2, 35.4, 43.1, 20.8, 23.1, 24.2, 22.3, 23.4], sector: "Technologie" },
  { ticker: "DIS", name: "Walt Disney Co.", kind: "Stock", vol: 0.016, pts: [100.2, 86.1, 111.4, 90.3, 112.2, 117.6, 108.3, 112.4], sector: "Média & zábava" },
  { ticker: "TSLA", name: "Tesla Inc.", kind: "Stock", vol: 0.032, pts: [191, 248, 201, 214, 286, 331, 358, 394], sector: "Automotive" },
  // watchlist only
  { ticker: "AMD", name: "Advanced Micro Devices", kind: "Stock", vol: 0.027, pts: [79, 106, 194, 151, 104, 161, 208, 224], sector: "Technologie" },
  { ticker: "COST", name: "Costco Wholesale", kind: "Stock", vol: 0.012, pts: [482, 561, 738, 887, 1046, 951, 988, 1009], sector: "Spotřební zboží" },
  { ticker: "UBER", name: "Uber Technologies", kind: "Stock", vol: 0.022, pts: [31.8, 46.2, 77.9, 72.1, 72.6, 94.8, 88.1, 92.3], sector: "Technologie" },
  { ticker: "PLTR", name: "Palantir Technologies", kind: "Stock", vol: 0.035, pts: [7.6, 16.1, 24.3, 30.2, 89.7, 168, 158, 176], sector: "Technologie" },
  // benchmark + FX
  { ticker: "SPX", name: "S&P 500", kind: "Index", vol: 0.009, pts: [3982, 4512, 5133, 5648, 5851, 6447, 6652, 6804] },
  { ticker: "USDCZK", name: "USD/CZK", kind: "FX", vol: 0.0038, pts: [22.12, 22.31, 23.38, 22.61, 23.87, 22.43, 22.71, 22.94] },
];

const WATCH = [
  { ticker: "AMD", target: 200, note: "Přikoupit při poklesu pod cílovku" },
  { ticker: "COST", target: 900, note: "Drahé, čekám na lepší vstup" },
  { ticker: "UBER", target: 85, note: null },
  { ticker: "PLTR", target: 140, note: "Hlídat valuaci" },
];

type Broker = "T212" | "XTB" | "Revolut";
const XTB_ACCOUNT = "50000123"; // made-up account label

// Trade plan: [date, ticker, side, quantity, broker]. Final share counts fall out of this.
const TRADES: [string, string, "BUY" | "SELL", number, Broker][] = [
  ["2023-03-14", "AAPL", "BUY", 8, "T212"],
  ["2023-03-20", "TSLA", "BUY", 12, "T212"],
  ["2023-03-21", "MSFT", "BUY", 4, "T212"],
  ["2023-03-23", "BTC", "BUY", 0.02, "Revolut"],
  ["2023-03-28", "KO", "BUY", 22, "XTB"],
  ["2023-04-04", "AMZN", "BUY", 10, "T212"],
  ["2023-04-18", "DIS", "BUY", 15, "XTB"],
  ["2023-04-26", "GOOGL", "BUY", 10, "XTB"],
  ["2023-05-10", "NVDA", "BUY", 30, "T212"],
  ["2023-05-16", "ETH", "BUY", 0.5, "Revolut"],
  ["2023-06-13", "META", "BUY", 3, "Revolut"],
  ["2023-06-20", "INTC", "BUY", 60, "T212"],
  ["2023-07-18", "V", "BUY", 5, "Revolut"],
  ["2023-08-15", "O", "BUY", 30, "Revolut"],
  ["2023-09-19", "ASML", "BUY", 2, "XTB"],
  ["2023-10-10", "AAPL", "BUY", 6, "T212"],
  ["2024-01-16", "MSFT", "BUY", 3, "T212"],
  ["2024-01-30", "BTC", "BUY", 0.015, "Revolut"],
  ["2024-02-06", "NVDA", "BUY", 20, "T212"],
  ["2024-02-20", "SAP", "BUY", 5, "XTB"],
  ["2024-05-14", "KO", "BUY", 20, "XTB"],
  ["2024-06-12", "AAPL", "BUY", 4, "T212"],
  ["2024-07-24", "GOOGL", "BUY", 6, "XTB"],
  ["2024-08-05", "ETH", "BUY", 0.25, "Revolut"],
  ["2024-08-19", "INTC", "SELL", 60, "T212"],
  ["2024-08-19", "AMZN", "BUY", 8, "T212"], // proceeds reinvested the same day
  ["2024-09-10", "O", "BUY", 20, "Revolut"],
  ["2024-10-17", "ASML", "BUY", 2, "XTB"],
  ["2024-11-05", "META", "BUY", 2, "Revolut"],
  ["2025-01-21", "V", "BUY", 5, "Revolut"],
  ["2025-02-06", "DIS", "SELL", 15, "XTB"],
  ["2025-03-11", "GOOGL", "BUY", 4, "XTB"],
  ["2025-04-07", "BTC", "BUY", 0.01, "Revolut"],
  ["2025-04-22", "MSFT", "BUY", 2, "T212"],
  ["2025-06-17", "SAP", "BUY", 4, "XTB"],
  ["2025-07-15", "NVDA", "SELL", 18, "T212"],
  ["2025-07-15", "MSFT", "BUY", 5, "T212"], // proceeds reinvested
  ["2025-11-18", "NVDA", "BUY", 4, "T212"],
  ["2026-04-14", "TSLA", "SELL", 12, "T212"],
  ["2026-04-14", "AMZN", "BUY", 9, "T212"], // proceeds reinvested
  ["2026-04-14", "AAPL", "BUY", 7, "T212"],
  ["2026-07-14", "SAP", "SELL", 4, "XTB"], // taxable: lot is younger than 3 years
];

// Monthly "spořicí plán" on T212: a fixed USD amount into a rotating ticker (fractional shares).
const DCA = { from: "2025-10-10", usd: 200, tickers: ["AAPL", "MSFT", "NVDA", "AMZN"] };

// Dividend schedules: ex-date months, day of month, amount per share (grows a bit each year).
const DIVS: { ticker: string; months: number[]; day: number; amt: number; growth: number; since?: string }[] = [
  { ticker: "AAPL", months: [2, 5, 8, 11], day: 9, amt: 0.24, growth: 0.04 },
  { ticker: "MSFT", months: [2, 5, 8, 11], day: 15, amt: 0.68, growth: 0.1 },
  { ticker: "KO", months: [3, 6, 9, 11], day: 13, amt: 0.46, growth: 0.05 },
  { ticker: "V", months: [2, 5, 8, 11], day: 7, amt: 0.45, growth: 0.13 },
  { ticker: "O", months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 28, amt: 0.2555, growth: 0.025 },
  { ticker: "GOOGL", months: [3, 6, 9, 12], day: 9, amt: 0.2, growth: 0.05, since: "2024-06-01" },
  { ticker: "META", months: [3, 6, 9, 12], day: 14, amt: 0.5, growth: 0.05, since: "2024-02-15" },
  { ticker: "ASML", months: [2, 4, 7, 10], day: 27, amt: 1.52, growth: 0.1 },
  { ticker: "SAP", months: [5], day: 14, amt: 2.2, growth: 0.08 },
];

/* ───────── generation ───────── */

export interface DemoData {
  today: string;
  tables: Record<string, any[]>;
  prices: Record<string, { price: number; changePct: number; prevClose: number | null }>;
  usdCzk: number;
}

export function generateDemoData(now = new Date()): DemoData {
  const todayRuntime = isoDay(now.getTime());
  const anchorRaw = typeof __DEMO_ANCHOR_DATE__ !== "undefined" && __DEMO_ANCHOR_DATE__ ? __DEMO_ANCHOR_DATE__ : todayRuntime;
  // Never let the anchor sit before the last hand-written trade.
  const anchor = [anchorRaw, "2026-05-01"].sort()[1];
  const today = todayRuntime > anchor ? todayRuntime : anchor;

  // Calendar days from SERIES_START to today (inclusive).
  const days: string[] = [];
  for (let t = parseDay(SERIES_START); t <= parseDay(today); t += DAY_MS) days.push(isoDay(t));
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const idxOf = (d: string) => {
    const i = dayIdx.get(d);
    if (i != null) return i;
    return d < SERIES_START ? 0 : days.length - 1;
  };

  const mrng = mulberry32(hashStr("market-4"));
  const market = Float64Array.from(days, () => gauss(mrng));
  const series = new Map<string, Float64Array>();
  for (const inst of INSTRUMENTS) series.set(inst.ticker, buildPath(inst, days, idxOf, anchor, market));
  const px = (ticker: string, d: string) => series.get(ticker)![idxOf(d)];

  /* trades */
  const planned = [...TRADES];
  for (let k = 0, d = DCA.from; d <= anchor; k++, d = addMonths(DCA.from, k)) {
    let day = d;
    while (isWeekend(day)) day = addDays(day, 1);
    const tk = DCA.tickers[k % DCA.tickers.length];
    planned.push([day, tk, "BUY", round(DCA.usd / px(tk, day), 4), "T212"]);
  }
  const trades = planned.sort((a, b) => a[0].localeCompare(b[0]));
  const txRows: any[] = [];
  const depositRows: any[] = [];
  const cash: Record<Broker, number> = { T212: 0, XTB: 0, Revolut: 0 };
  const rng = mulberry32(hashStr("trades"));
  let depN = 0;

  const instBy = new Map(INSTRUMENTS.map((i) => [i.ticker, i]));
  trades.forEach(([d, ticker, side, q, broker], n) => {
    const inst = instBy.get(ticker)!;
    const slip = 1 + (rng() - 0.5) * 0.006;
    const price = round(px(ticker, d) * slip, inst.kind === "Crypto" ? 2 : 2);
    const notional = price * q;
    const fee = broker === "Revolut" ? (inst.kind === "Crypto" ? round(notional * 0.0149) : 1) : 0;
    const hh = inst.kind === "Crypto" ? 8 + Math.floor(rng() * 12) : 14 + Math.floor(rng() * 5);
    const mm = Math.floor(rng() * 60);
    const executed_at = `${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+00:00`;

    // Cash simulation for brokers with dated deposits (XTB, Revolut). T212's net deposits
    // are the app's trade proxy, so its sale proceeds are treated as withdrawn.
    if (broker !== "T212") {
      const need = side === "BUY" ? notional + fee : 0;
      if (need > cash[broker]) {
        const amt = Math.ceil((need - cash[broker] + 60) / 250) * 250;
        cash[broker] += amt;
        const depDay = addDays(d, -1 - Math.floor(rng() * 3));
        depositRows.push({
          id: uid(3, ++depN),
          user_id: DEMO_USER_ID,
          broker,
          broker_account: broker === "XTB" ? XTB_ACCOUNT : null,
          flow_date: depDay,
          amount_usd: amt,
          source: "statement",
          ext_id: `${broker.toLowerCase()}:dep:${depN}`,
        });
      }
      cash[broker] += side === "BUY" ? -(notional + fee) : notional - fee;
    }

    txRows.push({
      id: uid(1, n + 1),
      user_id: DEMO_USER_ID,
      ticker,
      side,
      shares: q,
      price_usd: price,
      fee_usd: fee,
      executed_at,
      note: null,
      broker,
      broker_account: broker === "XTB" ? XTB_ACCOUNT : null,
      ext_id: `${broker === "T212" ? "t212:ord" : broker.toLowerCase()}:${100000 + n * 7}`,
      t212_id: null,
      created_at: executed_at,
    });
  });

  /* daily walk: holdings + cash per day → snapshots */
  const txByDay = new Map<string, any[]>();
  for (const t of txRows) {
    const d = t.executed_at.slice(0, 10);
    if (!txByDay.has(d)) txByDay.set(d, []);
    txByDay.get(d)!.push(t);
  }
  const depByDay = new Map<string, number>();
  for (const dep of depositRows) depByDay.set(dep.flow_date, (depByDay.get(dep.flow_date) ?? 0) + dep.amount_usd);

  const held = new Map<string, number>();
  let cashTracked = 0;
  const firstDay = trades[0][0];
  const snapshots: any[] = [];
  const yesterday = addDays(today, -1);
  for (const d of days) {
    cashTracked += depByDay.get(d) ?? 0;
    for (const t of txByDay.get(d) ?? []) {
      held.set(t.ticker, (held.get(t.ticker) ?? 0) + (t.side === "BUY" ? t.shares : -t.shares));
      if (t.broker !== "T212") cashTracked += t.side === "BUY" ? -(t.shares * t.price_usd + t.fee_usd) : t.shares * t.price_usd - t.fee_usd;
    }
    if (d < firstDay || d > yesterday) continue;
    let v = 0;
    for (const [tk, sh] of held) if (sh > 1e-9) v += sh * px(tk, d);
    const fx = px("USDCZK", d);
    snapshots.push({
      snapshot_date: d,
      value_usd: round(v),
      value_czk: round(v * fx),
      profit_usd: 0,
      profit_pct: 0,
      profit_czk: 0,
      fx_rate: round(fx, 4),
      cash_usd: round(Math.max(0, cashTracked)),
    });
  }

  /* positions (derived from the ledger, like the DB trigger does) */
  const positions: any[] = [];
  let posN = 0;
  const firstBuy = new Map<string, string>();
  for (const t of txRows) if (t.side === "BUY" && !firstBuy.has(t.ticker)) firstBuy.set(t.ticker, t.executed_at.slice(0, 10));
  for (const tk of [...new Set(txRows.map((t) => t.ticker))].sort()) {
    const inst = instBy.get(tk)!;
    const list = txRows.filter((t) => t.ticker === tk);
    const shares = list.reduce((s, t) => s + (t.side === "BUY" ? t.shares : -t.shares), 0);
    const buys = list.filter((t) => t.side === "BUY");
    const buyQty = buys.reduce((s, t) => s + t.shares, 0);
    const avg = buyQty > 0 ? buys.reduce((s, t) => s + t.shares * t.price_usd, 0) / buyQty : 0;
    positions.push({
      id: uid(2, ++posN),
      user_id: DEMO_USER_ID,
      ticker: tk,
      name: inst.name,
      type: inst.kind === "Crypto" ? "Crypto" : "Stock",
      shares: round(shares, 6),
      avg_cost_usd: round(avg, 4),
      sector: null,
      holding_start_date: firstBuy.get(tk) ?? null,
      created_at: `${firstBuy.get(tk) ?? SERIES_START}T00:00:00+00:00`,
    });
  }
  positions.push({
    id: uid(2, ++posN),
    user_id: DEMO_USER_ID,
    ticker: "CASH",
    name: "Hotovost",
    type: "Cash",
    shares: round(Math.max(0, cashTracked)),
    avg_cost_usd: 1,
    sector: null,
    holding_start_date: null,
    created_at: `${SERIES_START}T00:00:00+00:00`,
  });

  /* live prices: last close vs. the close before it */
  const prices: DemoData["prices"] = {};
  const iToday = idxOf(today);
  for (const inst of INSTRUMENTS) {
    if (inst.kind === "Index" || inst.kind === "FX") continue;
    const s = series.get(inst.ticker)!;
    const price = s[iToday];
    let j = iToday - 1;
    while (j > 0 && s[j] === price) j--; // skip non-trading days (weekend = same close)
    const prev = s[Math.max(0, j)];
    prices[inst.ticker] = { price: round(price), prevClose: round(prev), changePct: round(((price - prev) / prev) * 100, 2) };
  }
  const usdCzk = round(px("USDCZK", today), 3);

  /* benchmark */
  const benchmark = days
    .filter((d) => !isWeekend(d) && d <= today)
    .map((d) => ({ symbol: "SPX", date: d, close_value: round(px("SPX", d)) }));

  /* dividends: paid history + ~12 months projected */
  const dividends: any[] = [];
  let divN = 0;
  const heldOn = (tk: string, d: string) =>
    txRows.filter((t) => t.ticker === tk && t.executed_at.slice(0, 10) < d).reduce((s, t) => s + (t.side === "BUY" ? t.shares : -t.shares), 0);
  const horizon = addDays(today, 365);
  for (const sch of DIVS) {
    for (let y = 2023; y <= Number(horizon.slice(0, 4)); y++) {
      for (const m of sch.months) {
        const ex = `${y}-${String(m).padStart(2, "0")}-${String(sch.day).padStart(2, "0")}`;
        if (ex < firstDay || ex > horizon) continue;
        if (sch.since && ex < sch.since) continue;
        const exD = isWeekend(ex) ? addDays(ex, new Date(parseDay(ex)).getUTCDay() === 6 ? -1 : -2) : ex;
        const pay = addDays(exD, 14);
        const past = pay <= today;
        const sh = past ? heldOn(sch.ticker, exD) : heldOn(sch.ticker, today);
        if (sh <= 1e-9) continue;
        const aps = round(sch.amt * (1 + sch.growth) ** (y - 2023), 4);
        const broker = txRows.find((t) => t.ticker === sch.ticker)?.broker ?? null;
        dividends.push({
          id: uid(4, ++divN),
          user_id: DEMO_USER_ID,
          ticker: sch.ticker,
          ex_date: exD,
          pay_date: pay,
          amount_per_share: aps,
          shares_held: round(sh, 6),
          // net of the 15 % US withholding tax
          total_amount_usd: round(aps * sh * 0.85),
          status: past ? "paid" : "upcoming",
          broker,
          broker_account: broker === "XTB" ? XTB_ACCOUNT : null,
          ext_id: past ? `${String(broker).toLowerCase()}:div:${divN}` : null,
        });
      }
    }
  }

  /* earnings: quarterly, from a month ago to ~7 months ahead of TODAY (runtime-relative) */
  const earnings: any[] = [];
  let eN = 0;
  const erng = mulberry32(hashStr("earnings"));
  const eTickers = [...positions.filter((p) => p.shares > 0 && p.type === "Stock").map((p) => p.ticker), ...WATCH.map((w) => w.ticker)];
  const y0 = Number(today.slice(0, 4));
  for (const tk of eTickers) {
    const h = hashStr(tk);
    const off = h % 20;
    const months = h % 3 === 0 ? [2, 5, 8, 11] : [1, 4, 7, 10];
    const eps = 0.6 + (hashStr(tk + "eps") % 500) / 100;
    for (let y = y0 - 1; y <= y0 + 1; y++) {
      for (const m of months) {
        let d = `${y}-${String(m).padStart(2, "0")}-${String(8 + off).padStart(2, "0")}`;
        while (isWeekend(d)) d = addDays(d, 1);
        if (d < addDays(today, -30) || d > addDays(today, 210)) continue;
        const past = d < today;
        const est = round(eps * (1 + (y - 2025) * 0.08), 2);
        earnings.push({
          id: uid(5, ++eN),
          ticker: tk,
          earnings_date: d,
          time_of_day: erng() < 0.5 ? "bmo" : "amc",
          eps_estimate: est,
          eps_actual: past ? round(est * (0.95 + erng() * 0.15), 2) : null,
        });
      }
    }
  }

  /* watchlist, goal, profiles, news, broker status */
  const watchlist = WATCH.map((w, i) => ({
    id: uid(6, i + 1),
    user_id: DEMO_USER_ID,
    ticker: w.ticker,
    name: instBy.get(w.ticker)!.name,
    target_price_usd: w.target,
    note: w.note,
    created_at: "2025-06-01T10:00:00+00:00",
  }));

  const goals = [
    {
      id: uid(7, 1),
      user_id: DEMO_USER_ID,
      name: "Dva miliony korun",
      target_amount_usd: 87000,
      target_date: "2030-12-31",
      is_active: true,
      created_at: "2024-01-02T09:00:00+00:00",
    },
  ];

  const profiles = INSTRUMENTS.filter((i) => i.sector).map((i) => ({ ticker: i.ticker, sector: i.sector }));

  const newsRows = positions
    .filter((p) => p.ticker !== "CASH")
    .map((p, i) => ({ symbol: p.ticker, items: demoNews(p.ticker, p.name, now, p.type === "Crypto"), fetched_at: new Date(now.getTime() - (20 + i) * 60_000).toISOString() }));

  return {
    today,
    usdCzk,
    prices,
    tables: {
      positions,
      transactions: txRows,
      daily_snapshots: snapshots,
      deposits: depositRows,
      dividends,
      earnings_calendar: earnings,
      benchmark_history: benchmark,
      watchlist,
      portfolio_goals: goals,
      ticker_profiles: profiles,
      ticker_alias: [],
      splits: [],
      stock_news: newsRows,
      // Daily closes for the stock detail chart, 52-week range and valuation multiples.
      price_history: INSTRUMENTS.filter((i) => i.kind !== "Index").flatMap((i) =>
        days.filter((d) => d <= today && (i.kind === "Crypto" || i.kind === "FX" || !isWeekend(d)))
          .map((d) => ({ symbol: i.ticker, date: d, close: round(px(i.ticker, d), i.kind === "FX" ? 4 : 2) }))),
      price_cache: [],
      company_fundamentals: demoFundamentals(today),
      fundamentals_requests: [],
      user_settings: [{ user_id: DEMO_USER_ID, tax_residence: "CZ", base_currency: "CZK", confirmed_at: "2025-01-01T09:00:00+00:00" }],
    },
  };
}

/** Piecewise Brownian bridge through the waypoints (log space), then a free walk. */
function buildPath(inst: Inst, days: string[], idxOf: (d: string) => number, anchor: string, market: Float64Array): Float64Array {
  const out = new Float64Array(days.length);
  const beta = MARKET_BETA[inst.kind];
  const idio = Math.sqrt(1 - beta * beta);
  const shock = (i: number, r: () => number) => inst.vol * (beta * market[i] + idio * gauss(r));
  const moves = (d: string) => inst.kind === "Crypto" || !isWeekend(d);
  const wpDates = [...WAYPOINT_DATES.filter((d) => d < anchor), anchor];
  // Nudge every waypoint by up to ±1.5 % so prices don't land on suspiciously round numbers.
  const pts = inst.pts.slice(-wpDates.length).map((p, k) => p * (1 + ((hashStr(`${inst.ticker}:${k}`) % 3001) - 1500) / 100000));
  while (pts.length < wpDates.length) pts.unshift(pts[0]);
  const rng = mulberry32(hashStr(inst.ticker + ":v4"));

  const iAnchor = idxOf(anchor);
  out[0] = pts[0];
  for (let k = 0; k + 1 < wpDates.length; k++) {
    const i0 = idxOf(wpDates[k]);
    const i1 = idxOf(wpDates[k + 1]);
    const a = Math.log(pts[k]);
    const b = Math.log(pts[k + 1]);
    const stepIdx: number[] = [];
    for (let i = i0 + 1; i <= i1; i++) if (moves(days[i])) stepIdx.push(i);
    const n = stepIdx.length;
    const w: number[] = [0];
    for (let s = 0; s < n; s++) w.push(w[s] + shock(stepIdx[s], rng));
    let cur = a;
    let s = 0;
    for (let i = i0 + 1; i <= i1; i++) {
      if (s < n && stepIdx[s] === i) {
        s++;
        const f = s / n;
        cur = a + (b - a) * f + w[s] - f * w[n];
      }
      out[i] = Math.exp(cur);
    }
    out[i0] = k === 0 ? pts[0] : out[i0];
  }
  // After the anchor (build date): keep walking with a mild drift.
  const post = mulberry32(hashStr(inst.ticker + ":post"));
  const drift = inst.kind === "FX" ? 0 : 0.0003;
  let cur = Math.log(out[iAnchor] || pts[pts.length - 1]);
  for (let i = iAnchor + 1; i < days.length; i++) {
    if (moves(days[i])) cur += drift + shock(i, post);
    out[i] = Math.exp(cur);
  }
  return out;
}

/** Generic, clearly made-up headlines — no real news. */
function demoNews(ticker: string, name: string, now: Date, crypto = false) {
  const nowS = Math.floor(now.getTime() / 1000);
  const items = crypto
    ? [
        {
          en: `${name}: trading volume rises as the market waits for macro data`,
          cs: `${name}: objem obchodů roste, trh vyčkává na makrodata`,
          ago: 3 * 3600,
        },
        {
          en: `${ticker} moves in a narrower range this week`,
          cs: `${ticker} se tento týden pohybuje v užším pásmu`,
          ago: 26 * 3600,
        },
        {
          en: `How ${ticker} has done against the rest of the crypto market this year`,
          cs: `Jak si ${ticker} vede proti zbytku kryptotrhu od začátku roku`,
          ago: 3 * 86400,
        },
      ]
    : [
        {
          en: `${name}: analysts expect modest revenue growth ahead of results`,
          cs: `${name}: analytici před výsledky čekají mírný růst tržeb`,
          ago: 3 * 3600,
        },
        {
          en: `${ticker} shares trade in a narrower range this week as the market waits for macro data`,
          cs: `Akcie ${ticker} se tento týden pohybují v užším pásmu, trh vyčkává na makrodata`,
          ago: 26 * 3600,
        },
        {
          en: `How ${ticker} has done against its sector this year`,
          cs: `Jak si ${ticker} vede proti sektoru od začátku roku`,
          ago: 3 * 86400,
        },
      ];
  const sumEn = "Invented headline for the demo. The real app fetches headlines from Yahoo Finance and shows a short summary here.";
  const sumCs = "Smyšlená zpráva pro demo. Skutečná aplikace stahuje titulky z Yahoo Finance a ukazuje tu krátké shrnutí.";
  return items.map((it) => ({ en: it.en, cs: it.cs, sumEn, sumCs, publisher: "Demo · sample news", url: "", ts: nowS - it.ago }));
}

