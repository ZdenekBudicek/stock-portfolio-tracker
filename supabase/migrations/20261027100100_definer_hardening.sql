-- Audit hardening of older SECURITY DEFINER functions: an empty search_path with qualified names, no PUBLIC execute,
-- and shared reference data that a signed-in user can only seed with valid, relevant values.

-- An ISIN: two letters, nine alphanumerics and a check digit (ISO 6166, Luhn over the letter-expanded digits).
create or replace function public.isin_valid(p_isin text)
returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_digits text := '';
  v_sum integer := 0;
  v_d integer;
  v_double boolean := false;
  i integer;
begin
  if p_isin is null or p_isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then return false; end if;
  for i in 1..11 loop
    v_digits := v_digits || case when substr(p_isin, i, 1) ~ '[0-9]' then substr(p_isin, i, 1)
      else (ascii(substr(p_isin, i, 1)) - 55)::text end;
  end loop;
  -- Luhn from the right, the check digit not included: the rightmost payload digit is doubled first.
  v_double := true;
  for i in reverse length(v_digits)..1 loop
    v_d := substr(v_digits, i, 1)::integer;
    if v_double then v_d := v_d * 2; if v_d > 9 then v_d := v_d - 9; end if; end if;
    v_sum := v_sum + v_d;
    v_double := not v_double;
  end loop;
  return (10 - v_sum % 10) % 10 = substr(p_isin, 12, 1)::integer;
end;
$$;
revoke all on function public.isin_valid(text) from public, anon;
grant execute on function public.isin_valid(text) to authenticated, service_role;

-- Statement imports record each ticker's ISIN in the shared ticker_alias (the price worker resolves foreign listings
-- through it). A signed-in caller may seed only valid ISINs for tickers in their own ledger, at most 500 rows, and never
-- overwrite an ISIN that is already known; the service role (no auth.uid()) is not limited to its own ledger.
create or replace function public.seed_ticker_aliases(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  insert into public.ticker_alias(alias, canonical, isin, source)
  select a.alias, a.alias, a.isin, 'statement'
  from (select distinct upper(btrim(x->>'alias')) as alias, upper(btrim(x->>'isin')) as isin
        from pg_catalog.jsonb_array_elements(p_rows) x) a
  where a.alias ~ '^[A-Z0-9][A-Z0-9.\-]{0,19}$' and public.isin_valid(a.isin)
    and (v_user is null or exists (select 1 from public.transactions t where t.user_id = v_user and upper(t.ticker) = a.alias))
  on conflict (alias) do update set isin = coalesce(public.ticker_alias.isin, excluded.isin), updated_at = now();
end;
$function$;
revoke all on function public.seed_ticker_aliases(jsonb) from public, anon;
grant execute on function public.seed_ticker_aliases(jsonb) to authenticated, service_role;

-- Coverage lookup for the backfill: qualified and not executable by PUBLIC/anon (it never revoked them). Not truncated:
-- missing coverage would be read as "not downloaded" and fetched again (shared, public price data only).
create or replace function public.price_history_coverage(p_symbols text[])
returns table(symbol text, earliest date)
language sql
stable
security definer
set search_path = ''
as $$
  select h.symbol, min(h.date) as earliest
  from public.price_history h
  where h.symbol = any(p_symbols)
  group by h.symbol;
$$;
revoke all on function public.price_history_coverage(text[]) from public, anon;
grant execute on function public.price_history_coverage(text[]) to authenticated, service_role;

-- Fundamentals reservations (service role only): same behaviour, qualified names and an empty search_path.
create or replace function public.reserve_fundamentals_requests(p_user uuid, p_symbols text[], p_hourly_limit int default 30)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  used int;
  reserved text[] := '{}';
  s text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fundamentals_requests:' || p_user::text));
  select count(*) into used from public.fundamentals_requests
    where requested_by = p_user and requested_at > now() - interval '1 hour';
  if used + coalesce(pg_catalog.array_length(p_symbols, 1), 0) > p_hourly_limit then
    raise exception 'rate_limited';
  end if;
  foreach s in array p_symbols loop
    insert into public.fundamentals_requests as r (symbol, status, requested_at, requested_by, finished_at, last_error)
      values (s, 'pending', now(), p_user, null, null)
    on conflict (symbol) do update
      set status = 'pending', requested_at = now(), requested_by = p_user, finished_at = null, last_error = null
      where (r.status = 'pending' and r.requested_at < now() - interval '30 minutes')
         or (r.status <> 'pending' and coalesce(r.finished_at, r.requested_at) < now() - interval '1 day')
    returning r.symbol into s;
    if found then reserved := reserved || s; end if;
  end loop;
  return reserved;
end $$;
revoke all on function public.reserve_fundamentals_requests(uuid, text[], int) from public, anon, authenticated;
grant execute on function public.reserve_fundamentals_requests(uuid, text[], int) to service_role;

create or replace function public.release_fundamentals_requests(p_symbols text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.fundamentals_requests where symbol = any(p_symbols) and status = 'pending';
$$;
revoke all on function public.release_fundamentals_requests(text[]) from public, anon, authenticated;
grant execute on function public.release_fundamentals_requests(text[]) to service_role;
