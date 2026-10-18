// CSV exports of the tax report for a Czech Excel: semicolon-separated, decimal comma,
// dates as D.M.YYYY, UTF-8 with a BOM (without it Excel reads the file as cp1250 and
// mangles every háček).
import type { SalesYearReport, TaxedDisposal } from "@/lib/czTax";
import type { DividendYearReport } from "@/lib/dividendTax";

const num = (n: number | null | undefined, dp = 2) => (n == null || !Number.isFinite(n) ? "" : n.toFixed(dp).replace(".", ","));
const date = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${Number(d)}.${Number(m)}.${y}`; };
const cell = (s: string) => (/[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows: string[][]): string {
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

const fxRef = (r: { rate: number; ref: string } | null) => (r ? r.ref.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${Number(d)}.${Number(m)}.${y}`) : "chybí");

const pctText = (share: number) => `${(share * 100).toFixed(1).replace(".", ",")} %`;
const statusOf = (r: TaxedDisposal) =>
  !r.exemptionsApply ? "Zdanitelné (krypto před 15.2.2025, bez osvobození)"
  : r.exempt && r.capTaxedShare > 0 ? `Osvobozeno (časový test), ${pctText(r.capTaxedShare)} zdaněno nad stropem 40 mil. Kč`
  : r.exempt ? "Osvobozeno (časový test)" : "Zdanitelné";

export function salesCsvRows(rep: SalesYearReport): string[][] {
  const head = [
    "Datum prodeje", "Ticker", "Druh", "Broker", "Účet", "Počet ks", "Datum nabytí", "Drženo dní", "Status",
    "Prodejní cena USD/ks", "Příjem USD", "Pořizovací cena USD/ks", "Náklady USD (vč. poplatku za nákup)", "Poplatek za prodej USD",
    "Kurz nákup", "Kurz nákup – den", "Kurz prodej", "Kurz prodej – den",
    "Příjem CZK", "Náklady CZK", "Poplatek za prodej CZK", "Zisk CZK",
  ];
  const lines = rep.rows.map((r) => [
    date(r.soldDate), r.ticker, r.assetKind === "crypto" ? "Krypto" : "Cenný papír", r.broker, r.account, num(r.shares, 6), r.kind === "merger-cash" ? `${date(r.acquiredDate)} (doplatek fúze)` : date(r.acquiredDate),
    String(r.heldDays), statusOf(r),
    num(r.sellPriceUsd, 4), num(r.proceedsUsd), num(r.buyPriceUsd, 4), num(r.costUsd), num(r.sellFeeUsd),
    num(r.fxBuy?.rate ?? null, 3), fxRef(r.fxBuy), num(r.fxSell?.rate ?? null, 3), fxRef(r.fxSell),
    num(r.proceedsCzk), num(r.costCzk), num(r.sellFeeCzk), num(r.gainCzk),
  ]);
  const sum = (label: string, value: number | string) => [label, typeof value === "number" ? num(value) : value];
  return [
    head, ...lines, [],
    sum(`Příjmy z prodeje ${rep.year} celkem (CZK)`, rep.proceedsCzk),
    sum("Cenné papíry – započteno do limitu 100 000 Kč (CZK)", rep.securities.limitBaseCzk),
    sum("Cenné papíry – limit 100 000 Kč", rep.securities.underLimit ? "nepřekročen – příjmy z prodeje osvobozeny" : "překročen"),
    ...(rep.crypto.rowCount > 0 || rep.crypto.unmatchedProceedsCzk > 0 ? [
      sum("Krypto – příjmy z prodeje (CZK)", rep.crypto.proceedsCzk),
      sum("Krypto – započteno do vlastního limitu 100 000 Kč (CZK)", rep.crypto.limitBaseCzk),
      sum("Krypto – limit 100 000 Kč", !rep.crypto.limitApplies ? "neexistuje (prodeje před 15.2.2025)" : rep.crypto.underLimit ? "nepřekročen – osvobozeno" : "překročen"),
      sum("Krypto – zdanitelný zisk (CZK)", rep.crypto.taxable.gainCzk),
      sum("Krypto – dílčí základ (CZK)", rep.crypto.taxBaseCzk),
    ] : []),
    ...(rep.cap.taxedShare > 0 ? [
      sum("Příjmy osvobozené časovým testem pod stropem 40 mil. Kč (CZK)", rep.cap.baseCzk),
      sum("Nad stropem 40 mil. Kč zdaněno", pctText(rep.cap.taxedShare)),
      sum("Nad stropem 40 mil. Kč – zdanitelný zisk (CZK)", rep.cap.taxedGainCzk),
    ] : []),
    sum("Zdanitelné loty – příjmy (CZK)", rep.taxable.proceedsCzk),
    sum("Zdanitelné loty – výdaje (CZK)", rep.taxable.expensesCzk),
    sum("Zdanitelné loty – zisk (CZK)", rep.taxable.gainCzk),
    sum("Osvobozeno časovým testem – zisk (CZK)", rep.exempt.gainCzk),
    sum("Dílčí základ daně z prodejů (CZK)", rep.taxBaseCzk),
    ...(rep.complete ? [] : [["POZOR: chybí kurz ČNB pro", rep.missingFx.map(date).join(", ")]]),
  ];
}

export function dividendsCsvRows(rep: DividendYearReport): string[][] {
  const basis = { exact: "přesně", gross: "hrubá z výpisu, daň dopočtena 15 %", net: "čistá, hrubá dopočtena (15 %)" } as const;
  const head = [
    "Datum výplaty", "Ticker", "Broker", "Hrubá USD", "Sražená daň USD", "Čistá USD", "Kurz", "Kurz – den",
    "Hrubá CZK", "Sražená daň CZK", "Započitatelná daň CZK", "Základ částky", "Odhad (bez výpisu)",
  ];
  const lines = rep.rows.map((r) => [
    date(r.payDate), r.ticker, r.broker, num(r.grossUsd), num(r.whtUsd), num(r.netUsd),
    num(r.fx?.rate ?? null, 3), fxRef(r.fx), num(r.grossCzk), num(r.whtCzk), num(r.creditableCzk),
    basis[r.basis], r.estimated ? "ano" : "",
  ]);
  return [
    head, ...lines, [],
    [`Hrubé dividendy ${rep.year} (CZK)`, num(rep.grossCzk)],
    ["Sražená daň v zahraničí (CZK)", num(rep.whtCzk)],
    ["Započitatelná daň, max. 15 % (CZK)", num(rep.creditableCzk)],
    ["Daň 15 % v ČR (CZK)", num(rep.czTaxCzk)],
    ["Doplatek po zápočtu (CZK)", num(rep.topUpCzk)],
    ...(rep.complete ? [] : [["POZOR: chybí kurz ČNB pro", rep.missingFx.map(date).join(", ")]]),
  ];
}

export function downloadCsv(filename: string, rows: string[][]) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
