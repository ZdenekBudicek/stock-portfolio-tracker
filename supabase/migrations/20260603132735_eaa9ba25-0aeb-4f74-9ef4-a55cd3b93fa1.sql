
-- Lock down public-write tables (Edge Functions use service_role and bypass RLS)
DROP POLICY IF EXISTS "Public insert benchmark" ON public.benchmark_history;
DROP POLICY IF EXISTS "Public update benchmark" ON public.benchmark_history;

DROP POLICY IF EXISTS "Public insert earnings" ON public.earnings_calendar;
DROP POLICY IF EXISTS "Public update earnings" ON public.earnings_calendar;
DROP POLICY IF EXISTS "Public delete earnings" ON public.earnings_calendar;

DROP POLICY IF EXISTS "Public insert splits" ON public.splits;
DROP POLICY IF EXISTS "Public update splits" ON public.splits;
DROP POLICY IF EXISTS "Public delete splits" ON public.splits;

-- daily_snapshots: add owner-scoped write policies (service role bypasses RLS for cron)
CREATE POLICY "own snap insert" ON public.daily_snapshots
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own snap update" ON public.daily_snapshots
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own snap delete" ON public.daily_snapshots
  FOR DELETE USING (auth.uid() = user_id);

-- Fix mutable search_path on set_user_id_default
CREATE OR REPLACE FUNCTION public.set_user_id_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN NEW.user_id := auth.uid(); END IF;
  RETURN NEW;
END;
$function$;

-- Revoke EXECUTE on admin SECURITY DEFINER functions from public roles
REVOKE EXECUTE ON FUNCTION public.apply_split(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.dismiss_split(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.recalc_position(text) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.recalc_position(text, uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.recalc_cash() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.recalc_cash(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.claim_orphan_data(text) FROM anon, public;
-- claim_orphan_data still callable by authenticated (called after login)
