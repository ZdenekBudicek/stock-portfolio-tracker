-- The watchlist was created single-user with `ticker text not null unique`, so the constraint
-- watchlist_ticker_key is GLOBAL: once one user watches NVDA, every other user's insert of NVDA
-- fails with a unique violation (RLS hides the conflicting row, so it looks inexplicable).
-- Uniqueness belongs per user: (user_id, ticker).
alter table public.watchlist drop constraint if exists watchlist_ticker_key;
drop index if exists public.watchlist_ticker_key;

-- Duplicates per user cannot exist while the global key was in force, but stay defensive:
-- only add the per-user key when the data allows it, otherwise leave a notice and no key
-- (dropping the global key above is correct either way).
do $$
begin
  if exists (
    select 1 from public.watchlist
    where user_id is not null
    group by user_id, ticker
    having count(*) > 1
  ) then
    raise notice 'watchlist has duplicate (user_id, ticker) rows; watchlist_user_ticker_key not created';
  else
    create unique index if not exists watchlist_user_ticker_key on public.watchlist (user_id, ticker);
  end if;
end
$$;
