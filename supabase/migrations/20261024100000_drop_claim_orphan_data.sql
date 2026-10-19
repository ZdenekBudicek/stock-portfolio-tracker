-- claim_orphan_data(p_email) handed EVERY row with user_id IS NULL (positions, transactions,
-- watchlist, dividends, goals, snapshots) to whichever authenticated caller passed their own
-- e-mail — i.e. to the first account that signed in after the multi-user migration, and to
-- any later account if orphan rows ever reappeared. Production has no orphan rows left, and
-- the client no longer calls it, so the function is removed outright.
drop function if exists public.claim_orphan_data(text);
