-- Trigger to auto-sync positions from transactions (for any insert path)
CREATE OR REPLACE FUNCTION public.update_position_on_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  pos RECORD;
  new_shares NUMERIC;
  new_avg NUMERIC;
BEGIN
  -- Skip CASH (handled by separate trigger)
  IF NEW.ticker = 'CASH' THEN
    RETURN NEW;
  END IF;

  SELECT id, shares, avg_cost_usd, holding_start_date
    INTO pos
    FROM public.positions
    WHERE ticker = NEW.ticker
    LIMIT 1;

  IF NOT FOUND THEN
    -- Create new position only on BUY
    IF NEW.side = 'BUY' THEN
      INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd, holding_start_date)
      VALUES (NEW.ticker, NEW.ticker, 'Stock', NEW.shares, NEW.price_usd, NEW.executed_at::date);
    ELSE
      RAISE EXCEPTION 'Cannot SELL %, position does not exist', NEW.ticker;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.side = 'BUY' THEN
    new_shares := pos.shares + NEW.shares;
    IF new_shares > 0 THEN
      new_avg := (pos.shares * pos.avg_cost_usd + NEW.shares * NEW.price_usd) / new_shares;
    ELSE
      new_avg := pos.avg_cost_usd;
    END IF;
    UPDATE public.positions
      SET shares = new_shares,
          avg_cost_usd = new_avg,
          holding_start_date = COALESCE(pos.holding_start_date, NEW.executed_at::date),
          updated_at = now()
      WHERE id = pos.id;
  ELSIF NEW.side = 'SELL' THEN
    new_shares := pos.shares - NEW.shares;
    IF new_shares < -1e-9 THEN
      RAISE EXCEPTION 'Cannot SELL % shares of %, only % held', NEW.shares, NEW.ticker, pos.shares;
    END IF;
    UPDATE public.positions
      SET shares = GREATEST(0, new_shares),
          updated_at = now()
      WHERE id = pos.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_position_on_transaction ON public.transactions;
CREATE TRIGGER trg_update_position_on_transaction
  BEFORE INSERT ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_position_on_transaction();