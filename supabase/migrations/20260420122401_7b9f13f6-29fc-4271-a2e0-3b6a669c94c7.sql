
-- 1. Add holding_start_date to positions for 3-year tax test
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS holding_start_date DATE;

-- Backfill from earliest BUY transaction
UPDATE public.positions p
SET holding_start_date = sub.first_buy::date
FROM (
  SELECT ticker, MIN(executed_at) AS first_buy
  FROM public.transactions
  WHERE side = 'BUY'
  GROUP BY ticker
) sub
WHERE p.ticker = sub.ticker AND p.holding_start_date IS NULL;

-- 2. Dividends
CREATE TABLE IF NOT EXISTS public.dividends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  ex_date DATE NOT NULL,
  pay_date DATE,
  amount_per_share NUMERIC NOT NULL,
  shares_held NUMERIC,
  total_amount_usd NUMERIC,
  status TEXT NOT NULL DEFAULT 'upcoming', -- upcoming | paid
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dividends_ticker ON public.dividends(ticker);
CREATE INDEX IF NOT EXISTS idx_dividends_ex_date ON public.dividends(ex_date);
ALTER TABLE public.dividends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read dividends" ON public.dividends FOR SELECT USING (true);
CREATE POLICY "Public insert dividends" ON public.dividends FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update dividends" ON public.dividends FOR UPDATE USING (true);
CREATE POLICY "Public delete dividends" ON public.dividends FOR DELETE USING (true);

-- 3. Splits
CREATE TABLE IF NOT EXISTS public.splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  split_date DATE NOT NULL,
  ratio NUMERIC NOT NULL, -- e.g. 4 for 4:1 split (shares ×4, price /4)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | applied | dismissed
  source TEXT NOT NULL DEFAULT 'auto', -- auto | manual
  detected_price NUMERIC,
  prev_close NUMERIC,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_splits_status ON public.splits(status);
ALTER TABLE public.splits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read splits" ON public.splits FOR SELECT USING (true);
CREATE POLICY "Public insert splits" ON public.splits FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update splits" ON public.splits FOR UPDATE USING (true);
CREATE POLICY "Public delete splits" ON public.splits FOR DELETE USING (true);

-- 4. Portfolio goals
CREATE TABLE IF NOT EXISTS public.portfolio_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  target_amount_usd NUMERIC NOT NULL,
  target_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.portfolio_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read goals" ON public.portfolio_goals FOR SELECT USING (true);
CREATE POLICY "Public insert goals" ON public.portfolio_goals FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update goals" ON public.portfolio_goals FOR UPDATE USING (true);
CREATE POLICY "Public delete goals" ON public.portfolio_goals FOR DELETE USING (true);

-- 5. Watchlist
CREATE TABLE IF NOT EXISTS public.watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  target_price_usd NUMERIC,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read watchlist" ON public.watchlist FOR SELECT USING (true);
CREATE POLICY "Public insert watchlist" ON public.watchlist FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update watchlist" ON public.watchlist FOR UPDATE USING (true);
CREATE POLICY "Public delete watchlist" ON public.watchlist FOR DELETE USING (true);

-- 6. Benchmark history (S&P 500 etc.)
CREATE TABLE IF NOT EXISTS public.benchmark_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  date DATE NOT NULL,
  close_value NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_benchmark_symbol_date ON public.benchmark_history(symbol, date);
ALTER TABLE public.benchmark_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read benchmark" ON public.benchmark_history FOR SELECT USING (true);
CREATE POLICY "Public insert benchmark" ON public.benchmark_history FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update benchmark" ON public.benchmark_history FOR UPDATE USING (true);

-- 7. Earnings calendar
CREATE TABLE IF NOT EXISTS public.earnings_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  earnings_date DATE NOT NULL,
  time_of_day TEXT, -- 'BMO' | 'AMC' | 'TBA'
  eps_estimate NUMERIC,
  eps_actual NUMERIC,
  revenue_estimate NUMERIC,
  revenue_actual NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ticker, earnings_date)
);
CREATE INDEX IF NOT EXISTS idx_earnings_date ON public.earnings_calendar(earnings_date);
ALTER TABLE public.earnings_calendar ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read earnings" ON public.earnings_calendar FOR SELECT USING (true);
CREATE POLICY "Public insert earnings" ON public.earnings_calendar FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update earnings" ON public.earnings_calendar FOR UPDATE USING (true);
CREATE POLICY "Public delete earnings" ON public.earnings_calendar FOR DELETE USING (true);

-- 8. Function: apply a split to positions and historical transactions
CREATE OR REPLACE FUNCTION public.apply_split(split_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s RECORD;
BEGIN
  SELECT * INTO s FROM public.splits WHERE id = split_id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Split not found or already processed';
  END IF;

  -- Update current position: shares × ratio, avg_cost / ratio
  UPDATE public.positions
    SET shares = shares * s.ratio,
        avg_cost_usd = avg_cost_usd / s.ratio,
        updated_at = now()
  WHERE ticker = s.ticker AND ticker <> 'CASH';

  -- Adjust historical transactions BEFORE the split date
  UPDATE public.transactions
    SET shares = shares * s.ratio,
        price_usd = price_usd / s.ratio
  WHERE ticker = s.ticker
    AND executed_at::date < s.split_date;

  UPDATE public.splits
    SET status = 'applied', applied_at = now()
  WHERE id = split_id;
END;
$$;

-- 9. Function: dismiss a split suggestion
CREATE OR REPLACE FUNCTION public.dismiss_split(split_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.splits SET status = 'dismissed' WHERE id = split_id AND status = 'pending';
END;
$$;
