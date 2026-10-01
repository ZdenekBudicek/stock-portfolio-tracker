-- Recalculate one position fully from its transactions
CREATE OR REPLACE FUNCTION public.recalc_position(p_ticker text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t RECORD;
  cur_shares NUMERIC := 0;
  cur_cost NUMERIC := 0; -- total cost basis of currently held shares
  avg NUMERIC := 0;
  start_date DATE := NULL;
  new_shares NUMERIC;
BEGIN
  IF upper(p_ticker) = 'CASH' THEN
    RETURN;
  END IF;

  FOR t IN
    SELECT * FROM public.transactions
    WHERE ticker = p_ticker
    ORDER BY executed_at ASC, created_at ASC
  LOOP
    IF t.side = 'BUY' THEN
      new_shares := cur_shares + t.shares;
      cur_cost := cur_cost + t.shares * t.price_usd;
      cur_shares := new_shares;
      IF start_date IS NULL THEN
        start_date := t.executed_at::date;
      END IF;
    ELSIF t.side = 'SELL' THEN
      IF cur_shares > 0 THEN
        -- Reduce cost basis proportionally
        cur_cost := cur_cost - (cur_cost * (LEAST(t.shares, cur_shares) / cur_shares));
        cur_shares := GREATEST(0, cur_shares - t.shares);
        IF cur_shares = 0 THEN
          cur_cost := 0;
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF cur_shares > 0 THEN
    avg := cur_cost / cur_shares;
  ELSE
    avg := 0;
  END IF;

  -- Upsert position
  IF EXISTS (SELECT 1 FROM public.positions WHERE ticker = p_ticker) THEN
    UPDATE public.positions
      SET shares = cur_shares,
          avg_cost_usd = avg,
          holding_start_date = start_date,
          updated_at = now()
      WHERE ticker = p_ticker;
  ELSE
    IF cur_shares > 0 THEN
      INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd, holding_start_date)
      VALUES (p_ticker, p_ticker, 'Stock', cur_shares, avg, start_date);
    END IF;
  END IF;
END;
$$;

-- Recalculate cash balance fully from transactions
CREATE OR REPLACE FUNCTION public.recalc_cash()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cash NUMERIC := 0;
  t RECORD;
BEGIN
  FOR t IN
    SELECT * FROM public.transactions
    WHERE ticker <> 'CASH'
    ORDER BY executed_at ASC
  LOOP
    IF t.side = 'BUY' THEN
      cash := cash - (t.price_usd * t.shares + COALESCE(t.fee_usd,0));
    ELSE
      cash := cash + (t.price_usd * t.shares - COALESCE(t.fee_usd,0));
    END IF;
  END LOOP;

  -- Add manual CASH ticker movements (deposits/withdrawals)
  FOR t IN SELECT * FROM public.transactions WHERE ticker = 'CASH' LOOP
    IF t.side = 'BUY' THEN
      cash := cash + (t.price_usd * t.shares);
    ELSE
      cash := cash - (t.price_usd * t.shares);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.positions WHERE ticker = 'CASH') THEN
    UPDATE public.positions SET shares = cash, updated_at = now() WHERE ticker = 'CASH';
  ELSE
    INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd)
    VALUES ('CASH', 'Cash Balance', 'Cash', cash, 1);
  END IF;
END;
$$;

-- Trigger function: handle UPDATE / DELETE of transactions
CREATE OR REPLACE FUNCTION public.on_transaction_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_position(OLD.ticker);
    PERFORM public.recalc_cash();
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If ticker changed, recalc both
    IF NEW.ticker <> OLD.ticker THEN
      PERFORM public.recalc_position(OLD.ticker);
    END IF;
    PERFORM public.recalc_position(NEW.ticker);
    PERFORM public.recalc_cash();
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transaction_update ON public.transactions;
CREATE TRIGGER trg_transaction_update
AFTER UPDATE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.on_transaction_change();

DROP TRIGGER IF EXISTS trg_transaction_delete ON public.transactions;
CREATE TRIGGER trg_transaction_delete
AFTER DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.on_transaction_change();

-- Make sure INSERT triggers exist (idempotent recreate)
DROP TRIGGER IF EXISTS trg_update_position_on_transaction ON public.transactions;
CREATE TRIGGER trg_update_position_on_transaction
AFTER INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.update_position_on_transaction();

DROP TRIGGER IF EXISTS trg_update_cash_on_transaction ON public.transactions;
CREATE TRIGGER trg_update_cash_on_transaction
AFTER INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.update_cash_on_transaction();

-- Sector autofill trigger (idempotent)
DROP TRIGGER IF EXISTS trg_autofill_position_sector ON public.positions;
CREATE TRIGGER trg_autofill_position_sector
BEFORE INSERT OR UPDATE ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.autofill_position_sector();