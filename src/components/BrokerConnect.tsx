import { useTranslation } from "react-i18next";
import { currentLocale } from "@/i18n";
import { useEffect, useState } from "react";
import { KeyRound, Link2, RefreshCw, Trash2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface ConnStatus { broker: string; environment: string; last_sync_at: string | null; status: string | null; }

const BrokerConnect = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [env, setEnv] = useState<"live" | "demo">("live");
  const [busy, setBusy] = useState(false);

  const loadStatus = async () => {
    const { data } = await supabase.rpc("get_broker_connection_status" as any);
    const t212 = (data as ConnStatus[] | null)?.find((c) => c.broker === "T212") ?? null;
    setStatus(t212);
  };
  useEffect(() => { loadStatus(); }, []);

  const connect = async () => {
    if (!apiKey.trim() || !secret.trim()) { toast.error(t('legacy.brokerConnect.enterBothApiKeyAndSecretKey')); return; }
    setBusy(true);
    try {
      // T212 = HTTP Basic auth; store as "apiKey:secret".
      const { error } = await supabase.rpc("set_broker_connection" as any, { p_broker: "T212", p_env: env, p_key: `${apiKey.trim()}:${secret.trim()}` });
      if (error) throw error;
      setApiKey(""); setSecret("");
      toast.success(t('legacy.brokerConnect.trading212Connected'));
      await loadStatus();
    } catch (e: any) { toast.error(t('legacy.brokerConnect.error') + (e?.message ?? "")); }
    finally { setBusy(false); }
  };

  const sync = async () => {
    setBusy(true);
    const toastId = toast.loading(t('legacy.brokerConnect.syncingWithTrading'));
    try {
      let done = false, first = true, rounds = 0, total = 0;
      while (!done && rounds < 80) {
        rounds++;
        const { data, error } = await supabase.functions.invoke("sync-broker", { body: { broker: "T212", restart: first } });
        if (error) throw error;
        const d: any = data;
        if (d?.error) throw new Error(d.error);
        first = false;
        done = !!d.done;
        if (done) {
          // Pure-API accounts report `positions`; statement accounts report what was appended.
          const msg = d.positions != null
            ? t('legacy.brokerConnect.positionCount', { count: d.positions })
            : t('legacy.brokerConnect.newTrades', { count: d.appended ?? 0, suffix: d.reconciled === false ? t('legacy.brokerConnect.holdingsNotReconciled') : "" });
          toast.success(t('legacy.brokerConnect.syncComplete', { v0: msg }), { id: toastId, duration: 7000 });
        } else {
          total += d.batch ?? 0;
          toast.loading(t('legacy.brokerConnect.importingTradeHistory', { v0: total }), { id: toastId });
        }
      }
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });

      // A sync can introduce tickers we have no sector for. auto-sync fires sync-sectors on
      // its own schedule, but this button is the path a person actually uses, so it has to
      // fire it too — otherwise a freshly bought holding sits in "Ostatní" until the next
      // cron tick, and sync-sectors' "never seen goes first" priority never gets a chance.
      // Best-effort and deliberately not awaited into the failure path: the position sync
      // already succeeded and must not be reported as failed because a sector lookup didn't.
      try {
        await supabase.functions.invoke("sync-sectors");
      } catch (e) {
        console.warn("sync-sectors after broker sync failed", e);
      }
      // Invalidate regardless — the sector may have been filled by an earlier run, and the
      // hook's 24h staleTime would otherwise keep an open tab showing the stale bucket.
      qc.invalidateQueries({ queryKey: ["ticker-profiles"] });

      await loadStatus();
    } catch (e: any) {
      toast.error(t('legacy.brokerConnect.syncFailed') + (e?.message ?? t('legacy.brokerConnect.unknownError')), { id: toastId });
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await supabase.rpc("delete_broker_connection" as any, { p_broker: "T212" });
      toast.success(t('legacy.brokerConnect.disconnected'));
      await loadStatus();
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <Link2 className="w-5 h-5 text-primary" /> {t('legacy.brokerConnect.brokerConnection')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('legacy.brokerConnect.trading212ReadOnly')}</span>
      </div>

      {status ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-profit/30 bg-profit/5 p-4 flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-profit shrink-0" />
            <div className="text-sm">
              <p className="font-bold">{t('legacy.brokerConnect.trading212Connected')}{" "}<span className="text-xs font-normal text-muted-foreground">({status.environment})</span></p>
              <p className="text-xs text-muted-foreground">
                {status.last_sync_at ? t('legacy.brokerConnect.lastSync', { v0: new Date(status.last_sync_at).toLocaleString(currentLocale()) }) : t('legacy.brokerConnect.notSyncedYet')}
                {status.status ? ` · ${status.status}` : ""}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={sync} disabled={busy} className="flex-1 gap-1.5">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {t('legacy.brokerConnect.sync')}</Button>
            <Button variant="ghost" onClick={disconnect} disabled={busy} className="text-loss"><Trash2 className="w-4 h-4 mr-1" /> {t('legacy.brokerConnect.disconnect')}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('legacy.brokerConnect.enterYour')}{" "}<span className="font-semibold">{t('legacy.brokerConnect.readOnly')}</span> {t('legacy.brokerConnect.apiKeyFromTrading212SettingsApiThe')}{" "}<span className="font-semibold">{t('legacy.brokerConnect.encrypted')}</span> {t('legacy.brokerConnect.andUsedOnlyOnTheServer')}</p>
          <div className="relative">
            <KeyRound className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t('legacy.brokerConnect.apiKeyId')} className="pl-9 font-mono" />
          </div>
          <div className="relative">
            <KeyRound className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t('legacy.brokerConnect.secretKey')} className="pl-9 font-mono" />
          </div>
          <div className="flex items-center gap-2">
            <select value={env} onChange={(e) => setEnv(e.target.value as any)} className="text-sm h-9 px-2 rounded-md border border-border bg-background">
              <option value="live">{t('legacy.brokerConnect.liveAccount')}</option>
              <option value="demo">{t('legacy.brokerConnect.demoPractice')}</option>
            </select>
            <Button onClick={connect} disabled={busy} className="flex-1 gap-1.5">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} {t('legacy.brokerConnect.connect')}</Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default BrokerConnect;
