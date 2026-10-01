DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'daily_snapshots_snapshot_date_key'
      AND conrelid = 'public.daily_snapshots'::regclass
  ) THEN
    ALTER TABLE public.daily_snapshots DROP CONSTRAINT daily_snapshots_snapshot_date_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS daily_snapshots_user_id_snapshot_date_key
ON public.daily_snapshots (user_id, snapshot_date);