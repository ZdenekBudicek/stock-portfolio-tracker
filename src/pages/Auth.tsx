import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { BrandMark, BrandName } from "@/components/brand/BrandMark";


export default function Auth() {
  const { t } = useTranslation();
  const emailSchema = z.string().trim().email(t('legacy.auth.invalidEmail')).max(255, t('legacy.auth.emailTooLong'));
  const passwordSchema = z.string().min(8, t('legacy.auth.passwordMustHaveAtLeast8Characters')).max(72, t('legacy.auth.passwordTooLong'));

  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  useEffect(() => {
    document.title = t('legacy.auth.signInPortfolioTracker');
  }, [t]);

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;

  const handleGoogle = async () => {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      toast.error(t('legacy.auth.googleSignInFailed'));
      setBusy(false);
    }
    // on success the browser is redirected to Google by Supabase
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = emailSchema.safeParse(email);
    const pw = passwordSchema.safeParse(password);
    if (!em.success) return toast.error(em.error.issues[0].message);
    if (!pw.success) return toast.error(pw.error.issues[0].message);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: em.data, password: pw.data });
    setBusy(false);
    if (error) return toast.error(t('legacy.auth.errorDetail', { message: error.message }));
    navigate("/", { replace: true });
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = emailSchema.safeParse(email);
    const pw = passwordSchema.safeParse(password);
    if (!em.success) return toast.error(em.error.issues[0].message);
    if (!pw.success) return toast.error(pw.error.issues[0].message);
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email: em.data,
      password: pw.data,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    setBusy(false);
    if (error) return toast.error(t('legacy.auth.errorDetail', { message: error.message }));
    toast.success(t('legacy.auth.accountCreatedCheckYourEmailToConfirm'));
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = emailSchema.safeParse(email);
    if (!em.success) return toast.error(em.error.issues[0].message);
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(em.data, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) return toast.error(t('legacy.auth.errorDetail', { message: error.message }));
    toast.success(t('legacy.auth.ifTheAccountExistsWeHaveSentYou'));
    setForgotMode(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <BrandMark size={56} className="mx-auto" />
          <h1 className="text-3xl"><BrandName /></h1>
          <p className="text-sm text-muted-foreground">
            {t('legacy.auth.trackYourStocksCryptoAndPortfolioGrowthIn')}</p>
        </div>

        <Card className="p-6">
          {forgotMode ? (
            <form onSubmit={handleForgot} className="space-y-4">
              <h2 className="font-semibold">{t('legacy.auth.resetPassword')}</h2>
              <div className="space-y-2">
                <Label htmlFor="fmail">{t('legacy.auth.email')}</Label>
                <Input id="fmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('legacy.auth.sendLink')}</Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => setForgotMode(false)}>
                {t('legacy.auth.back')}</Button>
            </form>
          ) : (
            <Tabs defaultValue="login">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">{t('legacy.auth.signIn')}</TabsTrigger>
                <TabsTrigger value="signup">{t('legacy.auth.signUp')}</TabsTrigger>
              </TabsList>

              <TabsContent value="login">
                <form onSubmit={handleLogin} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="lmail">{t('legacy.auth.email')}</Label>
                    <Input id="lmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lpw">{t('legacy.auth.password')}</Label>
                    <Input id="lpw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {t('legacy.auth.signIn2')}</Button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
                    onClick={() => setForgotMode(true)}
                  >
                    {t('legacy.auth.forgotPassword')}</button>
                </form>
              </TabsContent>

              <TabsContent value="signup">
                <form onSubmit={handleSignup} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="smail">{t('legacy.auth.email')}</Label>
                    <Input id="smail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="spw">{t('legacy.auth.passwordMin8Characters')}</Label>
                    <Input id="spw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {t('legacy.auth.createAccount')}</Button>
                </form>
              </TabsContent>
            </Tabs>
          )}

          {!forgotMode && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">{t('legacy.auth.or')}</span>
                </div>
              </div>
              <Button type="button" variant="outline" className="w-full" onClick={handleGoogle} disabled={busy}>
                <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.83z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>
                {t('legacy.auth.continueWithGoogle')}</Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
