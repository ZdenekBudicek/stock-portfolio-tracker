// Display currencies. Amounts are stored in USD; the app shows them in USD or in a "local"
// currency. Koruna figures were always computed precisely — a purchase at the USD/CZK of its
// own day, today's value at today's rate, so a profit includes the currency move. Every other
// local currency is derived from those koruna figures at the ČNB rate OF THE SAME DAY:
//   amount_L(d) = amount_CZK(d) / (CZK per 1 L on d)
// which equals USD × (USD→L on d) through the ČNB cross rate. Taxes never use this: each tax
// engine keeps its own statutory currency and rates.
import bundled from "@/data/cnbRates.json";

export type DisplayCurrency = "USD" | "CZK" | "EUR" | "GBP" | "PLN";
export type LocalCurrency = Exclude<DisplayCurrency, "USD">;
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ["USD", "CZK", "EUR", "GBP", "PLN"];

export const isDisplayCurrency = (v: unknown): v is DisplayCurrency =>
  typeof v === "string" && (DISPLAY_CURRENCIES as readonly string[]).includes(v);

export const normalizeDisplayCurrency = (raw: string | null | undefined, fallback: DisplayCurrency = "CZK"): DisplayCurrency => {
  const v = String(raw ?? "").trim().toUpperCase();
  return isDisplayCurrency(v) ? v : fallback;
};

type Row = Partial<Record<LocalCurrency | "USD", number>>;
interface Table { rates: Record<string, Row> }

/** CZK per 1 unit of `cur` on `date` (last ČNB rate on or before it; before the series: the first). */
export function createCzkPer(table: Table) {
  const cache = new Map<LocalCurrency, { d: string[]; v: number[] }>();
  const series = (cur: LocalCurrency) => {
    let s = cache.get(cur);
    if (!s) {
      const d: string[] = [], v: number[] = [];
      for (const date of Object.keys(table.rates).sort()) {
        const r = cur === "CZK" ? 1 : Number(table.rates[date][cur]);
        if (r > 0) { d.push(date); v.push(r); }
      }
      s = { d, v };
      cache.set(cur, s);
    }
    return s;
  };
  return (cur: LocalCurrency, date?: string): number => {
    if (cur === "CZK") return 1;
    const { d, v } = series(cur);
    if (!d.length) return NaN;
    if (!date) return v[v.length - 1];
    let lo = 0, hi = d.length - 1, best = v[0];
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (d[m] <= date) { best = v[m]; lo = m + 1; } else hi = m - 1;
    }
    return best;
  };
}

export const czkPer = createCzkPer(bundled as unknown as Table);

/** Converts koruna amounts into the local currency: `at(date)` per day, `today` for live values. */
export interface LocalFx {
  code: LocalCurrency;
  /** Local units per 1 CZK on that day. */
  perCzkAt: (date: string) => number;
  /** Local units per 1 CZK today. */
  perCzkToday: number;
}

/** `liveCzkPer`: today's market CZK per 1 unit (as USD/CZK is live); without it the latest ČNB rate. */
export function localFx(code: LocalCurrency, per: (cur: LocalCurrency, date?: string) => number = czkPer, liveCzkPer?: number): LocalFx {
  if (code === "CZK") return { code, perCzkAt: () => 1, perCzkToday: 1 };
  const today = 1 / (liveCzkPer && liveCzkPer > 0 ? liveCzkPer : per(code));
  return { code, perCzkAt: (date) => 1 / per(code, date.slice(0, 10)), perCzkToday: today };
}

/** Decimal places a currency is usually shown with in this app. */
export const decimalsOf = (c: DisplayCurrency) => (c === "CZK" ? 0 : 2);

/** "1 234 Kč", "1 234,56 €", "€1,234.56", "£1,234.56", "1 234,56 zł", "$1,234.56". */
export function formatMoney(val: number, c: DisplayCurrency, lang: "cs" | "en", opts: { decimals?: number; signed?: boolean } = {}): string {
  const dec = opts.decimals ?? decimalsOf(c);
  const abs = Math.abs(val);
  // Dollars are always written the American way ("$1,234.56"), as brokers show them.
  const n = abs.toLocaleString(lang === "en" || c === "USD" ? "en-US" : "cs-CZ", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const sign = val < 0 ? "-" : opts.signed && val > 0 ? "+" : "";
  return sign + wrapSymbol(n, c, lang);
}

/** Puts the currency mark around an already formatted number. */
export function wrapSymbol(n: string, c: DisplayCurrency, lang: "cs" | "en"): string {
  switch (c) {
    case "USD": return `$${n}`;
    case "GBP": return lang === "en" ? `£${n}` : `${n} £`;
    case "EUR": return lang === "en" ? `€${n}` : `${n} €`;
    case "CZK": return lang === "en" ? `CZK ${n}` : `${n} Kč`;
    case "PLN": return lang === "en" ? `PLN ${n}` : `${n} zł`;
  }
}

/** Compact amount for axes, tiles and tight rows: "$60.6K", "1,26 mil. Kč", "€58.2K". */
export function compactMoney(val: number, c: DisplayCurrency, lang: "cs" | "en", maxDecimals = 1): string {
  const n = new Intl.NumberFormat(lang === "en" || c === "USD" ? "en-US" : "cs-CZ", { notation: "compact", maximumFractionDigits: maxDecimals }).format(Math.abs(val));
  return (val < 0 ? "-" : "") + wrapSymbol(n, c, lang);
}

/** Short mark for toggles and axis labels. */
export function symbolOf(c: DisplayCurrency, lang: "cs" | "en"): string {
  switch (c) {
    case "USD": return "$";
    case "EUR": return "€";
    case "GBP": return "£";
    case "CZK": return lang === "en" ? "CZK" : "Kč";
    case "PLN": return lang === "en" ? "PLN" : "zł";
  }
}
