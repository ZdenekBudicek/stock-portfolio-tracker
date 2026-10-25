// UI language (CZ / EN). One language for the whole app; amounts keep their own currency
// setting (EN + CZK and CZ + USD both work).
//
// Switching remounts the app subtree (LanguageProvider keys it by language), so every
// string, number format and chart locale is re-read — formatters can therefore read the
// current language at call time instead of threading it through every component.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import cs from "./locales/cs";
import en from "./locales/en";

export type Lang = "cs" | "en";
const STORAGE_KEY = "trackuju.language";

function storedLang(): Lang {
  try {
    // Demo build: the portfolio site links here with ?lang=en|cs matching its own language.
    const q = import.meta.env.MODE === "demo" ? new URLSearchParams(location.search).get("lang") : null;
    if (q === "cs" || q === "en") { localStorage.setItem(STORAGE_KEY, q); return q; }
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === "cs" || s === "en") return s;
  } catch { /* private mode */ }
  // The public demo opens in English (the portfolio site passes ?lang=cs for Czech visitors).
  return import.meta.env.MODE === "demo" ? "en" : "cs";
}

void i18n.use(initReactI18next).init({
  resources: { cs: { translation: cs }, en: { translation: en } },
  lng: storedLang(),
  fallbackLng: "cs",
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});
if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export const currentLang = (): Lang => (i18n.language === "en" ? "en" : "cs");
/** BCP-47 locale for Intl / toLocaleString. */
export const currentLocale = (): string => (currentLang() === "en" ? "en-US" : "cs-CZ");

export function setLanguage(lang: Lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  void i18n.changeLanguage(lang);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export default i18n;
