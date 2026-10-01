
-- ensure one snapshot row per user per day
CREATE UNIQUE INDEX IF NOT EXISTS daily_snapshots_user_date_uniq
  ON public.daily_snapshots(user_id, snapshot_date);

-- ensure one position row per user per ticker
CREATE UNIQUE INDEX IF NOT EXISTS positions_user_ticker_uniq
  ON public.positions(user_id, ticker);
