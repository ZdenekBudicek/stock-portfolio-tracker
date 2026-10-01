CREATE OR REPLACE FUNCTION public.apply_transaction_cash_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  wanted_delta numeric := 0;
  applied_delta numeric := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.apply_cash_delta(OLD.user_id, -coalesce(OLD.cash_delta_applied, 0));
    RETURN OLD;
  END IF;

  IF NEW.user_id IS NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  IF TG_OP = 'UPDATE' THEN
    PERFORM public.apply_cash_delta(OLD.user_id, -coalesce(OLD.cash_delta_applied, 0));
  END IF;

  wanted_delta := public.transaction_cash_delta(NEW.ticker, NEW.side, NEW.shares, NEW.price_usd, NEW.fee_usd);
  applied_delta := public.apply_cash_delta(NEW.user_id, wanted_delta);
  NEW.cash_delta_applied := applied_delta;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apply_transaction_cash_change() FROM anon, authenticated, public;