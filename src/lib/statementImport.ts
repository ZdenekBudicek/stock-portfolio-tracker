// Client-side statement import. The raw file is parsed in the browser and never uploaded.
// Revolut -> current-holdings snapshot (authoritative, from "Portfolio breakdown").
// XTB -> trade replay (Cash Operations) reconciled against existing transactions.
import type * as XLSX from "xlsx";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/hooks/usePortfolio";
import { makeRateLookup, datedUsd, datedCzkPer } from "@/lib/fxLookup";
import { parseXtbTrades, parseXtbHoldings, parseXtbCurrency, parseRevolutText, parseRevolutHoldings, parseT212Activity, parseT212Holdings, type NormalizedRow } from "@/lib/statements";

// USD/CZK history (shared price_history) for converting T212's CZK amounts to USD per date.
// The series holds ~5 000 days since 2007: read it ALL. A single select is capped at 1 000
// rows, which stopped at August 2011 and converted every later CZK amount at 17.18 Kč/$ —
// GBP/EUR trades came out ~30 % too expensive.
async function usdCzkAt(): Promise<(date: string) => number> {
  const rows = await fetchAllRows<{ date: string; close: number }>((from, to) =>
    supabase.from("price_history").select("date,close").eq("symbol", "USDCZK").order("date", { ascending: true }).range(from, to),
  );
  const lookup = makeRateLookup(rows);
  return (date) => Number.isFinite(lookup(date)) ? lookup(date) : datedCzkPer("USD", date);
}

/**
 * USD per-share price of a T212 statement trade. USD instruments: the statement's own price.
 * Others: the CZK settlement converted at the day's rate — or, when the row was settled in
 * USD (no CZK amount at all), the USD total itself. Without that last case an EUR/GBP
 * instrument settled in USD fell through to `(undefined ?? 0)` and a real buy was stored at $0.
 * Missing dated conversion returns NaN and requires review.
 */
export function t212PriceUsd(r: NormalizedRow, czkPerUsd: number): number {
  if (r.ccy === "USD" && r.price_ccy) return r.price_ccy;
  if (!r.shares) return NaN;
  if (r.czk != null && czkPerUsd > 0) return ((r.czk + (r.side === "SELL" ? 1 : -1) * (r.fee_currency === "CZK" ? r.fee_amount ?? 0 : 0)) / czkPerUsd) / r.shares;
  if (r.usd_total != null) return (r.usd_total + (r.side === "SELL" ? 1 : -1) * (r.fee_currency === "USD" ? r.fee_amount ?? 0 : 0)) / r.shares;
  return datedUsd(r.price_ccy ?? NaN, r.ccy, r.executed_at.slice(0, 10));
}

// Convert T212 rows (CZK) to USD: trade price_usd and deposit/withdrawal amount_usd.
export async function convertT212(rows: NormalizedRow[]): Promise<NormalizedRow[]> {
  const fx = await usdCzkAt();
  return rows.map((r) => {
    const rate = fx(r.executed_at.slice(0, 10));
    const review = (): NormalizedRow => ({ ...r, kind: "SKIP", needs_review: true, label: r.label + ": chyb\u00ed datovan\u00fd kurz, nutn\u00e1 kontrola" });
    if (r.kind === "TRADE") {
      // USD execution prices are authoritative; other settlements use dated FX.
      const price = t212PriceUsd(r, rate);
      const fee = !r.fee_amount ? 0 : r.fee_currency === "CZK" ? r.fee_amount / rate : datedUsd(r.fee_amount, r.fee_currency, r.executed_at.slice(0, 10));
      return Number.isFinite(price) && Number.isFinite(fee) ? { ...r, price_usd: price, fee_usd: fee } : review();
    }
    return Number.isFinite(rate) ? { ...r, amount_usd: (r.czk ?? 0) / rate, original_amount: r.czk, original_currency: "CZK" } : review();
  });
}
import { matchManual, type MatchableTx } from "../../supabase/functions/_shared/t212";
import { apiFillsReplacedBefore, apiFillsReplacedFrom, createDuplicateGuard, planHoldingsSnapshot, replacedByStatement, type StoredHolding } from "@/lib/statementDedup";

export type DetectedBroker = "XTB" | "Revolut" | "T212" | "unknown";
export type ImportMode = "holdings" | "trades";

export interface ParsedStatement {
  broker: DetectedBroker;
  /** Which account at that broker the file belongs to (T212 Invest no., Revolut/XTB acct no.). */
  account?: string;
  mode: ImportMode;
  rows: NormalizedRow[];
  /**
   * The statement's own end-of-period holdings ("Otevřené pozice" / "Portfolio breakdown" /
   * XTB open lots). Trade replay alone drifts from the broker — free shares, dividend
   * reinvestment and pre-period lots never appear as trades — so the snapshot is what makes
   * the share count exact. Applied ONLY to this broker+account.
   */
  holdings: NormalizedRow[];
}

export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

async function readXtb(file: File): Promise<Omit<ParsedStatement, "broker" | "mode">> {
  if (file.size > MAX_STATEMENT_BYTES) throw new Error("V\u00fdpis je p\u0159\u00edli\u0161 velk\u00fd (maximum 10 MiB).");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_STATEMENT_BYTES) throw new Error("V\u00fdpis je p\u0159\u00edli\u0161 velk\u00fd (maximum 10 MiB).");
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array", dense: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, bookDeps: false, sheetRows: 50001 });
  for (const sheet of Object.values(wb.Sheets)) if (sheet["!fullref"]) throw new Error("V\u00fdpis p\u0159ekra\u010duje limit 50000 \u0159\u00e1dk\u016f; rozd\u011blte obdob\u00ed.");
  const cash = wb.Sheets["Cash Operations"] ?? wb.Sheets[wb.SheetNames[0]];
  const closed = wb.Sheets["Closed Positions"];
  const toRows = (s: XLSX.WorkSheet) => (s ? XLSX.utils.sheet_to_json<unknown[]>(s, { header: 1, blankrows: false }) : []);
  const currencies = [...new Set(wb.SheetNames.map((name) => parseXtbCurrency(toRows(wb.Sheets[name]))).filter(Boolean))];
  if (currencies.length > 1) throw new Error("XTB: conflicting account currencies; review the statement.");
  const cashRows = [...(currencies.length ? [["Account currency", currencies[0]]] : []), ...toRows(cash)], closedRows = toRows(closed);
  const rows = parseXtbTrades(cashRows, closedRows);
  return { account: rows[0]?.account, rows, holdings: parseXtbHoldings(cashRows, closedRows) };
}

async function readRevolutText(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const byY = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = Math.round(item.transform[5]);
      (byY.get(y) ?? byY.set(y, []).get(y)!).push({ x: item.transform[4], s: item.str });
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      lines.push(byY.get(y)!.sort((a, b) => a.x - b.x).map((t) => t.s).join(" "));
    }
  }
  return lines.join("\n");
}

export async function parseStatementFile(file: File): Promise<ParsedStatement> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return { broker: "XTB", mode: "trades", ...(await readXtb(file)) };
  }
  if (name.endsWith(".pdf")) {
    const text = await readRevolutText(file);
    // Detection is by CONTENT, never by file name: Revolut names its Czech export
    // "trading-account-statement_…_cs-cz.pdf", which reads like a Trading 212 file.
    // Trading 212 "Výpis aktivit" = the authoritative full history (trades + deposits +
    // the "Otevřené pozice" snapshot).
    if (/Trading 212|Výpis aktivit|uskutečněné obchody/i.test(text)) {
      const rows = await convertT212(parseT212Activity(text));
      const holdings = parseT212Holdings(text);
      return { broker: "T212", account: rows[0]?.account ?? holdings[0]?.account, mode: "trades", rows, holdings };
    }
    // Revolut: an account statement lists transactions (trades + cash) AND a "Portfolio
    // breakdown" = exact current holdings. Both are used: the trades carry real cost basis
    // and dates, the breakdown fixes the share count when older statements are missing.
    const revTrades = parseRevolutText(text);
    const revHoldings = parseRevolutHoldings(text);
    const account = revTrades[0]?.account ?? revHoldings[0]?.account;
    if (revTrades.some((r) => r.kind === "TRADE")) return { broker: "Revolut", account, mode: "trades", rows: revTrades, holdings: revHoldings };
    if (revHoldings.length) return { broker: "Revolut", account, mode: "holdings", rows: revHoldings, holdings: revHoldings };
    return { broker: "Revolut", account, mode: "trades", rows: revTrades, holdings: [] }; // deposits-only statement
  }
  return { broker: "unknown", mode: "trades", rows: [], holdings: [] };
}

export interface ImportPlan {
  warnings?: string[];
  /** Every traded instrument's ISIN in the statement (already stored trades included), for the shared ticker_alias. */
  isinByTicker?: Record<string, string>;
  broker: string;
  account?: string;
  mode: ImportMode;
  // holdings mode
  holdings: NormalizedRow[];
  holdingsRemove: { id: string; label: string }[];
  // trades mode
  toInsertTrades: NormalizedRow[];
  toCorrectTrades: { row: NormalizedRow; matchId: string }[];
  deposits: NormalizedRow[];
  withdrawals: NormalizedRow[];
  dividends: NormalizedRow[];
  fees: NormalizedRow[];
  splits: NormalizedRow[];
  alreadyImported: number;
  /** End-of-period snapshot to align this account to after inserting the trades. */
  reconcileTo: NormalizedRow[];
  /** Set when the file belongs to a different account of a broker already in the portfolio. */
  otherAccounts: string[];
  /** Rows of this broker that predate per-account scoping and carry no account yet. */
  legacyUnassigned: number;
  /** Claim those rows for this account (safe only when the broker has one account here). */
  adoptLegacy: boolean;
  /** Reconciliation skipped because unclaimed rows make the account scope incomplete. */
  blockedReconcile: boolean;
  /** T212: this account's API fills dated before this instant are replaced by the statement. */
  replaceApiFillsBefore: string | null;
  /** T212: …and dated at or after this instant (the statement's first day). */
  replaceApiFillsFrom: string | null;
}

const emptyPlan = (broker: string, mode: ImportMode, account?: string): ImportPlan => ({
  broker, account, mode, holdings: [], holdingsRemove: [], toInsertTrades: [], toCorrectTrades: [],
  deposits: [], withdrawals: [], dividends: [], fees: [], splits: [], alreadyImported: 0,
  reconcileTo: [], otherAccounts: [], legacyUnassigned: 0, adoptLegacy: false, blockedReconcile: false,
  replaceApiFillsBefore: null, replaceApiFillsFrom: null,
});

export async function planImport(parsed: ParsedStatement): Promise<ImportPlan> {
  const plan = emptyPlan(parsed.broker, parsed.mode, parsed.account);
  plan.warnings = parsed.rows.filter((r) => r.needs_review).map((r) => r.label);
  plan.isinByTicker = Object.fromEntries(parsed.rows.filter((r) => r.kind === "TRADE" && r.ticker && r.isin && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(r.isin))
    .map((r) => [r.ticker!, r.isin!]));
  if (plan.warnings.length && parsed.broker === "T212") throw new Error(plan.warnings.join("\n"));

  if (parsed.mode === "holdings") {
    plan.holdings = parsed.rows.filter((r) => r.kind === "HOLDING");
    // Scoped to the statement's own account (see planHoldingsSnapshot): another account's
    // snapshot rows are neither overwritten nor removed.
    const { data, error: readError } = await supabase.from("transactions").select("id,ticker,ext_id,broker,broker_account").eq("broker", parsed.broker).like("ext_id", `${parsed.broker.toLowerCase()}:pos:%`);
    if (readError) throw readError;
    plan.holdingsRemove = planHoldingsSnapshot((data ?? []) as StoredHolding[], plan.holdings, parsed.broker, parsed.account).remove;
    return plan;
  }

  // trades mode
  // PAGED: PostgREST caps a plain select at 1000 rows. A single statement import can put
  // ~2000 trades in the table, so an unpaged read silently returned a PARTIAL history —
  // and every row it missed looked like a brand-new trade to the de-duplication below.
  const existing = await fetchAllRows((from, to) =>
    supabase.from("transactions").select("id,ticker,side,shares,executed_at,broker,broker_account,t212_id,ext_id").range(from, to),
  ).then((rows) => rows.map((t) => ({ id: t.id, ticker: t.ticker, side: t.side, shares: Number(t.shares), executed_at: t.executed_at, broker: t.broker ?? "manual", broker_account: t.broker_account ?? null, t212_id: t.t212_id, ext_id: t.ext_id })));

  // Other accounts already present at this broker. Shown in the review step so importing
  // the wrong household member's / second account's statement is caught before it lands.
  const mine = existing.filter((t) => t.broker === parsed.broker);
  plan.otherAccounts = [...new Set(mine
    .filter((t) => t.broker_account && t.broker_account !== parsed.account)
    .map((t) => t.broker_account as string))];

  // Rows of this broker written before per-account scoping existed carry NO account.
  // They are invisible to an account-scoped reconcile, which then believes the account
  // holds nothing and "corrects" it by buying the ENTIRE snapshot on top of the shares
  // already there — the position doubles. So they must be claimed first, and that is only
  // safe when this broker has exactly one account in the data.
  plan.legacyUnassigned = mine.filter((t) => !t.broker_account).length;
  plan.adoptLegacy = !!parsed.account && plan.legacyUnassigned > 0 && plan.otherAccounts.length === 0;

  // The RPC atomically replaces this account's API fills inside the statement period.
  // Deduplication reasons about the rows that survive that replacement.
  plan.replaceApiFillsBefore = parsed.broker === "T212" ? apiFillsReplacedBefore(parsed.rows) : null;
  plan.replaceApiFillsFrom = parsed.broker === "T212" ? apiFillsReplacedFrom(parsed.rows) : null;
  const scope = { broker: parsed.broker, account: parsed.account, adoptLegacy: plan.adoptLegacy, replaceApiFillsBefore: plan.replaceApiFillsBefore, replaceApiFillsFrom: plan.replaceApiFillsFrom };
  const remaining = existing.filter((t) => !replacedByStatement(t, scope));

  // The end-of-period snapshot is only the truth if this statement is the NEWEST data we
  // have for the account — importing an old statement afterwards must not roll positions
  // back. Compared as timestamps, not strings: the DB returns "…+00:00" while the parsers
  // emit "…Z", and those two formats do not sort correctly against each other as text.
  const ms = (s: string) => new Date(s).getTime() || 0;
  const statementEnd = parsed.rows.reduce((m, r) => Math.max(m, ms(r.executed_at)), 0);
  const newestHere = remaining
    .filter((t) => t.broker === parsed.broker)
    .filter((t) => (t.broker_account === parsed.account || (plan.adoptLegacy && !t.broker_account)) && !String(t.ext_id ?? "").includes(":adj:"))
    .reduce((m, t) => Math.max(m, ms(t.executed_at)), 0);
  // Never reconcile while unclaimed rows remain: the scope would not cover the shares the
  // portfolio already counts. Better to import the trades and say so than to inflate.
  const scopeIsComplete = plan.legacyUnassigned === 0 || plan.adoptLegacy || !parsed.account;
  if (parsed.holdings.length && statementEnd >= newestHere && scopeIsComplete) plan.reconcileTo = parsed.holdings;
  else if (parsed.holdings.length && !scopeIsComplete) plan.blockedReconcile = true;
  const { data: divData, error: divDataError } = await supabase.from("dividends").select("ext_id,broker");
  if (divDataError) throw divDataError;
  const { data: depData, error: depDataError } = await supabase.from("deposits").select("ext_id");
  if (depDataError) throw depDataError;

  // Duplicate guard over the rows that remain after the import's own deletion (see
  // statementDedup.ts for why it is content-based and counted by multiplicity).
  const guard = createDuplicateGuard(existing, scope, parsed.rows);
  const divExt = new Set((divData ?? []).filter((d) => d.ext_id).map((d) => `${d.broker}:${d.ext_id}`));
  const depExt = new Set((depData ?? []).filter((d) => d.ext_id).map((d) => d.ext_id));
  const adoptable: MatchableTx[] = existing.filter((t) => t.broker === "manual" && !t.t212_id && !t.ext_id);

  for (const r of parsed.rows) {
    const extKey = `${r.broker}:${r.external_id}`;
    if (r.kind === "TRADE") {
      if (guard.tradeAlreadyStored(r)) { plan.alreadyImported++; continue; }
      const match = matchManual({ ticker: r.ticker!, side: r.side!, shares: r.shares!, executed_at: r.executed_at }, adoptable);
      if (match) { plan.toCorrectTrades.push({ row: r, matchId: match.id }); adoptable.splice(adoptable.indexOf(match), 1); }
      else plan.toInsertTrades.push(r);
    } else if (r.kind === "DEPOSIT") { if (depExt.has(r.external_id)) plan.alreadyImported++; else plan.deposits.push(r); }
    else if (r.kind === "WITHDRAWAL") { if (depExt.has(r.external_id)) plan.alreadyImported++; else plan.withdrawals.push(r); }
    else if (r.kind === "DIVIDEND") { if (divExt.has(extKey) && r.withholding_tax_usd == null) plan.alreadyImported++; else plan.dividends.push(r); }
    else if (r.kind === "FEE") { if (guard.hasExtId(r)) plan.alreadyImported++; else plan.fees.push(r); }
    else if (r.kind === "SPLIT") plan.splits.push(r);
  }
  if (plan.warnings.length) { plan.reconcileTo = []; plan.blockedReconcile = true; }
  return plan;
}

export interface ImportSummary {
  holdings: number; removed: number; corrected: number; inserted: number; deposits: number;
  withdrawals: number; dividends: number; fees: number; splitsDetected: number; reconciled: number;
  /** Rows the database already held (re-import) — expected, not an error. */
  alreadyStored: number;
  /** Rows that could NOT be written, with the reason. Never fail silently on money. */
  failed: number;
  error?: string;
}

export async function executeImport(plan: ImportPlan): Promise<ImportSummary> {
  const s: ImportSummary = { holdings: 0, removed: 0, corrected: 0, inserted: 0, deposits: 0, withdrawals: 0, dividends: 0, fees: 0, splitsDetected: plan.splits.length, reconciled: 0, alreadyStored: 0, failed: 0 };

  if (plan.mode === "holdings") {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) throw new Error("Authentication required");
    const { data: existing, error: existingError } = await supabase.from("transactions").select("id,ticker,ext_id,broker_account").eq("broker", plan.broker).like("ext_id", `${plan.broker.toLowerCase()}:pos:%`);
    if (existingError) throw existingError;
    // Same account scope as planImport. A matched legacy row ("revolut:pos:TICKER") is
    // updated in place and moves to the account-qualified id — never a second copy.
    const { matchId } = planHoldingsSnapshot((existing ?? []) as StoredHolding[], plan.holdings, plan.broker, plan.account);
    for (const h of plan.holdings) {
      const row = { ticker: h.ticker, side: "BUY", shares: h.shares, price_usd: h.price_usd, fee_usd: 0, executed_at: h.executed_at, broker: plan.broker, broker_account: h.account ?? plan.account ?? null, ext_id: h.external_id, note: `${plan.broker} holding (import)`, user_id: uid };
      const id = matchId.get(h.external_id);
      const { error } = id ? await supabase.from("transactions").update(row).eq("id", id) : await supabase.from("transactions").insert(row);
      if (error) throw error;
      s.holdings++;
    }
    if (plan.holdingsRemove.length) {
      const { error } = await supabase.from("transactions").delete().in("id", plan.holdingsRemove.map((d) => d.id));
      if (error) throw error;
      s.removed = plan.holdingsRemove.length;
    }
    return s;
  }

  // trades mode
  const { data: u0 } = await supabase.auth.getUser();
  const uid0 = u0.user?.id;
  if (!uid0) throw new Error("Authentication required");
  // T212 activity statement is the authoritative full history -> replace the incomplete
  // API-imported order fills so there's no double-count. We do NOT touch deposits here:
  // each statement covers only its own date range, so deleting all T212 deposits would wipe
  // the other statements' — importing 2022, 2023, 2025 in turn used to leave only the last.
  // Deposits are inserted idempotently below, so statements ACCUMULATE across imports.
  // Claim this broker's pre-scoping rows for the statement's account BEFORE anything else.
  // Until they carry the account, an account-scoped reconcile cannot see them, concludes the
  // account is empty and re-buys the whole snapshot on top — which is exactly how a second
  // import of the same Revolut statement doubled every position.
  if (plan.adoptLegacy && plan.account) {
    for (const table of ["transactions", "deposits", "dividends"] as const) {
      if (table === "transactions" && plan.broker === "T212" && plan.replaceApiFillsBefore) continue;
      const { error } = await supabase.from(table).update({ broker_account: plan.account })
        .eq("user_id", uid0).eq("broker", plan.broker).is("broker_account", null);
      if (error) throw error;
    }
  }

  const tradeRows = plan.toInsertTrades.map((r) => ({ ticker: r.ticker, side: r.side, shares: r.shares, price_usd: r.price_usd, fee_usd: r.fee_usd ?? 0, executed_at: r.executed_at, broker: r.broker, broker_account: r.account ?? plan.account ?? null, ext_id: r.external_id, user_id: uid0, note: r.price_ccy == null ? null : "Original execution: " + r.price_ccy + " " + r.ccy + (r.original_amount == null ? "" : "; settlement: " + r.original_amount + " " + r.original_currency) }));
  const replacing = plan.broker === "T212" && !!plan.replaceApiFillsBefore;
  if (replacing) {
    const { data, error } = await supabase.rpc("replace_statement_trades", {
      p_account: plan.account ?? null, p_from: plan.replaceApiFillsFrom, p_before: plan.replaceApiFillsBefore,
      p_rows: tradeRows, p_adopt: plan.adoptLegacy,
      p_corrections: plan.toCorrectTrades.map(({ row: r, matchId }) => ({ match_id: matchId, ticker: r.ticker, side: r.side, shares: r.shares, price_usd: r.price_usd, fee_usd: r.fee_usd ?? 0, executed_at: r.executed_at, ext_id: r.external_id })),
    });
    if (error) throw error;
    s.inserted = data.inserted; s.corrected = data.corrected;
    s.alreadyStored = tradeRows.length - s.inserted;
  } else {
    for (const { row, matchId } of plan.toCorrectTrades) {
      const { error } = await supabase.from("transactions").update({ ticker: row.ticker, side: row.side, shares: row.shares, price_usd: row.price_usd, fee_usd: row.fee_usd ?? 0, executed_at: row.executed_at, broker: row.broker, broker_account: row.account ?? plan.account ?? null, ext_id: row.external_id }).eq("id", matchId);
      if (error) throw error;
      s.corrected++;
    }

    for (let i = 0; i < tradeRows.length; i += 500) {
      const chunk = tradeRows.slice(i, i + 500);
      const { data, error } = await supabase.from("transactions")
        .upsert(chunk, { onConflict: "user_id,broker,ext_id", ignoreDuplicates: true })
        .select("id");
      // A silently swallowed batch used to look like "0 přidáno" with no explanation.
      if (error) throw error;
      else { s.inserted += data?.length ?? 0; s.alreadyStored += chunk.length - (data?.length ?? 0); }
    }
  }
  // Merger cash was once imported as a DEPOSIT; it is sale proceeds now — a 0-share SELL
  // under the same ext_id. Once that row is in, drop the old deposit so "Vloženo" stops
  // counting the payout as money paid in. Only when every batch landed: never lose the cash.
  const mergerCash = plan.toInsertTrades.filter((r) => r.external_id.includes(":mergercash:")).map((r) => r.external_id);
  if (mergerCash.length && !s.failed) {
    const { error } = await supabase.from("deposits").delete().eq("user_id", uid0).eq("broker", plan.broker).in("ext_id", mergerCash);
    if (error) throw error;
  }
  // Record each ticker's ISIN (shared ticker_alias) so the price worker can resolve foreign
  // listings via OpenFIGI (e.g. BARC -> BARC.L, GBp -> USD) instead of leaving them unpriced.
  // From every traded instrument of the statement, so a re-import also seeds trades stored by an earlier run; in
  // batches of 500, the most the function accepts (it keeps only valid ISINs of tickers in the caller's ledger).
  const aliasSeed = Object.entries(plan.isinByTicker ?? {});
  // seed_ticker_aliases is not in the generated types (they predate it).
  const untyped = supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };
  for (let i = 0; i < aliasSeed.length; i += 500) {
    const { error } = await untyped.rpc("seed_ticker_aliases", { p_rows: aliasSeed.slice(i, i + 500).map(([alias, isin]) => ({ alias, isin })) });
    if (error) throw error;
  }
  // Deposits/withdrawals go to the dedicated deposits table (dated external cash flows),
  // NOT to CASH transactions — those would wrongly move the live cash balance, since the
  // matching buys are already imported. This feeds Roční zhodnocení + the chart baseline.
  const depUid = uid0;
  // Idempotent: skip deposits already present (by ext_id), so re-importing a statement — or
  // importing overlapping periods — never double-counts and never wipes prior ones.
  const { data: existDep, error: existDepError } = await supabase.from("deposits").select("ext_id").eq("user_id", depUid).not("ext_id", "is", null);
  if (existDepError) throw existDepError;
  const seenDep = new Set((existDep ?? []).map((d) => d.ext_id));
  // T212 cash-flow ids gained an account segment ("t212:dep:<account>:<date>:<amt>"). Rows
  // imported before that carry the un-qualified id — recognise both so a re-import after the
  // upgrade tops up instead of double-counting every historical deposit.
  const legacyId = (id: string) => id.replace(/^t212:(dep|wd):\d+:/, "t212:$1:");
  const depositRow = async (r: NormalizedRow, sign: 1 | -1) => {
    if (r.external_id && (seenDep.has(r.external_id) || seenDep.has(legacyId(r.external_id)))) return false;
    const { error } = await supabase.from("deposits").insert({
      user_id: depUid, broker: r.broker, broker_account: r.account ?? plan.account ?? null,
      flow_date: r.executed_at.slice(0, 10), original_currency: r.original_currency, original_amount: r.original_amount == null ? null : sign * Math.abs(r.original_amount),
      amount_usd: sign * Math.abs(r.amount_usd ?? 0), source: "statement", ext_id: r.external_id,
    });
    if (error) throw error;
    if (r.external_id) seenDep.add(r.external_id);
    return !error;
  };
  for (const r of plan.deposits) if (await depositRow(r, 1)) s.deposits++;
  for (const r of plan.withdrawals) if (await depositRow(r, -1)) s.withdrawals++;
  // Fees: record as a small negative deposit (net capital effect), keeps balances clean.
  for (const r of plan.fees) { const a = r.amount_usd ?? 0; if (a !== 0 && await depositRow({ ...r, amount_usd: Math.abs(a) }, -1)) s.fees++; }
  // Idempotent dividends too (re-import / overlapping periods must not duplicate).
  const { data: existDiv, error: existDivError } = await supabase.from("dividends").select("ext_id").eq("user_id", depUid).not("ext_id", "is", null);
  if (existDivError) throw existDivError;
  const seenDiv = new Set((existDiv ?? []).map((d) => d.ext_id));
  for (const r of plan.dividends) {
    if (r.external_id && seenDiv.has(r.external_id)) {
      if (r.gross_amount_usd != null && r.withholding_tax_usd != null) {
        const { error } = await supabase.from("dividends").update({ total_amount_usd: r.amount_usd, amount_per_share: r.amount_usd, gross_amount_usd: r.gross_amount_usd, withholding_tax_usd: r.withholding_tax_usd,
          original_currency: r.original_currency, gross_amount: r.gross_amount, withholding_tax: r.withholding_tax })
          .eq("user_id", depUid).eq("broker", r.broker).eq("ext_id", r.external_id);
        if (error) throw error;
      }
      continue;
    }
    // A statement knows only the PAYMENT date; it goes into both columns (ex_date is NOT
    // NULL). The tax year is decided by the payment date, and the auto estimates of the same
    // dividend (which carry the real ex-date) are matched against it by a date window — see
    // dedupeDividends in src/lib/dividendTax.ts and sync-earnings.
    const { error } = await supabase.from("dividends").insert({ user_id: depUid, gross_amount_usd: r.gross_amount_usd, withholding_tax_usd: r.withholding_tax_usd, original_currency: r.original_currency, gross_amount: r.gross_amount, withholding_tax: r.withholding_tax, ticker: r.ticker, ex_date: r.executed_at.slice(0, 10), pay_date: r.executed_at.slice(0, 10), amount_per_share: r.amount_usd, shares_held: 1, total_amount_usd: r.amount_usd, status: "paid", broker: r.broker, broker_account: r.account ?? plan.account ?? null, ext_id: r.external_id });
    if (error) throw error;
    if (!error) { s.dividends++; if (r.external_id) seenDiv.add(r.external_id); }
  }

  // Align THIS broker account to the statement's end-of-period holdings. Replaying trades
  // alone drifts — free shares, dividend reinvestments and lots bought before the statement
  // period never appear as trades. The RPC only ever counts and writes rows of this exact
  // (broker, account) pair, so other brokers, other accounts and manual entries are
  // untouched and the blended average stays a plain sum of all of them.
  if (plan.reconcileTo.length) {
    const holdings = plan.reconcileTo
      .filter((h) => (h.shares ?? 0) > 0)
      .map((h) => ({
        ticker: h.ticker,
        qty: h.shares,
        // Cost only when it is genuinely USD: T212 quotes GBX/EUR instruments in their own
        // currency and there is no FX series for those here — a bogus cost is worse than none.
        avg: h.avg_price_ccy != null ? (h.ccy === "USD" ? h.avg_price_ccy : null) : (h.price_usd ?? null),
      }));
    s.reconciled = await supabase.rpc("reconcile_broker_account", {
      p_user_id: uid0, p_broker: plan.broker, p_account: plan.account ?? null,
      p_holdings: holdings, p_note: `Dorovnání podle výpisu ${plan.broker}${plan.account ? ` (${plan.account})` : ""}`,
    }).then(({ data, error }) => { if (error) throw error; return Number(data) || 0; });
  }
  return s;
}
