CREATE OR REPLACE FUNCTION public.claim_orphan_data(p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target uuid;
  n_pos int; n_tx int; n_wl int; n_div int; n_goal int; n_snap int;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  -- Caller must be authenticated AS the email being claimed
  SELECT id INTO target FROM auth.users
    WHERE lower(email) = lower(p_email)
      AND id = auth.uid()
    LIMIT 1;

  IF target IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  UPDATE public.positions       SET user_id = target WHERE user_id IS NULL;
  GET DIAGNOSTICS n_pos = ROW_COUNT;
  UPDATE public.transactions    SET user_id = target WHERE user_id IS NULL;
  GET DIAGNOSTICS n_tx = ROW_COUNT;
  UPDATE public.watchlist       SET user_id = target WHERE user_id IS NULL;
  GET DIAGNOSTICS n_wl = ROW_COUNT;
  UPDATE public.dividends       SET user_id = target WHERE user_id IS NULL;
  GET DIAGNOSTICS n_div = ROW_COUNT;
  UPDATE public.portfolio_goals SET user_id = target WHERE user_id IS NULL;
  GET DIAGNOSTICS n_goal = ROW_COUNT;
  UPDATE public.daily_snapshots SET user_id = target WHERE user_id IS NULL;
  GET DIAGNOSTICS n_snap = ROW_COUNT;

  RETURN jsonb_build_object('ok', true,
    'positions', n_pos, 'transactions', n_tx, 'watchlist', n_wl,
    'dividends', n_div, 'goals', n_goal, 'snapshots', n_snap);
END;
$function$;