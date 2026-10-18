// Invented company financials for the demo (rough orders of magnitude, NOT real reported figures),
// so the stock detail's financial charts and fair-value models have something to show.
import type { CompanyFundamentals, FundamentalMetric, FundamentalSeries } from "@/types/fundamentals";

interface Profile { rev: number; g: number; gm: number; om: number; shares: number; div: number; buy: number; cash: number; debt: number; capex: number }
// rev = latest annual revenue (bn USD), g = yearly growth, gm/om = gross/operating margin,
// shares = diluted shares (bn), div/buy = share of net income paid out / bought back.
const P: Record<string, Profile> = {
  AAPL: { rev: 395, g: 0.05, gm: 0.46, om: 0.31, shares: 15.2, div: 0.15, buy: 0.85, cash: 65, debt: 100, capex: 0.03 },
  MSFT: { rev: 270, g: 0.14, gm: 0.69, om: 0.45, shares: 7.45, div: 0.25, buy: 0.18, cash: 75, debt: 45, capex: 0.2 },
  NVDA: { rev: 150, g: 0.6, gm: 0.74, om: 0.6, shares: 24.5, div: 0.01, buy: 0.4, cash: 55, debt: 9, capex: 0.03 },
  ASML: { rev: 32, g: 0.12, gm: 0.52, om: 0.33, shares: 0.393, div: 0.33, buy: 0.2, cash: 12, debt: 4, capex: 0.06 },
  GOOGL: { rev: 370, g: 0.13, gm: 0.58, om: 0.32, shares: 12.3, div: 0.08, buy: 0.6, cash: 95, debt: 12, capex: 0.14 },
  AMZN: { rev: 680, g: 0.11, gm: 0.49, om: 0.11, shares: 10.7, div: 0, buy: 0, cash: 85, debt: 58, capex: 0.12 },
  META: { rev: 175, g: 0.2, gm: 0.82, om: 0.41, shares: 2.6, div: 0.07, buy: 0.5, cash: 70, debt: 29, capex: 0.25 },
  V: { rev: 38, g: 0.1, gm: 0.8, om: 0.67, shares: 1.98, div: 0.22, buy: 0.7, cash: 18, debt: 21, capex: 0.04 },
  KO: { rev: 47, g: 0.04, gm: 0.61, om: 0.29, shares: 4.33, div: 0.75, buy: 0.05, cash: 12, debt: 43, capex: 0.05 },
  O: { rev: 5.4, g: 0.15, gm: 0.92, om: 0.43, shares: 0.89, div: 1.4, buy: 0, cash: 0.4, debt: 27, capex: 0.02 },
  SAP: { rev: 37, g: 0.09, gm: 0.73, om: 0.24, shares: 1.17, div: 0.4, buy: 0.25, cash: 10, debt: 9, capex: 0.03 },
  INTC: { rev: 53, g: -0.04, gm: 0.38, om: 0.02, shares: 4.3, div: 0.2, buy: 0, cash: 22, debt: 50, capex: 0.45 },
  DIS: { rev: 93, g: 0.04, gm: 0.36, om: 0.13, shares: 1.83, div: 0.15, buy: 0.2, cash: 6, debt: 42, capex: 0.08 },
  TSLA: { rev: 97, g: 0.08, gm: 0.18, om: 0.08, shares: 3.5, div: 0, buy: 0, cash: 36, debt: 8, capex: 0.11 },
  AMD: { rev: 30, g: 0.2, gm: 0.53, om: 0.1, shares: 1.63, div: 0, buy: 0.6, cash: 5.5, debt: 2, capex: 0.03 },
  COST: { rev: 265, g: 0.07, gm: 0.13, om: 0.036, shares: 0.445, div: 0.3, buy: 0.1, cash: 13, debt: 6, capex: 0.018 },
  UBER: { rev: 48, g: 0.16, gm: 0.39, om: 0.08, shares: 2.15, div: 0, buy: 0.4, cash: 7, debt: 9.8, capex: 0.005 },
  PLTR: { rev: 3.4, g: 0.3, gm: 0.8, om: 0.12, shares: 2.55, div: 0, buy: 0, cash: 5, debt: 0.2, capex: 0.01 },
};

const METRICS: FundamentalMetric[] = ["revenue", "grossProfit", "operatingIncome", "netIncome", "operatingCashFlow", "capex",
  "freeCashFlow", "buybacks", "dilutedEps", "cash", "totalDebt", "sharesOutstanding", "dilutedShares", "equity",
  "dividendsPaid", "rnd", "sga", "costOfRevenue", "ebitda"];

function hash(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function rng(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function series(p: Profile, periods: string[], scale: number, gPer: number, r: () => number): FundamentalSeries {
  const n = periods.length;
  const v = Object.fromEntries(METRICS.map((m) => [m, [] as (number | null)[]])) as FundamentalSeries["values"];
  for (let i = 0; i < n; i++) {
    const back = n - 1 - i;
    const wobble = 1 + (r() - 0.5) * 0.06;
    const rev = p.rev * 1e9 * scale * Math.pow(1 + gPer, -back) * wobble;
    const om = p.om * (1 + (r() - 0.5) * 0.12) * (1 - back * 0.01);
    const gp = rev * p.gm;
    const op = rev * om;
    const ni = op * 0.82;
    const shares = p.shares * 1e9 * (1 + back * (p.buy > 0.3 ? 0.02 : 0.003) * (scale === 1 ? 1 : 0.25));
    const ocf = ni * 1.18 + rev * 0.03;
    const capex = -rev * p.capex;
    const rnd = rev * Math.max(0, (p.gm - p.om) * 0.45);
    const sga = rev * Math.max(0, p.gm - p.om) - rnd;
    v.revenue.push(rev); v.grossProfit.push(gp); v.costOfRevenue.push(rev - gp); v.operatingIncome.push(op); v.netIncome.push(ni);
    v.operatingCashFlow.push(ocf); v.capex.push(capex); v.freeCashFlow.push(ocf + capex);
    v.buybacks.push(-Math.max(0, ni) * p.buy); v.dividendsPaid.push(-Math.max(0, ni) * p.div);
    v.dilutedEps.push(ni / shares); v.sharesOutstanding.push(shares * 0.99); v.dilutedShares.push(shares);
    v.cash.push(p.cash * 1e9 * (1 + (r() - 0.5) * 0.2)); v.totalDebt.push(p.debt * 1e9 * (1 + back * 0.02 * (scale === 1 ? 1 : 0.25)));
    v.equity.push(rev * (0.35 + r() * 0.1)); v.rnd.push(rnd); v.sga.push(sga); v.ebitda.push(op + rev * p.capex * 0.8);
  }
  return { periods, values: v };
}

export function demoFundamentals(today: string): Record<string, unknown>[] {
  const year = Number(today.slice(0, 4));
  const annual = Array.from({ length: 6 }, (_, i) => `${year - 6 + i}-12-31`);
  const q: string[] = [];
  const ends = ["03-31", "06-30", "09-30", "12-31"];
  for (let y = year - 3; y <= year; y++) for (const e of ends) if (`${y}-${e}` < today) q.push(`${y}-${e}`);
  const quarterly = q.slice(-12);
  return Object.entries(P).map(([symbol, p]) => {
    const data: Omit<CompanyFundamentals, "symbol" | "fetchedAt" | "status"> = {
      currency: "USD",
      annual: series(p, annual, 1, p.g, rng(hash(symbol + "a"))),
      quarterly: series(p, quarterly, 0.25, Math.pow(1 + p.g, 0.25) - 1, rng(hash(symbol + "q"))),
    };
    return { symbol, data, currency: "USD", fetched_at: `${today}T03:00:00+00:00`, status: "ok" };
  });
}
