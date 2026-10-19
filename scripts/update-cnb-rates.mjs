// Refreshes src/data/cnbUsdCzk.json: the daily USD/CZK rates the Czech National Bank (ČNB)
// published, used by the tax report to convert each trade at the rate of ITS OWN date.
//
// The tax report never falls back to today's live rate — a date the file does not cover is
// shown as "chybí kurz". So re-run this after the end of each year (and before filing):
//
//   node scripts/update-cnb-rates.mjs            # 2015 … current year
//   node scripts/update-cnb-rates.mjs 2020       # 2020 … current year
//
// Source: the ČNB yearly file "kurzy devizového trhu", one line per business day:
//   Datum|1 AUD|…|1 USD|…      (header; repeated whenever the currency list changes)
//   02.01.2024|15,278|…|22,526|…
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const URL_FOR = (y) =>
  `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=${y}`;

/** "Datum|…|1 USD|…" + data lines → { "YYYY-MM-DD": rate } for USD (per 1 unit). */
export function parseCnbYear(text) {
  return Object.fromEntries(Object.entries(parseCnbCurrencies(text, ["USD"])).map(([date, r]) => [date, r.USD]));
}

/** Repeated headers and quoted units (e.g. 100 JPY) are handled per currency. */
export function parseCnbCurrencies(text, currencies = ["USD", "EUR", "GBP", "PLN"]) {
  const rates = {};
  let columns = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|");
    if (cells[0] === "Datum") {
      columns = currencies.map(currency => {
        const col = cells.findIndex(c => c.trim().endsWith(` ${currency}`));
        return { currency, col, amount: col >= 0 ? Number(cells[col].trim().split(/\s+/)[0]) : 0 };
      });
      continue;
    }
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cells[0] ?? "");
    if (!m) continue;
    const row = {};
    for (const { currency, col, amount } of columns) {
      const rate = Number(String(cells[col]).replace(",", ".")) / amount;
      if (col >= 0 && Number.isFinite(rate) && rate > 0) row[currency] = rate;
    }
    if (Object.keys(row).length === currencies.length) rates[`${m[3]}-${m[2]}-${m[1]}`] = row;
  }
  return rates;
}

async function main() {
  const OUT = fileURLToPath(new URL("../src/data/cnbUsdCzk.json", import.meta.url));
  const CROSS_OUT = fileURLToPath(new URL("../src/data/cnbRates.json", import.meta.url));
  const fromArg = process.argv.slice(2).find(a => /^\d{4}$/.test(a));
  const from = fromArg ? Number(fromArg) : 2015;
  const to = new Date().getFullYear();
  if (from < 1999 || from > to) throw new Error("Invalid start year");
  const rates = {};
  const cross = {};
  for (let y = from; y <= to; y++) {
    const res = await fetch(URL_FOR(y), { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`ČNB ${y}: HTTP ${res.status}`);
    const body = await res.text();
    const parsed = parseCnbYear(body), multi = parseCnbCurrencies(body);
    const n = Object.keys(parsed).length;
    if (n < (y === to ? 1 : 240)) throw new Error(`ČNB ${y}: only ${n} USD rates — refusing to write a partial file`);
    if (Object.keys(multi).length !== n) throw new Error(`ČNB ${y}: incomplete currency legs`);
    Object.assign(rates, parsed);
    Object.assign(cross, multi);
    console.log(`${y}: ${n} rates`);
  }
  const dates = Object.keys(rates).sort();
  const sorted = Object.fromEntries(dates.map((d) => [d, rates[d]]));
  const file = {
    source: "ČNB – kurzy devizového trhu, USD (1 USD = x CZK)",
    from: dates[0],
    to: dates[dates.length - 1],
    rates: sorted,
  };
  // All downloads validated before writing. Merge to retain old history when refreshing a recent year.
  const previous = JSON.parse(readFileSync(CROSS_OUT, "utf8"));
  const merged = { ...previous.rates, ...cross };
  const crossDates = Object.keys(merged).sort();
  writeFileSync(CROSS_OUT, JSON.stringify({ source: "ČNB – CZK per 1 USD/EUR/GBP/PLN", from: crossDates[0],
    to: crossDates.at(-1), rates: Object.fromEntries(crossDates.map(d => [d, merged[d]])) }) + "\n");
  console.log(`wrote ${crossDates.length} cross rates → ${CROSS_OUT}`);
  if (!process.argv.includes("--cross-only")) {
    const old = JSON.parse(readFileSync(OUT, "utf8"));
    file.rates = Object.fromEntries(Object.entries({ ...old.rates, ...file.rates }).sort(([a], [b]) => a.localeCompare(b)));
    file.from = Object.keys(file.rates)[0];
    file.to = Object.keys(file.rates).at(-1);
    writeFileSync(OUT, JSON.stringify(file) + "\n");
    console.log(`wrote USD rates → ${OUT}`);
  }
}

if (process.argv[1] && import.meta.url.startsWith("file:") && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
