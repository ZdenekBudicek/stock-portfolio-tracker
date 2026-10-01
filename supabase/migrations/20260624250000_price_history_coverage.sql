-- Cheap coverage lookup for the backfill: earliest stored date per symbol.
-- Replaces a row-capped REST query (limit 1000) that made the backfill think
-- already-downloaded tickers were missing and re-download them forever.
create or replace function public.price_history_coverage(p_symbols text[])
returns table(symbol text, earliest date)
language sql
stable
security definer
set search_path = public
as $$
  select symbol, min(date) as earliest
  from public.price_history
  where symbol = any(p_symbols)
  group by symbol;
$$;

grant execute on function public.price_history_coverage(text[]) to authenticated, service_role;
