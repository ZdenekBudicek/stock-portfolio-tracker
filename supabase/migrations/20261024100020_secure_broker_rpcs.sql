-- Objects that existed in production but not in the migrations (created by hand earlier), now
-- recorded here as they are in production, and locked down:
--
-- import_broker_dividends is SECURITY DEFINER and takes the target user as a parameter without
-- checking the caller. It is only ever called by the sync backend with the service role
-- (supabase/functions/sync-broker), so nobody else may execute it — before this, anyone with
-- the public anon key could write dividends (and with them cash) into any account.
--
-- seed_ticker_aliases only fills missing ISINs of the shared alias registry from a statement
-- import (it cannot repoint an existing alias); it stays callable by signed-in users only.

alter table public.broker_connections add column if not exists cash_base_free_usd numeric;

create or replace function public.import_broker_dividends(p_user_id uuid, p_broker text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n int;
begin
  perform set_config('app.bulk_import', 'on', true);
  insert into public.dividends (ticker, ex_date, pay_date, amount_per_share, shares_held, total_amount_usd, status, broker, ext_id, user_id, cash_delta_applied)
  select r.ticker, r.ex_date::date, r.pay_date::date, r.amount_per_share, r.shares_held, r.total_amount_usd, 'paid', p_broker, r.ext_id, p_user_id, 0
  from jsonb_to_recordset(p_rows) as r(ticker text, ex_date text, pay_date text, amount_per_share numeric, shares_held numeric, total_amount_usd numeric, ext_id text);
  get diagnostics n = row_count;
  perform set_config('app.bulk_import', 'off', true);
  return n;
end;
$function$;

create or replace function public.seed_ticker_aliases(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into ticker_alias(alias, canonical, isin, source)
  select upper(x->>'alias'), upper(x->>'alias'), upper(x->>'isin'), 'statement'
  from jsonb_array_elements(p_rows) x
  where coalesce(x->>'alias', '') <> '' and coalesce(x->>'isin', '') <> ''
  on conflict (alias) do update set isin = coalesce(ticker_alias.isin, excluded.isin), updated_at = now();
end;
$function$;

revoke all on function public.import_broker_dividends(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_broker_dividends(uuid, text, jsonb) to service_role;

revoke all on function public.seed_ticker_aliases(jsonb) from public, anon;
grant execute on function public.seed_ticker_aliases(jsonb) to authenticated, service_role;

-- The broker-connection RPCs act on auth.uid() only; a signed-out caller has nothing to do there.
revoke execute on function public.delete_broker_connection(text) from public, anon;
revoke execute on function public.get_broker_connection_status() from public, anon;
revoke execute on function public.set_broker_connection(text, text, text) from public, anon;
grant execute on function public.delete_broker_connection(text) to authenticated;
grant execute on function public.get_broker_connection_status() to authenticated;
grant execute on function public.set_broker_connection(text, text, text) to authenticated;
