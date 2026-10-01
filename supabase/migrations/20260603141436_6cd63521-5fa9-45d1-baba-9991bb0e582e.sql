ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS cash_delta_applied numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.transaction_cash_delta(
  p_ticker text,
  p_side text,
  p_shares numeric,
  p_price_usd numeric,
  p_fee_usd numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN upper(coalesce(p_ticker, '')) = 'CASH' AND upper(coalesce(p_side, '')) = 'BUY'
      THEN coalesce(p_price_usd, 0) * coalesce(p_shares, 0)
    WHEN upper(coalesce(p_ticker, '')) = 'CASH' AND upper(coalesce(p_side, '')) = 'SELL'
      THEN -(coalesce(p_price_usd, 0) * coalesce(p_shares, 0))
    WHEN upper(coalesce(p_side, '')) = 'SELL'
      THEN coalesce(p_price_usd, 0) * coalesce(p_shares, 0) - coalesce(p_fee_usd, 0)
    WHEN upper(coalesce(p_side, '')) = 'BUY'
      THEN -(coalesce(p_price_usd, 0) * coalesce(p_shares, 0) + coalesce(p_fee_usd, 0))
    ELSE 0
  END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_cash_delta(p_user_id uuid, p_delta numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  current_cash numeric := 0;
  normalized_cash numeric := 0;
BEGIN
  IF p_user_id IS NULL OR coalesce(p_delta, 0) = 0 THEN
    RETURN 0;
  END IF;

  SELECT shares INTO current_cash
  FROM public.positions
  WHERE ticker = 'CASH' AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_delta > 0 THEN
      INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd, user_id)
      VALUES ('CASH', 'Cash Balance', 'Cash', p_delta, 1, p_user_id);
      RETURN p_delta;
    END IF;
    RETURN 0;
  END IF;

  normalized_cash := greatest(coalesce(current_cash, 0), 0);

  IF p_delta < 0 AND normalized_cash < abs(p_delta) THEN
    UPDATE public.positions
    SET shares = normalized_cash, avg_cost_usd = 1, updated_at = now()
    WHERE ticker = 'CASH' AND user_id = p_user_id;
    RETURN 0;
  END IF;

  UPDATE public.positions
  SET shares = normalized_cash + p_delta,
      avg_cost_usd = 1,
      updated_at = now()
  WHERE ticker = 'CASH' AND user_id = p_user_id;

  RETURN p_delta;
END;
$function$;

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

  IF TG_OP = 'UPDATE' THEN
    PERFORM public.apply_cash_delta(OLD.user_id, -coalesce(OLD.cash_delta_applied, 0));
  END IF;

  wanted_delta := public.transaction_cash_delta(NEW.ticker, NEW.side, NEW.shares, NEW.price_usd, NEW.fee_usd);
  applied_delta := public.apply_cash_delta(NEW.user_id, wanted_delta);
  NEW.cash_delta_applied := applied_delta;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.on_transaction_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_position(OLD.ticker, OLD.user_id);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.ticker <> OLD.ticker OR NEW.user_id <> OLD.user_id THEN
      PERFORM public.recalc_position(OLD.ticker, OLD.user_id);
    END IF;
    PERFORM public.recalc_position(NEW.ticker, NEW.user_id);
    RETURN NEW;
  ELSE
    PERFORM public.recalc_position(NEW.ticker, NEW.user_id);
    RETURN NEW;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recalc_cash(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.positions
  SET shares = greatest(shares, 0), avg_cost_usd = 1, updated_at = now()
  WHERE ticker = 'CASH' AND user_id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recalc_cash()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.positions
  SET shares = greatest(shares, 0), avg_cost_usd = 1, updated_at = now()
  WHERE ticker = 'CASH';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.transaction_cash_delta(text, text, numeric, numeric, numeric) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.apply_cash_delta(uuid, numeric) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.apply_transaction_cash_change() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.recalc_cash(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.recalc_cash() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS trg_on_transaction_change ON public.transactions;
DROP TRIGGER IF EXISTS trg_transaction_delete ON public.transactions;
DROP TRIGGER IF EXISTS trg_transaction_update ON public.transactions;
DROP TRIGGER IF EXISTS trg_transactions_change ON public.transactions;
DROP TRIGGER IF EXISTS trg_apply_transaction_cash ON public.transactions;
DROP TRIGGER IF EXISTS trg_set_user_id_tx ON public.transactions;
DROP TRIGGER IF EXISTS trg_tx_set_user ON public.transactions;

CREATE TRIGGER trg_set_user_id_tx
BEFORE INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.set_user_id_default();

CREATE TRIGGER trg_apply_transaction_cash
BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.apply_transaction_cash_change();

CREATE TRIGGER trg_on_transaction_change
AFTER INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.on_transaction_change();

DROP TRIGGER IF EXISTS trg_autofill_position_sector ON public.positions;
DROP TRIGGER IF EXISTS trg_pos_autofill_sector ON public.positions;
DROP TRIGGER IF EXISTS trg_set_user_id_pos ON public.positions;
DROP TRIGGER IF EXISTS trg_pos_set_user ON public.positions;

CREATE TRIGGER trg_set_user_id_pos
BEFORE INSERT ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.set_user_id_default();

CREATE TRIGGER trg_autofill_position_sector
BEFORE INSERT OR UPDATE ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.autofill_position_sector();