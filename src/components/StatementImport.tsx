import { useRef, useState } from "react";
import { Upload, FileText, Check, X, Loader2, ArrowRightLeft, Wallet, Coins, Scissors, Receipt, PieChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { parseStatementFile, planImport, executeImport, type ImportPlan, type DetectedBroker } from "@/lib/statementImport";

const StatementImport = () => {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [broker, setBroker] = useState<DetectedBroker | null>(null);
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const reset = () => { setPlan(null); setBroker(null); setFileName(""); if (inputRef.current) inputRef.current.value = ""; };

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const parsed = await parseStatementFile(file);
      if (parsed.broker === "unknown" || parsed.rows.length === 0) {
        toast.error("Nepodařilo se přečíst výpis (podporováno: XTB .xlsx, Revolut .pdf)");
        reset(); return;
      }
      setBroker(parsed.broker); setFileName(file.name);
      setPlan(await planImport(parsed));
    } catch (e: any) {
      toast.error("Chyba při čtení: " + (e?.message ?? "neznámá")); reset();
    } finally { setBusy(false); }
  };

  const doImport = async () => {
    if (!plan) return;
    setBusy(true);
    const t = toast.loading("Importuji…");
    try {
      const s = await executeImport(plan);
      // ticker-profiles is in the list because an import can introduce new tickers, and the
      // hook holds a 24h staleTime — without this an open tab keeps showing them in
      // "Ostatní" long after the sector sync has filled them in.
      ["positions", "transactions", "dividends", "live-prices", "ticker-profiles"]
        .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      const msg = plan.mode === "holdings"
        ? `Nahráno ${s.holdings} pozic${s.removed ? `, ${s.removed} odebráno` : ""}`
        : `${s.inserted} přidáno, ${s.corrected} opraveno, ${s.deposits + s.withdrawals} hotovostních, ${s.dividends} dividend${s.alreadyStored ? `, ${s.alreadyStored} už bylo v databázi` : ""}${s.reconciled ? `, ${s.reconciled} pozic dorovnáno` : ""}`;
      // A batch the database refused must never be reported as success — it would leave the
      // portfolio silently short of trades.
      if (s.failed) toast.error(`Import částečně selhal: ${s.failed} obchodů se nezapsalo (${s.error ?? "neznámá chyba"}). ${msg}`, { id: t, duration: 15000 });
      else toast.success("Hotovo: " + msg, { id: t, duration: 8000 });
      reset();
    } catch (e: any) {
      toast.error("Import selhal: " + (e?.message ?? "neznámá"), { id: t });
    } finally { setBusy(false); }
  };

  const Stat = ({ icon, label, n }: { icon: any; label: string; n: number }) => (
    <div className="rounded-lg border border-border bg-background/40 p-3 text-center">
      <div className="flex items-center justify-center gap-1.5 text-muted-foreground mb-1">{icon}<span className="text-[10px] uppercase tracking-wider font-semibold">{label}</span></div>
      <p className="font-display text-xl font-bold tabular-nums">{n}</p>
    </div>
  );

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-display text-lg font-bold flex items-center gap-2"><Upload className="w-5 h-5 text-primary" /> Import výpisu</h2>
        <span className="text-[11px] text-muted-foreground">XTB (.xlsx) · Revolut (.pdf)</span>
      </div>

      {!plan && (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
          className="cursor-pointer rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors p-8 text-center"
        >
          {busy ? <Loader2 className="w-7 h-7 mx-auto animate-spin text-primary" /> : (
            <>
              <FileText className="w-7 h-7 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-medium">Přetáhni sem výpis nebo klikni pro výběr</p>
              <p className="text-xs text-muted-foreground mt-1">Zpracuje se jen v prohlížeči — nikam se neukládá.</p>
            </>
          )}
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        </div>
      )}

      {plan && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className="px-2 py-0.5 rounded-md bg-primary/15 text-primary font-bold text-xs">{broker}</span>
            {plan.account && <span className="px-2 py-0.5 rounded-md bg-muted text-muted-foreground font-mono text-xs">účet {plan.account}</span>}
            <span className="text-muted-foreground truncate">{fileName}</span>
          </div>

          {/* A statement of a DIFFERENT account at the same broker is the single easiest way
              to corrupt a portfolio (it used to overwrite the other account's positions), so
              say it out loud before anything is written. */}
          {plan.otherAccounts.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Tenhle výpis je z účtu <b>{plan.account ?? "?"}</b>, ale v portfoliu už máš {broker} účet{plan.otherAccounts.length > 1 ? "y" : ""}{" "}
              <b>{plan.otherAccounts.join(", ")}</b>. Naimportuje se zvlášť a ten druhý účet zůstane nedotčený — pokud sem nepatří, výpis neimportuj.
            </div>
          )}

          {plan.reconcileTo.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Po importu se pozice tohoto účtu dorovnají na {plan.reconcileTo.length} pozic z výpisu (jen tento účet, ostatní brokeři a ruční nákupy se nemění).
              {plan.adoptLegacy && ` Zároveň se ${plan.legacyUnassigned} starších ${broker} transakcí přiřadí k tomuto účtu.`}
            </p>
          )}

          {plan.blockedReconcile && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {plan.legacyUnassigned} starších {broker} transakcí nemá určený účet a v portfoliu je zároveň jiný {broker} účet, takže nejde poznat, kam patří.
              Obchody se naimportují, ale pozice se <b>nedorovnají</b> — kdyby se dorovnaly, nezapočítaly by ty staré řádky a kusy by se zdvojily.
            </div>
          )}

          {plan.mode === "holdings" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Stat icon={<PieChart className="w-3.5 h-3.5" />} label="Pozic nahraje" n={plan.holdings.length} />
                <Stat icon={<X className="w-3.5 h-3.5" />} label="Odebere" n={plan.holdingsRemove.length} />
              </div>
              <p className="text-[11px] text-muted-foreground">Načte se aktuální stav portfolia z výpisu (přesné pozice). Předchozí {broker} pozice se nahradí.</p>
              <div className="rounded-lg border border-border/60 bg-background/30 max-h-52 overflow-y-auto text-xs">
                {plan.holdings.map((h, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-1.5 border-b border-border/30 last:border-0">
                    <span className="font-mono font-bold">{h.ticker}</span>
                    <span className="tabular-nums text-muted-foreground">{h.shares} ks @ ${h.price_usd}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                <Stat icon={<ArrowRightLeft className="w-3.5 h-3.5" />} label="Přidá" n={plan.toInsertTrades.length} />
                <Stat icon={<Check className="w-3.5 h-3.5" />} label="Opraví" n={plan.toCorrectTrades.length} />
                <Stat icon={<Wallet className="w-3.5 h-3.5" />} label="Vklady" n={plan.deposits.length} />
                <Stat icon={<Wallet className="w-3.5 h-3.5" />} label="Výběry" n={plan.withdrawals.length} />
                <Stat icon={<Coins className="w-3.5 h-3.5" />} label="Dividendy" n={plan.dividends.length} />
                <Stat icon={<Receipt className="w-3.5 h-3.5" />} label="Poplatky" n={plan.fees.length} />
              </div>
              {(plan.splits.length > 0 || plan.alreadyImported > 0) && (
                <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                  {plan.splits.length > 0 && <span className="flex items-center gap-1"><Scissors className="w-3 h-3" /> {plan.splits.length} splitů</span>}
                  {plan.alreadyImported > 0 && <span>{plan.alreadyImported} už naimportováno (přeskočí se)</span>}
                </div>
              )}
            </>
          )}

          <div className="flex gap-2">
            <Button onClick={doImport} disabled={busy} className="flex-1">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />} Importovat
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}><X className="w-4 h-4 mr-1" /> Zrušit</Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default StatementImport;
