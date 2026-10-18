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
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/data/cnbUsdCzk.json", import.meta.url));
const URL_FOR = (y) =>
  `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=${y}`;

/** "Datum|…|1 USD|…" + data lines → { "YYYY-MM-DD": rate } for USD (per 1 unit). */
export function parseCnbYear(text) {
  const rates = {};
  let usdCol = -1, usdAmount = 1;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|");
    if (cells[0] === "Datum") {
      usdCol = cells.findIndex((c) => / USD$/.test(c));
      usdAmount = usdCol >= 0 ? Number(cells[usdCol].split(" ")[0]) || 1 : 1;
      continue;
    }
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cells[0] ?? "");
    if (!m || usdCol < 0) continue;
    const rate = Number(String(cells[usdCol]).replace(",", ".")) / usdAmount;
    if (Number.isFinite(rate) && rate > 0) rates[`${m[3]}-${m[2]}-${m[1]}`] = rate;
  }
  return rates;
}

async function main() {
  const from = Number(process.argv[2]) || 2015;
  const to = new Date().getFullYear();
  const rates = {};
  for (let y = from; y <= to; y++) {
    const res = await fetch(URL_FOR(y));
    if (!res.ok) throw new Error(`ČNB ${y}: HTTP ${res.status}`);
    const parsed = parseCnbYear(await res.text());
    const n = Object.keys(parsed).length;
    if (n < (y === to ? 1 : 240)) throw new Error(`ČNB ${y}: only ${n} USD rates — refusing to write a partial file`);
    Object.assign(rates, parsed);
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
  writeFileSync(OUT, JSON.stringify(file) + "\n");
  console.log(`wrote ${dates.length} rates ${file.from} … ${file.to} → ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
