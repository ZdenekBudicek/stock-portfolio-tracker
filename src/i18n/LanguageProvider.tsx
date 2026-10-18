import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Remounts the app when the language changes, so every string, number and chart locale updates. */
export default function LanguageProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <Fragment key={i18n.language}>{children}</Fragment>;
}
