-- Trigger to auto-update CASH position when transactions are added
CREATE OR REPLACE FUNCTION public.update_cash_on_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  txn_amount NUMERIC;
  current_cash NUMERIC;
BEGIN
  -- Skip if the transaction is for CASH itself (manual cash deposit/withdraw)
  IF NEW.ticker = 'CASH' THEN
    RETURN NEW;
  END IF;

  -- Calculate transaction amount (price * shares + fee)
  txn_amount := (NEW.price_usd * NEW.shares) + COALESCE(NEW.fee_usd, 0);

  -- Get current cash balance (shares column on CASH position holds USD amount)
  SELECT shares INTO current_cash FROM public.positions WHERE ticker = 'CASH' LIMIT 1;

  -- Create CASH position if it doesn't exist
  IF current_cash IS NULL THEN
    INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd)
    VALUES ('CASH', 'Cash Balance', 'Cash', 0, 1);
    current_cash := 0;
  END IF;

  -- BUY: subtract from cash; SELL: add to cash (sell proceeds minus fee)
  IF NEW.side = 'BUY' THEN
    UPDATE public.positions
    SET shares = current_cash - txn_amount, updated_at = now()
    WHERE ticker = 'CASH';
  ELSIF NEW.side = 'SELL' THEN
    UPDATE public.positions
    SET shares = current_cash + (NEW.price_usd * NEW.shares) - COALESCE(NEW.fee_usd, 0),
        updated_at = now()
    WHERE ticker = 'CASH';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_cash_on_transaction ON public.transactions;
CREATE TRIGGER trg_update_cash_on_transaction
AFTER INSERT ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.update_cash_on_transaction();