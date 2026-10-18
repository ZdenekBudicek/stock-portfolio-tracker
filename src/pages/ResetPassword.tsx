import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";


export default function ResetPassword() {
  const { t } = useTranslation();
  const passwordSchema = z.string().min(8, t('legacy.resetPassword.passwordMustHaveAtLeast8Characters')).max(72, t('legacy.resetPassword.passwordTooLong'));

  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.title = t('legacy.resetPassword.newPassword');
    // Supabase auto-detects recovery token from URL hash and emits a session
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => subscription.unsubscribe();
  }, [t]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const pw = passwordSchema.safeParse(password);
    if (!pw.success) return toast.error(pw.error.issues[0].message);
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw.data });
    setBusy(false);
    if (error) return toast.error(t('legacy.resetPassword.errorDetail', { message: error.message }));
    toast.success(t('legacy.resetPassword.passwordChanged'));
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md p-6">
        <h1 className="text-xl font-bold mb-4">{t('legacy.resetPassword.setANewPassword')}</h1>
        {!ready ? (
          <p className="text-sm text-muted-foreground">{t('legacy.resetPassword.processingTheRecoveryLink')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="np">{t('legacy.resetPassword.newPassword')}</Label>
              <Input id="np" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('legacy.resetPassword.save')}</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
