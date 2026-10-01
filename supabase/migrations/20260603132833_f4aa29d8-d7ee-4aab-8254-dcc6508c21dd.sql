
CREATE OR REPLACE FUNCTION public.apply_split(split_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s RECORD;
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO s FROM public.splits WHERE id = split_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Split not found or already processed'; END IF;

  UPDATE public.positions
    SET shares = shares * s.ratio, avg_cost_usd = avg_cost_usd / s.ratio, updated_at = now()
  WHERE ticker = s.ticker AND ticker <> 'CASH' AND user_id = uid;

  UPDATE public.transactions
    SET shares = shares * s.ratio, price_usd = price_usd / s.ratio
  WHERE ticker = s.ticker AND user_id = uid AND executed_at::date < s.split_date;

  UPDATE public.splits SET status = 'applied', applied_at = now() WHERE id = split_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dismiss_split(split_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  UPDATE public.splits SET status = 'dismissed' WHERE id = split_id AND status = 'pending';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.apply_split(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_split(uuid) TO authenticated;
