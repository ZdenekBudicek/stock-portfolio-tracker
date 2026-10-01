// Client-side statement import. The raw file is parsed in the browser and never uploaded.
// Revolut -> current-holdings snapshot (authoritative, from "Portfolio breakdown").
// XTB -> trade replay (Cash Operations) reconciled against existing transactions.
import * as XLSX from "xlsx";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/hooks/usePortfolio";
import { parseXtbTrades, parseXtbHoldings, parseRevolutText, parseRevolutHoldings, parseT212Activity, parseT212Holdings, type NormalizedRow } from "@/lib/statements";

// USD/CZK history (shared price_history) for converting T212's CZK amounts to USD per date.
async function usdCzkAt(): Promise<(date: string) => number> {
  const { data } = await supabase.from("price_history").select("date,close").eq("symbol", "USDCZK").order("date", { ascending: true });
  const rows = (data ?? []) as { date: string; close: number }[];
  if (!rows.length) return () => 22;
  return (date: string) => {
    let best = Number(rows[rows.length - 1].close);
    for (const r of rows) { if (r.date <= date) best = Number(r.close); else break; }
    return best || 22;
  };
}

// Convert T212 rows (CZK) to USD: trade price_usd and deposit/withdrawal amount_usd.
async function convertT212(rows: NormalizedRow[]): Promise<NormalizedRow[]> {
  const fx = await usdCzkAt();
  return rows.map((r) => {
    const rate = fx(r.executed_at.slice(0, 10)) || 22;
    if (r.kind === "TRADE") {
      // For USD instruments the statement's own per-share price is authoritative and
      // matches the broker's cost basis exactly. The CZK column is unreliable for
      // pie/auto-invest rows (sometimes already in USD), so never derive USD price from
      // it for USD trades. Non-USD instruments (GBX/EUR/GBP) have no FX series here, so
      // fall back to the CZK value converted to USD per share.
      const usd = r.ccy === "USD" && r.price_ccy
        ? r.price_ccy
        : (r.shares ? ((r.czk ?? 0) / rate) / r.shares : 0);
      return { ...r, price_usd: usd, fee_usd: 0 };
    }
    return { ...r, amount_usd: (r.czk ?? 0) / rate };
  });
}
import { matchManual, type MatchableTx } from "../../supabase/functions/_shared/t212";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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

async function readXtb(file: File): Promise<Omit<ParsedStatement, "broker" | "mode">> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const cash = wb.Sheets["Cash Operations"] ?? wb.Sheets[wb.SheetNames[0]];
  const closed = wb.Sheets["Closed Positions"];
  const toRows = (s: any) => (s ? XLSX.utils.sheet_to_json<any[]>(s, { header: 1, blankrows: false }) : []);
  const cashRows = toRows(cash), closedRows = toRows(closed);
  const rows = parseXtbTrades(cashRows, closedRows);
  return { account: rows[0]?.account, rows, holdings: parseXtbHoldings(cashRows, closedRows) };
}

async function readRevolutText(file: File): Promise<string> {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const byY = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as any[]) {
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
}

const emptyPlan = (broker: string, mode: ImportMode, account?: string): ImportPlan => ({
  broker, account, mode, holdings: [], holdingsRemove: [], toInsertTrades: [], toCorrectTrades: [],
  deposits: [], withdrawals: [], dividends: [], fees: [], splits: [], alreadyImported: 0,
  reconcileTo: [], otherAccounts: [], legacyUnassigned: 0, adoptLegacy: false, blockedReconcile: false,
});

export async function planImport(parsed: ParsedStatement): Promise<ImportPlan> {
  const plan = emptyPlan(parsed.broker, parsed.mode, parsed.account);

  if (parsed.mode === "holdings") {
    plan.holdings = parsed.rows.filter((r) => r.kind === "HOLDING");
    const { data } = await supabase.from("transactions").select("id,ticker,ext_id,broker").eq("broker", parsed.broker).like("ext_id", `${parsed.broker.toLowerCase()}:pos:%`);
    const keep = new Set(plan.holdings.map((h) => h.external_id));
    plan.holdingsRemove = (data ?? []).filter((t: any) => !keep.has(t.ext_id)).map((t: any) => ({ id: t.id, label: t.ticker }));
    return plan;
  }

  // trades mode
  // PAGED: PostgREST caps a plain select at 1000 rows. A single statement import can put
  // ~2000 trades in the table, so an unpaged read silently returned a PARTIAL history —
  // and every row it missed looked like a brand-new trade to the de-duplication below.
  const existing = await fetchAllRows<any>((from, to) =>
    supabase.from("transactions").select("id,ticker,side,shares,executed_at,broker,broker_account,t212_id,ext_id").range(from, to),
  ).then((rows) => rows.map((t: any) => ({ id: t.id, ticker: t.ticker, side: t.side, shares: Number(t.shares), executed_at: t.executed_at, broker: t.broker ?? "manual", broker_account: t.broker_account ?? null, t212_id: t.t212_id, ext_id: t.ext_id })));

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

  // The end-of-period snapshot is only the truth if this statement is the NEWEST data we
  // have for the account — importing an old statement afterwards must not roll positions
  // back. Compared as timestamps, not strings: the DB returns "…+00:00" while the parsers
  // emit "…Z", and those two formats do not sort correctly against each other as text.
  const ms = (s: string) => new Date(s).getTime() || 0;
  const statementEnd = parsed.rows.reduce((m, r) => Math.max(m, ms(r.executed_at)), 0);
  const newestHere = mine
    .filter((t) => (t.broker_account === parsed.account || (plan.adoptLegacy && !t.broker_account)) && !String(t.ext_id ?? "").includes(":adj:"))
    .reduce((m, t) => Math.max(m, ms(t.executed_at)), 0);
  // Never reconcile while unclaimed rows remain: the scope would not cover the shares the
  // portfolio already counts. Better to import the trades and say so than to inflate.
  const scopeIsComplete = plan.legacyUnassigned === 0 || plan.adoptLegacy || !parsed.account;
  if (parsed.holdings.length && statementEnd >= newestHere && scopeIsComplete) plan.reconcileTo = parsed.holdings;
  else if (parsed.holdings.length && !scopeIsComplete) plan.blockedReconcile = true;
  const { data: divData } = await supabase.from("dividends").select("ext_id,broker");
  const { data: depData } = await supabase.from("deposits").select("ext_id");
  const txExt = new Set(existing.filter((t) => t.ext_id).map((t) => `${t.broker}:${t.ext_id}`));

  // Content-based duplicate guard, independent of ext_id — the safety net that makes a
  // re-import idempotent even when the id scheme changes or the broker re-exports the same
  // fill under a different id. Revolut's PDF text extraction varies between exports, so an
  // id derived from that text let the SAME statement import twice: phantom buys and sells in
  // the ledger, hidden in `positions` by broker reconciliation, but drawn in full in the
  // history chart.
  //
  // Matched by MULTIPLICITY, not presence: if the file lists a trade twice and the database
  // holds it once, the second copy still lands. Only copies already stored are skipped.
  const contentKey = (ticker: string, side: string, shares: number, isoDate: string, account: string | null) =>
    `${account ?? ""}|${ticker}|${side}|${Number(shares).toFixed(6)}|${isoDate.slice(0, 10)}`;
  const stored = new Map<string, number>();
  for (const t of existing) {
    if (t.broker !== parsed.broker) continue;
    const ext = String(t.ext_id ?? "");
    if (ext.includes(":adj:") || ext.includes(":pos:")) continue; // corrections, not trades
    const acc = t.broker_account ?? (plan.adoptLegacy ? parsed.account ?? null : null);
    const k = contentKey(t.ticker, t.side, t.shares, t.executed_at, acc);
    stored.set(k, (stored.get(k) ?? 0) + 1);
  }
  /** Consume one stored copy of this trade; true when one was already there. */
  const consumeStored = (r: NormalizedRow) => {
    const k = contentKey(r.ticker!, r.side!, r.shares!, r.executed_at, r.account ?? parsed.account ?? null);
    const n = stored.get(k) ?? 0;
    if (n <= 0) return false;
    stored.set(k, n - 1);
    return true;
  };
  const divExt = new Set((divData ?? []).filter((d: any) => d.ext_id).map((d: any) => `${d.broker}:${d.ext_id}`));
  const depExt = new Set((depData ?? []).filter((d: any) => d.ext_id).map((d: any) => d.ext_id));
  const adoptable: MatchableTx[] = existing.filter((t) => t.broker === "manual" && !t.t212_id && !t.ext_id);

  for (const r of parsed.rows) {
    const extKey = `${r.broker}:${r.external_id}`;
    if (r.kind === "TRADE") {
      if (txExt.has(extKey)) { consumeStored(r); plan.alreadyImported++; continue; }
      if (consumeStored(r)) { plan.alreadyImported++; continue; }
      const match = matchManual({ ticker: r.ticker!, side: r.side!, shares: r.shares!, executed_at: r.executed_at }, adoptable);
      if (match) { plan.toCorrectTrades.push({ row: r, matchId: match.id }); adoptable.splice(adoptable.indexOf(match), 1); }
      else plan.toInsertTrades.push(r);
    } else if (r.kind === "DEPOSIT") depExt.has(r.external_id) ? plan.alreadyImported++ : plan.deposits.push(r);
    else if (r.kind === "WITHDRAWAL") depExt.has(r.external_id) ? plan.alreadyImported++ : plan.withdrawals.push(r);
    else if (r.kind === "DIVIDEND") divExt.has(extKey) ? plan.alreadyImported++ : plan.dividends.push(r);
    else if (r.kind === "FEE") txExt.has(extKey) ? plan.alreadyImported++ : plan.fees.push(r);
    else if (r.kind === "SPLIT") plan.splits.push(r);
  }
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
    const { data: existing } = await supabase.from("transactions").select("id,ext_id").eq("broker", plan.broker).like("ext_id", `${plan.broker.toLowerCase()}:pos:%`);
    const byExt = new Map((existing ?? []).map((t: any) => [t.ext_id, t.id]));
    for (const h of plan.holdings) {
      const row = { ticker: h.ticker, side: "BUY", shares: h.shares, price_usd: h.price_usd, fee_usd: 0, executed_at: h.executed_at, broker: plan.broker, broker_account: h.account ?? plan.account ?? null, ext_id: h.external_id, note: `${plan.broker} holding (import)`, user_id: uid };
      const id = byExt.get(h.external_id);
      const { error } = id ? await supabase.from("transactions").update(row).eq("id", id) : await supabase.from("transactions").insert(row);
      if (!error) s.holdings++;
    }
    if (plan.holdingsRemove.length) {
      const { error } = await supabase.from("transactions").delete().in("id", plan.holdingsRemove.map((d) => d.id));
      if (!error) s.removed = plan.holdingsRemove.length;
    }
    return s;
  }

  // trades mode
  const { data: u0 } = await supabase.auth.getUser();
  const uid0 = u0.user?.id;
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
      await supabase.from(table).update({ broker_account: plan.account })
        .eq("user_id", uid0).eq("broker", plan.broker).is("broker_account", null);
    }
  }

  // Scoped to the statement's own account — a second account at the same broker keeps its
  // API-imported fills.
  if (plan.broker === "T212") {
    let q = supabase.from("transactions").delete().eq("user_id", uid0).eq("broker", "T212").like("ext_id", "t212:ord:%");
    q = plan.account ? q.eq("broker_account", plan.account) : q.is("broker_account", null);
    await q;
  }
  for (const { row, matchId } of plan.toCorrectTrades) {
    const { error } = await supabase.from("transactions").update({ ticker: row.ticker, side: row.side, shares: row.shares, price_usd: row.price_usd, fee_usd: row.fee_usd ?? 0, executed_at: row.executed_at, broker: row.broker, broker_account: row.account ?? plan.account ?? null, ext_id: row.external_id }).eq("id", matchId);
    if (!error) s.corrected++;
  }
  // Batch insert (a full statement can be ~2000 trades — per-row would be far too slow).
  // UPSERT with ignoreDuplicates, not INSERT: the unique index on (user_id, broker, ext_id)
  // then makes a re-import a no-op at the DATABASE level, so a double-click or two
  // overlapping statements cannot double-count even if every guard above is bypassed.
  // `.select("id")` returns only the rows that were really inserted, so the count is honest.
  const tradeRows = plan.toInsertTrades.map((r) => ({ ticker: r.ticker, side: r.side, shares: r.shares, price_usd: r.price_usd, fee_usd: r.fee_usd ?? 0, executed_at: r.executed_at, broker: r.broker, broker_account: r.account ?? plan.account ?? null, ext_id: r.external_id, user_id: uid0 }));
  for (let i = 0; i < tradeRows.length; i += 500) {
    const chunk = tradeRows.slice(i, i + 500);
    const { data, error } = await supabase.from("transactions")
      .upsert(chunk, { onConflict: "user_id,broker,ext_id", ignoreDuplicates: true })
      .select("id");
    // A silently swallowed batch used to look like "0 přidáno" with no explanation.
    if (error) { s.failed += chunk.length; s.error = error.message; }
    else { s.inserted += data?.length ?? 0; s.alreadyStored += chunk.length - (data?.length ?? 0); }
  }
  // Record each ticker's ISIN (shared ticker_alias) so the price worker can resolve foreign
  // listings via OpenFIGI (e.g. BARC -> BARC.L, GBp -> USD) instead of leaving them unpriced.
  const aliasSeed = new Map<string, string>();
  for (const r of plan.toInsertTrades) {
    const isin = (r as any).isin as string | undefined;
    if (r.ticker && isin && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) aliasSeed.set(r.ticker, isin);
  }
  if (aliasSeed.size) {
    // seed_ticker_aliases is not defined in supabase/migrations/, so it is not in the generated types.
    const untyped = supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<unknown> };
    await untyped.rpc("seed_ticker_aliases", { p_rows: [...aliasSeed].map(([alias, isin]) => ({ alias, isin })) }).then(() => {}, () => {});
  }
  // Deposits/withdrawals go to the dedicated deposits table (dated external cash flows),
  // NOT to CASH transactions — those would wrongly move the live cash balance, since the
  // matching buys are already imported. This feeds Roční zhodnocení + the chart baseline.
  const { data: u2 } = await supabase.auth.getUser();
  const depUid = u2.user?.id;
  // Idempotent: skip deposits already present (by ext_id), so re-importing a statement — or
  // importing overlapping periods — never double-counts and never wipes prior ones.
  const { data: existDep } = await supabase.from("deposits").select("ext_id").eq("user_id", depUid).not("ext_id", "is", null);
  const seenDep = new Set((existDep ?? []).map((d: any) => d.ext_id));
  // T212 cash-flow ids gained an account segment ("t212:dep:<account>:<date>:<amt>"). Rows
  // imported before that carry the un-qualified id — recognise both so a re-import after the
  // upgrade tops up instead of double-counting every historical deposit.
  const legacyId = (id: string) => id.replace(/^t212:(dep|wd):\d+:/, "t212:$1:");
  const depositRow = async (r: NormalizedRow, sign: 1 | -1) => {
    if (r.external_id && (seenDep.has(r.external_id) || seenDep.has(legacyId(r.external_id)))) return false;
    const { error } = await supabase.from("deposits").insert({
      user_id: depUid, broker: r.broker, broker_account: r.account ?? plan.account ?? null,
      flow_date: r.executed_at.slice(0, 10),
      amount_usd: sign * Math.abs(r.amount_usd ?? 0), source: "statement", ext_id: r.external_id,
    });
    if (!error && r.external_id) seenDep.add(r.external_id);
    return !error;
  };
  for (const r of plan.deposits) if (await depositRow(r, 1)) s.deposits++;
  for (const r of plan.withdrawals) if (await depositRow(r, -1)) s.withdrawals++;
  // Fees: record as a small negative deposit (net capital effect), keeps balances clean.
  for (const r of plan.fees) { const a = r.amount_usd ?? 0; if (a !== 0 && await depositRow({ ...r, amount_usd: Math.abs(a) }, -1)) s.fees++; }
  // Idempotent dividends too (re-import / overlapping periods must not duplicate).
  const { data: existDiv } = await supabase.from("dividends").select("ext_id").eq("user_id", depUid).not("ext_id", "is", null);
  const seenDiv = new Set((existDiv ?? []).map((d: any) => d.ext_id));
  for (const r of plan.dividends) {
    if (r.external_id && seenDiv.has(r.external_id)) continue;
    const { error } = await supabase.from("dividends").insert({ ticker: r.ticker, ex_date: r.executed_at.slice(0, 10), pay_date: r.executed_at.slice(0, 10), amount_per_share: r.amount_usd, shares_held: 1, total_amount_usd: r.amount_usd, status: "paid", broker: r.broker, broker_account: r.account ?? plan.account ?? null, ext_id: r.external_id });
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
    }).then(({ data, error }) => (error ? 0 : Number(data) || 0), () => 0);
  }
  return s;
}
