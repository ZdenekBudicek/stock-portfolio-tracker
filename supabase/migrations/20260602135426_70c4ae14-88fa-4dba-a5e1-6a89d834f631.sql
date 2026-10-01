
-- Drop the old global unique constraint on positions.ticker and make it per-user
ALTER TABLE public.positions DROP CONSTRAINT IF EXISTS positions_ticker_key;
ALTER TABLE public.positions DROP CONSTRAINT IF EXISTS positions_user_id_ticker_key;
ALTER TABLE public.positions ADD CONSTRAINT positions_user_id_ticker_key UNIQUE (user_id, ticker);

-- Make sure the transaction trigger that recalculates positions & cash is actually attached
DROP TRIGGER IF EXISTS trg_on_transaction_change ON public.transactions;
CREATE TRIGGER trg_on_transaction_change
AFTER INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.on_transaction_change();

-- Ensure user_id defaults on insert via BEFORE trigger
DROP TRIGGER IF EXISTS trg_set_user_id_tx ON public.transactions;
CREATE TRIGGER trg_set_user_id_tx
BEFORE INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.set_user_id_default();

DROP TRIGGER IF EXISTS trg_set_user_id_pos ON public.positions;
CREATE TRIGGER trg_set_user_id_pos
BEFORE INSERT ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.set_user_id_default();

-- Autofill sector trigger
DROP TRIGGER IF EXISTS trg_autofill_position_sector ON public.positions;
CREATE TRIGGER trg_autofill_position_sector
BEFORE INSERT OR UPDATE ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.autofill_position_sector();

-- Fix recalc_cash: never go below zero (avoids negative phantom CASH for new users / SELL bug)
CREATE OR REPLACE FUNCTION public.recalc_cash(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE cash NUMERIC := 0; existing_cash NUMERIC := 0; t RECORD;
BEGIN
  -- Sum up tx-implied cash flow
  FOR t IN
    SELECT * FROM public.transactions
    WHERE ticker <> 'CASH' AND user_id = p_user_id
    ORDER BY executed_at ASC
  LOOP
    IF t.side = 'BUY' THEN
      cash := cash - (t.price_usd * t.shares + COALESCE(t.fee_usd,0));
    ELSE
      cash := cash + (t.price_usd * t.shares - COALESCE(t.fee_usd,0));
    END IF;
  END LOOP;

  FOR t IN SELECT * FROM public.transactions WHERE ticker = 'CASH' AND user_id = p_user_id LOOP
    IF t.side = 'BUY' THEN cash := cash + (t.price_usd * t.shares);
    ELSE cash := cash - (t.price_usd * t.shares); END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.positions WHERE ticker = 'CASH' AND user_id = p_user_id) THEN
    UPDATE public.positions SET shares = cash, updated_at = now()
      WHERE ticker = 'CASH' AND user_id = p_user_id;
  ELSIF cash <> 0 THEN
    -- Only create a CASH row if there is actual cash movement (avoids 0-cash phantom rows)
    INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd, user_id)
    VALUES ('CASH', 'Cash Balance', 'Cash', cash, 1, p_user_id);
  END IF;
END;
$function$;
