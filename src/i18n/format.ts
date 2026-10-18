// Locale-aware number helpers for the current UI language (see src/i18n/index.ts).
import { currentLang, currentLocale } from "./index";

/** Plain number in the UI language. */
export const fmtNum = (v: number, maxFrac = 0, minFrac = 0) =>
  v.toLocaleString(currentLocale(), { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac });

/** "12,5 %" (cs) / "12.5%" (en); `signed` adds + to positives. */
export const fmtPercent = (v: number, frac = 2, signed = false) => {
  const s = `${signed && v > 0 ? "+" : ""}${v.toLocaleString(currentLocale(), { maximumFractionDigits: frac, minimumFractionDigits: frac })}`;
  return currentLang() === "en" ? `${s}%` : `${s} %`;
};

/** Koruna amount: "1 234 Kč" (cs) / "CZK 1,234" (en). */
export const fmtCzk = (v: number) => {
  const n = Math.abs(Math.round(v)).toLocaleString(currentLocale());
  const sign = v < 0 ? "−" : "";
  return currentLang() === "en" ? `${sign}CZK ${n}` : `${sign}${n} Kč`;
};

/** Calendar date YYYY-MM-DD → "18. 10. 2026" / "Oct 18, 2026" (no time-zone shift). */
export const fmtDay = (iso: string, withYear = true) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(currentLocale(), { timeZone: "UTC", day: "numeric", month: currentLang() === "en" ? "short" : "numeric", ...(withYear ? { year: "numeric" } : {}) });
};

/** Short month name of YYYY-MM(-DD). */
export const fmtMonthShort = (iso: string) => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(currentLocale(), { timeZone: "UTC", month: "short" }).replace(".", "");
};

/** "říjen 2026" / "October 2026" of YYYY-MM(-DD). */
export const fmtMonthYear = (iso: string) => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(currentLocale(), { timeZone: "UTC", month: "long", year: "numeric" });
};
