// Client-side broker statement parsers. Raw files are parsed in the browser and
// never uploaded; only the normalized rows below are imported on confirmation.

export type Kind = "TRADE" | "DEPOSIT" | "WITHDRAWAL" | "DIVIDEND" | "FEE" | "SPLIT" | "HOLDING" | "SKIP";
export type Side = "BUY" | "SELL";

export interface NormalizedRow {
  external_id: string;
  broker: "XTB" | "Revolut" | "T212";
  /**
   * The broker ACCOUNT this row belongs to (T212 Invest number, Revolut account number,
   * XTB account number). A person can hold several accounts at the same broker, and every
   * reconciliation must stay inside the account it came from — otherwise syncing account A
   * wipes account B's holdings (and a ticker held at both gets one account's cost basis).
   */
  account?: string;
  kind: Kind;
  czk?: number; // for CZK-denominated source rows (T212) -> converted to USD on import
  ccy?: string; // instrument currency (T212 trades)
  isin?: string; // ISA/ISIN of the instrument (T212 trades) — used to resolve foreign tickers
  price_ccy?: number; // per-share price in the instrument currency (T212 trades)
  value_ccy?: number; // trade value in instrument currency
  ticker?: string;
  side?: Side;
  shares?: number;
  price_usd?: number;
  fee_usd?: number;
  amount_usd?: number; // for cash ops / dividends / fees (signed where meaningful)
  ratio?: number; // for SPLIT
  avg_price_ccy?: number; // HOLDING: broker's own average cost, in the instrument currency
  executed_at: string; // ISO
  label: string; // human description for the review table
}

/** Currencies a statement can quote a transaction in (used to tell them from "OTC"/"Trh"). */
const CCY_RE = /\b(USD|CZK|EUR|GBP|GBX|CHF|PLN|HUF|SEK|NOK|DKK|CAD|AUD|JPY)\b/g;

/** Excel serial date (days since 1899-12-30, UTC) -> ISO string. */
export function excelDateToISO(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString();
}

/** Strip XTB exchange suffix: AMD.US -> AMD, ASML.US -> ASML. */
export function stripSuffix(t: string): string {
  return (t || "").replace(/\.[A-Z]{2,3}$/i, "").toUpperCase();
}

/** Parse XTB trade comment: "OPEN BUY 0.8956 @ 95.94" / "CLOSE BUY 3/3.2405 @ 234.15". */
export function parseXtbTradeComment(comment: string): { shares: number; price: number } | null {
  const m = /(?:OPEN|CLOSE)\s+(?:BUY|SELL)\s+([\d.]+)(?:\/[\d.]+)?\s*@\s*([\d.]+)/i.exec(comment || "");
  if (!m) return null;
  const shares = parseFloat(m[1]);
  const price = parseFloat(m[2]);
  if (!Number.isFinite(shares) || !Number.isFinite(price)) return null;
  return { shares, price };
}

/** Parse XTB split comment: "LRCX.US split 10 for 1" -> ratio 10. */
export function parseXtbSplitComment(comment: string): number | null {
  const m = /split\s+([\d.]+)\s+for\s+([\d.]+)/i.exec(comment || "");
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!a || !b) return null;
  return a / b;
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** "25 Feb 2021 16:21:12" -> ISO (GMT). */
export function parseRevolutDate(s: string): string | null {
  const m = /(\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2})/.exec(s);
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${MONTHS[m[2]]}-${m[1]}T${m[4]}.000Z`;
}

/** "1,106.51" -> 1106.51 ; handles a leading minus. */
export function parseUsd(s: string): number {
  return parseFloat(String(s).replace(/,/g, ""));
}

/**
 * Parse the Revolut "Portfolio breakdown" section = current holdings (authoritative
 * snapshot). Far more reliable than replaying trades, which over/under-counts when
 * the export lacks complete history (transfers, pre-period buys).
 * Row shape (browser PDF extraction): "TICKER Company... ISIN12 Qty US$Price US$Value pct%".
 */
export function parseRevolutHoldings(text: string): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const account = parseRevolutAccount(text) ?? undefined;
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (/Portfolio breakdown/i.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    if (/^(Positions Value|Cash value|Total)\b/i.test(line) || /Transactions/i.test(line)) { inSection = false; continue; }
    if (/^Symbol\s+Company/i.test(line)) continue; // column header — skip, stay in section
    const m = /^([A-Z][A-Z.]{0,5})\s+.+?\s+([A-Z0-9]{12})\s+([\d.]+)\s+US\$([\d.,]+)/.exec(line);
    if (!m) continue;
    const ticker = m[1].toUpperCase();
    const shares = parseFloat(m[3]);
    const price = parseUsd(m[4]);
    if (!(shares > 0)) continue;
    out.push({
      external_id: `revolut:pos:${ticker}`, broker: "Revolut", account, kind: "HOLDING",
      ticker, shares, price_usd: price, executed_at: new Date().toISOString(),
      label: `${ticker}: ${shares} ks @ $${price}`,
    });
  }
  return out;
}

/**
 * Parse Revolut statement text (extracted from the PDF with layout). One transaction
 * per line, classified by keyword. No stable id in the PDF, so external_id is a
 * deterministic composite key for idempotency.
 */
export function parseRevolutText(text: string): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const account = parseRevolutAccount(text) ?? undefined;
  // GMT may be glued to the next column in the PDF extraction ("…13:30:00 GMTTSLA Trade"),
  // so don't require a word boundary after GMT — otherwise that whole row is skipped.
  const dateRe = /^(\d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2}) GMT/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    const dm = dateRe.exec(line);
    if (!dm) continue;
    const executed_at = parseRevolutDate(dm[1]);
    if (!executed_at) continue;
    const rest = line.slice(dm[0].length).trim();
    // The de-duplication id must describe the TRADE, never the raw PDF text. pdfjs splits a
    // row into text items differently between exports — "US$9,890.88 US$0.01" in one file,
    // "US$9,890.88US$0.01" in another — and an id built from that text made the SAME trade
    // look new on a re-import. That is how this portfolio ended up with a duplicated Revolut
    // statement: phantom buys and sells in the ledger, papered over in `positions` by broker
    // reconciliation, and drawn in full in the history chart.
    const key = (kind: string, ...parts: (string | number)[]) =>
      `revolut:${dm[1]}:${kind}${parts.map((p) => `:${typeof p === "number" ? p.toFixed(6) : p}`).join("")}`.slice(0, 200);

    let m: RegExpExecArray | null;
    // "Trade - Market" rows. pdfjs can reorder columns, glue the ticker to "Trade"
    // ("GOOGLTrade"), and glue the value to the side ("US$3,099.55Sell"). So instead of a
    // strict column order we derive everything robustly: ticker before "Trade - Market",
    // side from Buy/Sell, the trade value from the amount tied to Buy/Sell, and quantity as
    // the only number NOT prefixed with US$. Per-share price = value / quantity, which is
    // order-independent and always matches the broker. Fees+commission = US$ after the value.
    if (/Trade - Market/i.test(rest)) {
      const ticker = (/^([A-Z][A-Z.]{0,5})\s*Trade - Market/.exec(rest)?.[1] || "").toUpperCase();
      const side: Side = /Sell/.test(rest) ? "SELL" : "BUY";
      const valM = /(?:Buy|Sell)\s*US\$([\d.,]+)/.exec(rest);
      const value = valM ? parseUsd(valM[1]) : 0;
      const afterTrade = rest.replace(/^.*Trade - Market/, "").replace(/US\$[\d.,]+/g, " ");
      const shares = parseFloat((/([\d]+(?:\.[\d]+)?)/.exec(afterTrade) || [])[1] || "0");
      const afterVal = valM ? rest.slice(valM.index + valM[0].length) : "";
      const fee = [...afterVal.matchAll(/US\$([\d.,]+)/g)].reduce((a, x) => a + parseUsd(x[1]), 0);
      if (ticker && shares > 0 && value > 0) {
        // "Value" is the NET CASH of the trade — quantity × price PLUS commission on a buy,
        // MINUS fees on a sell. Deriving the price from it baked the fee into the per-share
        // price, and the fee was then added to the cost basis a second time. Prefer the
        // printed per-share price (the US$ amount immediately before Buy/Sell), but only
        // when it is consistent with the quantity: pdfjs sometimes glues the VALUE onto the
        // side instead ("US$3,099.55Sell"), and that number would be wildly off.
        const printed = parseUsd(/US\$([\d.,]+)\s*(?:Buy|Sell)/.exec(rest)?.[1] ?? "");
        const plausible = Number.isFinite(printed) && printed > 0 && Math.abs(printed * shares - value) <= Math.max(0.02 * value, 0.02);
        const price = plausible ? printed : value / shares;
        // Ticker + side + quantity at a given second identifies the fill. Price is left OUT
        // on purpose: it is derived (printed vs. value/quantity), so a parser improvement
        // would otherwise re-key every historical trade and duplicate the lot.
        out.push({ external_id: key("trade", ticker, side, shares), broker: "Revolut", kind: "TRADE", ticker,
          side, shares, price_usd: price, fee_usd: fee,
          executed_at, label: `${side} ${shares} × ${ticker} @ $${price.toFixed(2)}` });
      }
      continue;
    }
    if ((m = /^(\S+) Merger - stock (-?[\d.]+)/.exec(rest))) {
      // negative qty: shares removed (old ticker); positive: shares received (new ticker), cost 0
      const qty = parseFloat(m[2]);
      out.push({ external_id: key("merger", m[1].toUpperCase(), qty), broker: "Revolut", kind: "TRADE", ticker: m[1].toUpperCase(),
        side: qty < 0 ? "SELL" : "BUY", shares: Math.abs(qty), price_usd: 0, fee_usd: 0,
        executed_at, label: `Merger ${qty < 0 ? "odebráno" : "přidáno"} ${Math.abs(qty)} × ${m[1]}` });
    } else if ((m = /^(\S+)? ?Merger - cash -?US\$([\d.,]+)/.exec(rest))) {
      out.push({ external_id: key("mergercash", parseUsd(m[2])), broker: "Revolut", kind: "DEPOSIT", amount_usd: parseUsd(m[2]),
        executed_at, label: `Merger výplata $${parseUsd(m[2])}` });
    } else if ((m = /^([A-Z][A-Z.]*?)\s*Stock split\s+([\d.]+)/.exec(rest))) {
      // Revolut lists a split as explicit added shares (at $0): e.g. a 3:1 split of a 2.08
      // holding shows "+4.16". Count them so the current position is correct AND the cost
      // basis stays right (more shares, same total cost). The ':split:' ext_id lets the
      // snapshot worker skip its own Yahoo split-adjust for this ticker (no double-count).
      out.push({ external_id: `revolut:split:${m[1].toUpperCase()}:${dm[1]}`, broker: "Revolut", kind: "TRADE",
        ticker: m[1].toUpperCase(), side: "BUY", shares: parseFloat(m[2]), price_usd: 0, fee_usd: 0,
        executed_at, label: `Split +${m[2]} × ${m[1]}` });
    } else if (/Transfer from .* to /.test(rest)) {
      // inter-entity transfer = same shares moving; ignore to avoid double counting
      continue;
    } else if ((m = /^([A-Z][A-Z.]*?)\s*Dividend\s+-?US\$([\d.,]+)/.exec(rest))) {
      out.push({ external_id: key("div", m[1].toUpperCase(), parseUsd(m[2])), broker: "Revolut", kind: "DIVIDEND", ticker: m[1].toUpperCase(),
        amount_usd: parseUsd(m[2]), executed_at, label: `Dividenda ${m[1]} $${parseUsd(m[2])}` });
    } else if ((m = /^Cash top-up US\$([\d.,]+)/.exec(rest))) {
      out.push({ external_id: key("dep", parseUsd(m[1])), broker: "Revolut", kind: "DEPOSIT", amount_usd: parseUsd(m[1]),
        executed_at, label: `Vklad $${parseUsd(m[1])}` });
    } else if ((m = /^Cash withdrawal -?US\$([\d.,]+)/.exec(rest))) {
      out.push({ external_id: key("wd", parseUsd(m[1])), broker: "Revolut", kind: "WITHDRAWAL", amount_usd: parseUsd(m[1]),
        executed_at, label: `Výběr $${parseUsd(m[1])}` });
    } else if ((m = /^Custody fee -?US\$([\d.,]+)/.exec(rest)) || (m = /^(?:.*\b)?Fee -?US\$([\d.,]+)/.exec(rest))) {
      out.push({ external_id: key("fee", parseUsd(m[1])), broker: "Revolut", kind: "FEE", amount_usd: -Math.abs(parseUsd(m[1])),
        executed_at, label: `Poplatek $${parseUsd(m[1])}` });
    }
    // unknown date-prefixed lines are ignored
  }
  return account ? out.map((r) => ({ ...r, account })) : out;
}

/**
 * The Trading 212 Invest account number a statement belongs to ("Číslo účtu: 1234567").
 * One person can have several T212 accounts, and their statements are interchangeable at
 * a glance — so every row is tagged with this and reconciliation is scoped by it.
 * Falls back to the customer id ("ZÁKAZNICKÉ ID") when the account number isn't printed.
 */
export function parseT212Account(text: string): string | null {
  const head = text.slice(0, 20000);
  const acc = /Číslo účtu:?\s*(\d{4,})/i.exec(head);
  if (acc) return acc[1];
  const cust = /ZÁKAZNICKÉ ID[\s\S]{0,80}?(\d{6,})/i.exec(head);
  return cust ? cust[1] : null;
}

/** The Revolut account number a statement belongs to ("Account number   12345678"). */
export function parseRevolutAccount(text: string): string | null {
  const m = /Account number\s+(\d{4,})/i.exec(text.slice(0, 20000));
  return m ? m[1] : null;
}

/**
 * Parse a Trading 212 "Výpis aktivit" (Activity Statement) PDF text. This is the
 * authoritative full history: every dated trade (buy & sell, with ISIN + price) and
 * every cash deposit/withdrawal. Amounts are in the account currency (CZK) and carried
 * on `czk`/`value_ccy`; the importer converts them to USD using the FX on each date.
 */
export function parseT212Activity(text: string): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const account = parseT212Account(text) ?? undefined;
  // Trade rows up to the SMĚR (side) column. Everything after it is parsed positionally
  // rather than by regex, because T212 leaves individual cells EMPTY on some rows.
  const tradeRe = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\s+(\S+)\s+([A-Z0-9]{12})\s+([A-Z]{3})\s+(\d+)\s+(Koupit|Prodat)\s+(.+)$/;
  const cashRe = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\s+(.+?)\s+CZK\s+(-?[\d,.]+)\s+CZK\s+(-?[\d,.]+)\s*$/;
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, " ").trim();
    let m = tradeRe.exec(l);
    if (m) {
      const orderId = m[5];
      if (seen.has(orderId)) continue;
      // MNOŽSTVÍ and PROVEDENÍ (price) are always printed; HODNOTA (trade value) is NOT —
      // T212 leaves it blank on some rows (observed on large sells). Demanding it made the
      // whole trade silently vanish: a 909.6-share NU sell was dropped and the position
      // stayed ~2x too large until the broker sync "corrected" it with a phantom adjustment.
      const tail = m[7].trim().split(" ");
      const shares = parseFloat(tail[0]);
      const price = parseFloat(tail[1]);
      if (!Number.isFinite(shares) || !Number.isFinite(price)) continue;
      seen.add(orderId);
      // Third column is the trade value only when it is numeric; otherwise it's the order
      // type ("Trh"/"Limit"/…) and the value has to be derived.
      const third = parseFloat(tail[2]);
      const value = Number.isFinite(third) ? third : shares * price;
      // The trailing HODNOTA is in MĚNA TRANSAKCE, which is USD on some rows and CZK on
      // others — it is NOT always CZK. Only carry it as `czk` when it really is CZK, so the
      // importer's FX conversion can't turn a USD amount into a 20x-too-small one.
      const txCcy = (l.match(CCY_RE) ?? []).pop();
      const total = parseUsd((l.match(/([\d,.]+)\s*$/) || ["", "0"])[1]);
      const side: Side = m[6] === "Koupit" ? "BUY" : "SELL";
      out.push({
        external_id: `t212:act:${orderId}`, broker: "T212", account, kind: "TRADE", ticker: m[2].toUpperCase(), isin: m[3],
        side, shares, ccy: m[4], price_ccy: price, value_ccy: value, czk: txCcy === "CZK" ? total : undefined,
        executed_at: `${m[1]}T12:00:00.000Z`, label: `${side === "BUY" ? "Nákup" : "Prodej"} ${shares} × ${m[2]}`,
      });
      continue;
    }
    m = cashRe.exec(l);
    if (m) {
      const label = m[2]; const amt = parseUsd(m[3]);
      // Fees, free-share bonuses and dividends are not external cash deposits. ("Akcie
      // zdarma" = a free-share promo; the shares themselves come in via the trades/holdings,
      // at $0 cost.) Dividends are imported separately from the API.
      if (/Poplatek|Akcie zdarma|Dividend/i.test(label)) continue;
      if (/vklad|Adyen|Bankovní převod|převod/i.test(label) && amt > 0)
        out.push({ external_id: `t212:dep:${account ?? "x"}:${m[1]}:${Math.round(amt)}`, broker: "T212", account, kind: "DEPOSIT", czk: amt, executed_at: `${m[1]}T12:00:00.000Z`, label: `Vklad ${amt} Kč` });
      // "Výběr" = withdrawal; "Refundace" = an Adyen deposit refunded back out (the summary
      // counts it under Výběry), so it nets against deposits too.
      else if (/Výběr|Refundace/i.test(label) && amt < 0)
        out.push({ external_id: `t212:wd:${account ?? "x"}:${m[1]}:${Math.round(-amt)}`, broker: "T212", account, kind: "WITHDRAWAL", czk: amt, executed_at: `${m[1]}T12:00:00.000Z`, label: `Výběr ${amt} Kč` });
    }
  }
  return out;
}

/**
 * Parse the "Otevřené pozice" table of a T212 activity statement = that account's exact
 * holdings at the end of the statement period, with the broker's own average cost:
 *   INSTRUMENT | ISIN | MĚNA | MNOŽSTVÍ | PRŮMĚRNÁ CENA | CENA | NÁVRATNOST | HODNOTA | …
 * This is the offline equivalent of the API's /equity/portfolio, and it's what makes a
 * statement self-sufficient: replaying trades alone misses free shares, dividend
 * reinvestments and pre-period lots, so the shares drift from what the broker shows.
 */
export function parseT212Holdings(text: string): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const account = parseT212Account(text) ?? undefined;
  const seen = new Set<string>();
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, " ").trim();
    if (/^Otevřené pozice/i.test(l)) { inSection = true; continue; }
    if (!inSection) continue;
    // The table ends only at the NEXT SECTION — not at a page break. A long holdings table
    // spans pages, and each page repeats the "ZÁKAZNICKÉ ID / name / INSTRUMENT" banner;
    // treating that as the end truncated the snapshot (22 of 38 positions read).
    if (/^(Účet |Uzavřené pozice|Čekající příkazy|Transakce)/i.test(l)) { inSection = false; continue; }
    if (/^INSTRUMENT/i.test(l)) continue;
    const m = /^(\S+)\s+([A-Z0-9]{12})\s+([A-Z]{3})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\b/.exec(l);
    if (!m) continue;
    const ticker = m[1].toUpperCase();
    const shares = parseFloat(m[4]);
    if (!(shares > 0) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({
      external_id: `t212:pos:${account ?? "x"}:${ticker}`, broker: "T212", account, kind: "HOLDING",
      ticker, isin: m[2], ccy: m[3], shares, avg_price_ccy: parseFloat(m[5]), price_ccy: parseFloat(m[6]),
      executed_at: new Date().toISOString(),
      label: `${ticker}: ${shares} ks @ ${m[5]} ${m[3]}`,
    });
  }
  return out;
}

/**
 * XTB has no open-positions export. Current open shares are derived authoritatively as:
 *   open = sum(Stock purchase shares)  −  sum(Closed Positions volume)
 * The "Closed Positions" sheet definitively lists what has been disposed (incl. closes
 * that aren't plain "Stock sell" rows, e.g. splits/corporate actions), so this avoids
 * leftover ghosts like a closed LRCX. avg cost = weighted average of purchase prices.
 * @param cashRows  "Cash Operations" sheet (array-of-arrays, header:1)
 * @param closedRows "Closed Positions" sheet (array-of-arrays, header:1)
 */
export function parseXtbHoldings(cashRows: any[][], closedRows: any[][] = []): NormalizedRow[] {
  // Purchases from Cash Operations (shares + cost from the comment).
  const bought: Record<string, { shares: number; cost: number }> = {};
  for (const r of parseXtbRows(cashRows)) {
    if (r.kind !== "TRADE" || r.side !== "BUY") continue;
    const b = (bought[r.ticker!] = bought[r.ticker!] || { shares: 0, cost: 0 });
    b.shares += r.shares!;
    b.cost += r.shares! * r.price_usd!;
  }
  // Closed volume per ticker (sheet: header row has "Instrument"; Ticker col 2, Volume col 4).
  const closed: Record<string, number> = {};
  const hdr = closedRows.findIndex((r) => String(r?.[0]).trim() === "Instrument");
  if (hdr >= 0) {
    for (const r of closedRows.slice(hdr + 1)) {
      const ticker = stripSuffix(String(r?.[2] ?? ""));
      const vol = Number(r?.[4]);
      if (ticker && Number.isFinite(vol)) closed[ticker] = (closed[ticker] || 0) + vol;
    }
  }

  const out: NormalizedRow[] = [];
  for (const [ticker, b] of Object.entries(bought)) {
    const open = b.shares - (closed[ticker] || 0);
    if (open <= 1e-6) continue; // fully closed -> not held
    const avg = b.cost / b.shares; // avg purchase price
    out.push({ external_id: `xtb:pos:${ticker}`, broker: "XTB", account: parseXtbAccount(cashRows), kind: "HOLDING", ticker,
      shares: open, price_usd: avg, executed_at: new Date().toISOString(),
      label: `${ticker}: ${open} ks @ $${avg.toFixed(2)}` });
  }
  return out;
}

/**
 * XTB as individual dated trades (so every buy/sell is tracked with its real date):
 *   BUYs  = each "Stock purchase" in Cash Operations (date from Time, price from comment)
 *   SELLs = each lot in "Closed Positions" (date from Close Time, price from Close Price)
 * Using Closed Positions for sells captures disposals that aren't plain "Stock sell" rows
 * (splits/corporate closes), so net shares end up correct. ext_id keeps it idempotent.
 */
export function parseXtbTrades(cashRows: any[][], closedRows: any[][] = []): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const account = parseXtbAccount(cashRows);
  // From Cash Operations take BUYs + deposits/withdrawals + dividends. SELLs come from the
  // "Closed Positions" sheet because it captures EVERY disposal — including ones that have
  // NO "Stock sell" row (corporate actions / a split closing a position, e.g. LRCX after a
  // 10:1 split). Relying on Cash "Stock sell" rows alone leaves such positions as ghosts.
  const cashSells: NormalizedRow[] = [];
  for (const r of parseXtbRows(cashRows)) {
    if (r.kind === "TRADE" && r.side === "BUY") {
      out.push({ ...r, external_id: `xtb:ord:${r.external_id}`, label: `BUY ${r.shares} × ${r.ticker} @ $${r.price_usd}` });
    } else if (r.kind === "TRADE" && r.side === "SELL") {
      cashSells.push(r);
    } else if (r.kind === "DEPOSIT" || r.kind === "WITHDRAWAL" || r.kind === "DIVIDEND") {
      out.push({ ...r, external_id: `xtb:${r.kind.toLowerCase()}:${r.external_id}` });
    }
  }
  const hdr = closedRows.findIndex((r) => String(r?.[0]).trim() === "Instrument");
  if (hdr >= 0) {
    const cols = closedRows[hdr].map((c: any) => String(c).trim());
    const idx = (name: string) => cols.indexOf(name);
    const ci = { ticker: idx("Ticker"), vol: idx("Volume"), price: idx("Close Price"), time: idx("Close Time (UTC)"), pid: idx("Position ID") };
    for (const r of closedRows.slice(hdr + 1)) {
      const ticker = stripSuffix(String(r?.[ci.ticker] ?? ""));
      const shares = Number(r?.[ci.vol]);
      const price = Number(r?.[ci.price]);
      const t = Number(r?.[ci.time]);
      if (!ticker || !(shares > 0)) continue;
      const pid = String(r?.[ci.pid] ?? `${ticker}-${shares}`);
      out.push({
        external_id: `xtb:close:${pid}-${shares}`, broker: "XTB", account, kind: "TRADE", ticker, side: "SELL",
        shares, price_usd: Number.isFinite(price) ? price : 0, fee_usd: 0,
        executed_at: Number.isFinite(t) ? excelDateToISO(t) : new Date().toISOString(),
        label: `SELL ${shares} × ${ticker} @ $${price}`,
      });
    }
  } else {
    // No "Closed Positions" sheet → fall back to the Cash Operations "Stock sell" rows.
    for (const r of cashSells) out.push({ ...r, external_id: `xtb:ord:${r.external_id}`, label: `SELL ${r.shares} × ${r.ticker} @ $${r.price_usd}` });
  }
  return out;
}

/**
 * Parse XTB "Cash Operations" sheet (array-of-arrays from xlsx sheet_to_json header:1).
 * Header is located dynamically (the row whose first cell is "Type").
 */
export function parseXtbAccount(rows: any[][]): string | undefined {
  for (const r of rows.slice(0, 10)) {
    if (/account number/i.test(String(r?.[0] ?? ""))) {
      const v = String(r?.[1] ?? "").trim();
      if (v) return v;
    }
  }
  return undefined;
}

export function parseXtbRows(rows: any[][]): NormalizedRow[] {
  const headerIdx = rows.findIndex((r) => String(r?.[0]).trim() === "Type");
  if (headerIdx < 0) return [];
  const account = parseXtbAccount(rows);
  const out: NormalizedRow[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const type = String(r?.[0] ?? "").trim();
    if (!type || type === "Total") continue;
    const rawTicker = String(r?.[1] ?? "");
    const ticker = rawTicker ? stripSuffix(rawTicker) : undefined;
    const serial = Number(r?.[3]);
    const amount = Number(r?.[4]);
    const id = String(r?.[5] ?? "");
    const comment = String(r?.[6] ?? "");
    const executed_at = Number.isFinite(serial) ? excelDateToISO(serial) : new Date().toISOString();
    const base = { external_id: id, broker: "XTB" as const, account, executed_at };

    switch (type) {
      case "Stock purchase":
      case "Stock sell": {
        const t = parseXtbTradeComment(comment);
        if (!t) { out.push({ ...base, kind: "SKIP", label: `XTB ${type} (neparsovatelný komentář)` }); break; }
        const side: Side = type === "Stock purchase" ? "BUY" : "SELL";
        out.push({ ...base, kind: "TRADE", ticker, side, shares: t.shares, price_usd: t.price, fee_usd: 0,
          label: `${side} ${t.shares} × ${ticker} @ $${t.price}` });
        break;
      }
      case "Deposit":
        out.push({ ...base, kind: "DEPOSIT", amount_usd: Math.abs(amount), label: `Vklad $${Math.abs(amount)}` });
        break;
      case "Dividend":
        out.push({ ...base, kind: "DIVIDEND", ticker, amount_usd: amount, label: `Dividenda ${ticker} $${amount}` });
        break;
      case "Fractional shares": {
        const ratio = parseXtbSplitComment(comment);
        out.push({ ...base, kind: ratio ? "SPLIT" : "SKIP", ticker, ratio: ratio ?? undefined,
          label: ratio ? `Split ${ticker} ${ratio}:1` : `XTB ${type}` });
        break;
      }
      case "Withholding tax":
      case "Free funds interest":
      case "Free funds interest tax":
      case "SEC fee":
      case "Commission":
        out.push({ ...base, kind: "FEE", ticker, amount_usd: amount, label: `${type} ${ticker ?? ""} $${amount}`.trim() });
        break;
      default:
        // Catch deposit/withdrawal rows whose label isn't exactly "Deposit" (XTB has used
        // "Cash deposit", "Bank transfer", etc.) so external cash flows are never dropped.
        if (/deposit|top-?up|wpłata|vklad|transfer in/i.test(type) && amount > 0)
          out.push({ ...base, kind: "DEPOSIT", amount_usd: Math.abs(amount), label: `Vklad $${Math.abs(amount)}` });
        else if (/withdrawal|payout|výběr|transfer out/i.test(type) && amount < 0)
          out.push({ ...base, kind: "WITHDRAWAL", amount_usd: amount, label: `Výběr $${Math.abs(amount)}` });
        else
          out.push({ ...base, kind: "SKIP", ticker, label: `${type} (přeskočeno)` });
    }
  }
  return out;
}
