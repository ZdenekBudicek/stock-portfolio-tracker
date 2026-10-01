
-- =========================================================
-- Multi-tenant migration: add user_id and owner-based RLS
-- =========================================================

-- 1. Add user_id columns (nullable for backfill)
ALTER TABLE public.positions       ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.transactions    ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.watchlist       ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.dividends       ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.portfolio_goals ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.daily_snapshots ADD COLUMN IF NOT EXISTS user_id uuid;

-- Defaults so future inserts auto-fill from auth.uid()
ALTER TABLE public.positions       ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.transactions    ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.watchlist       ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.dividends       ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.portfolio_goals ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.daily_snapshots ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_positions_user       ON public.positions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user    ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_user       ON public.watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_dividends_user       ON public.dividends(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user           ON public.portfolio_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_user       ON public.daily_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_user_ticker ON public.positions(user_id, ticker);

-- Grants (RLS still enforced)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchlist       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dividends       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_goals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_snapshots TO authenticated;
GRANT ALL ON public.positions, public.transactions, public.watchlist,
            public.dividends, public.portfolio_goals, public.daily_snapshots
      TO service_role;

-- Shared tables: earnings_calendar, splits, benchmark_history, price_cache
GRANT SELECT ON public.earnings_calendar, public.splits,
                public.benchmark_history, public.price_cache TO authenticated, anon;
GRANT ALL    ON public.earnings_calendar, public.splits,
                public.benchmark_history, public.price_cache TO service_role;

-- 2. Drop old public-everyone policies
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('positions','transactions','watchlist','dividends',
                         'portfolio_goals','daily_snapshots')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- 3. Owner-based policies on per-user tables
-- positions
CREATE POLICY "own positions select" ON public.positions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "own positions insert" ON public.positions FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own positions update" ON public.positions FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own positions delete" ON public.positions FOR DELETE
  USING (auth.uid() = user_id);

-- transactions
CREATE POLICY "own tx select" ON public.transactions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "own tx insert" ON public.transactions FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own tx update" ON public.transactions FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own tx delete" ON public.transactions FOR DELETE
  USING (auth.uid() = user_id);

-- watchlist
CREATE POLICY "own wl select" ON public.watchlist FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "own wl insert" ON public.watchlist FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own wl update" ON public.watchlist FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own wl delete" ON public.watchlist FOR DELETE
  USING (auth.uid() = user_id);

-- dividends
CREATE POLICY "own div select" ON public.dividends FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "own div insert" ON public.dividends FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own div update" ON public.dividends FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own div delete" ON public.dividends FOR DELETE
  USING (auth.uid() = user_id);

-- portfolio_goals
CREATE POLICY "own goals select" ON public.portfolio_goals FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "own goals insert" ON public.portfolio_goals FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own goals update" ON public.portfolio_goals FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own goals delete" ON public.portfolio_goals FOR DELETE
  USING (auth.uid() = user_id);

-- daily_snapshots (insert restricted to service_role / backend)
CREATE POLICY "own snap select" ON public.daily_snapshots FOR SELECT
  USING (auth.uid() = user_id);

-- 4. Update trigger functions to be user_id-aware
CREATE OR REPLACE FUNCTION public.recalc_position(p_ticker text, p_user_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  t RECORD;
  cur_shares NUMERIC := 0;
  cur_cost NUMERIC := 0;
  avg NUMERIC := 0;
  start_date DATE := NULL;
  new_shares NUMERIC;
BEGIN
  IF upper(p_ticker) = 'CASH' THEN RETURN; END IF;

  FOR t IN
    SELECT * FROM public.transactions
    WHERE ticker = p_ticker AND user_id = p_user_id
    ORDER BY executed_at ASC, created_at ASC
  LOOP
    IF t.side = 'BUY' THEN
      new_shares := cur_shares + t.shares;
      cur_cost := cur_cost + t.shares * t.price_usd;
      cur_shares := new_shares;
      IF start_date IS NULL THEN start_date := t.executed_at::date; END IF;
    ELSIF t.side = 'SELL' THEN
      IF cur_shares > 0 THEN
        cur_cost := cur_cost - (cur_cost * (LEAST(t.shares, cur_shares) / cur_shares));
        cur_shares := GREATEST(0, cur_shares - t.shares);
        IF cur_shares = 0 THEN cur_cost := 0; END IF;
      END IF;
    END IF;
  END LOOP;

  IF cur_shares > 0 THEN avg := cur_cost / cur_shares; ELSE avg := 0; END IF;

  IF EXISTS (SELECT 1 FROM public.positions WHERE ticker = p_ticker AND user_id = p_user_id) THEN
    UPDATE public.positions
      SET shares = cur_shares, avg_cost_usd = avg,
          holding_start_date = start_date, updated_at = now()
      WHERE ticker = p_ticker AND user_id = p_user_id;
  ELSE
    IF cur_shares > 0 THEN
      INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd, holding_start_date, user_id)
      VALUES (p_ticker, p_ticker, 'Stock', cur_shares, avg, start_date, p_user_id);
    END IF;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.recalc_cash(p_user_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE cash NUMERIC := 0; t RECORD;
BEGIN
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
  ELSE
    INSERT INTO public.positions (ticker, name, type, shares, avg_cost_usd, user_id)
    VALUES ('CASH', 'Cash Balance', 'Cash', cash, 1, p_user_id);
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.on_transaction_change()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE uid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_position(OLD.ticker, OLD.user_id);
    PERFORM public.recalc_cash(OLD.user_id);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.ticker <> OLD.ticker OR NEW.user_id <> OLD.user_id THEN
      PERFORM public.recalc_position(OLD.ticker, OLD.user_id);
    END IF;
    PERFORM public.recalc_position(NEW.ticker, NEW.user_id);
    PERFORM public.recalc_cash(NEW.user_id);
    RETURN NEW;
  ELSE
    -- INSERT
    IF NEW.user_id IS NULL THEN NEW.user_id := auth.uid(); END IF;
    PERFORM public.recalc_position(NEW.ticker, NEW.user_id);
    PERFORM public.recalc_cash(NEW.user_id);
    RETURN NEW;
  END IF;
END;
$fn$;

-- Drop legacy trigger functions that operate without user_id
DROP FUNCTION IF EXISTS public.update_position_on_transaction() CASCADE;
DROP FUNCTION IF EXISTS public.update_cash_on_transaction() CASCADE;

-- Make sure on_transaction_change trigger exists
DROP TRIGGER IF EXISTS trg_transactions_change ON public.transactions;
CREATE TRIGGER trg_transactions_change
AFTER INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.on_transaction_change();

-- Also ensure user_id is set on insert if missing (BEFORE trigger)
CREATE OR REPLACE FUNCTION public.set_user_id_default()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.user_id IS NULL THEN NEW.user_id := auth.uid(); END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_tx_set_user ON public.transactions;
CREATE TRIGGER trg_tx_set_user BEFORE INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.set_user_id_default();

DROP TRIGGER IF EXISTS trg_pos_set_user ON public.positions;
CREATE TRIGGER trg_pos_set_user BEFORE INSERT ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.set_user_id_default();

-- Sector autofill trigger (re-attach)
DROP TRIGGER IF EXISTS trg_pos_autofill_sector ON public.positions;
CREATE TRIGGER trg_pos_autofill_sector BEFORE INSERT OR UPDATE ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.autofill_position_sector();

-- 5. Backfill helper: assign all existing orphan rows to a user by email
CREATE OR REPLACE FUNCTION public.claim_orphan_data(p_email text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  target uuid;
  n_pos int; n_tx int; n_wl int; n_div int; n_goal int; n_snap int;
BEGIN
  SELECT id INTO target FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF target IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found');
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

  RETURN jsonb_build_object('ok', true, 'user_id', target,
    'positions', n_pos, 'transactions', n_tx, 'watchlist', n_wl,
    'dividends', n_div, 'goals', n_goal, 'snapshots', n_snap);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.claim_orphan_data(text) TO authenticated;
