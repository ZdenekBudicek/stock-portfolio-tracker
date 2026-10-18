-- On-demand fetch of company statements for a company nobody had data for yet.
-- Reserved by the request-fundamentals edge function (pending) through
-- reserve_fundamentals_requests (atomic: per-user quota + one run per symbol), finished by the
-- GitHub workflow (done / failed). Users may read the status: the app shows "fetching…"
-- while a request is pending. Who asked is not readable through the API.
create table if not exists public.fundamentals_requests (
  symbol       text primary key,
  status       text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users(id) on delete set null,
  finished_at  timestamptz,
  last_error   text
);

alter table public.fundamentals_requests enable row level security;

drop policy if exists "fundamentals_requests_read" on public.fundamentals_requests;
create policy "fundamentals_requests_read" on public.fundamentals_requests
  for select to authenticated using (true);

revoke all on public.fundamentals_requests from anon, authenticated;
grant select (symbol, status, requested_at, finished_at) on public.fundamentals_requests to authenticated;
grant all on public.fundamentals_requests to service_role;

create index if not exists fundamentals_requests_by_user on public.fundamentals_requests (requested_by, requested_at desc);

-- When the nightly job last TRIED a symbol (success or not). fetched_at stays the time of the
-- last good data; retries of a symbol without statements are spaced from this instead.
alter table public.company_fundamentals add column if not exists last_attempt_at timestamptz;

-- Atomically reserve symbols for one user's on-demand request.
-- * One reservation at a time per user (advisory lock), so parallel calls cannot both pass
--   the hourly quota.
-- * A symbol is reserved only if no run is pending for it (or the pending one is older than
--   30 minutes) and its last run finished more than a day ago — concurrent calls for the same
--   company start one run.
-- Returns the reserved symbols; empty when nothing is due. Raises 'rate_limited' over quota.
create or replace function public.reserve_fundamentals_requests(p_user uuid, p_symbols text[], p_hourly_limit int default 30)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  used int;
  reserved text[] := '{}';
  s text;
begin
  perform pg_advisory_xact_lock(hashtext('fundamentals_requests:' || p_user::text));
  select count(*) into used from fundamentals_requests
    where requested_by = p_user and requested_at > now() - interval '1 hour';
  if used + coalesce(array_length(p_symbols, 1), 0) > p_hourly_limit then
    raise exception 'rate_limited';
  end if;
  foreach s in array p_symbols loop
    insert into fundamentals_requests as r (symbol, status, requested_at, requested_by, finished_at, last_error)
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

-- Release a reservation whose workflow could not be started, so the next call may retry.
create or replace function public.release_fundamentals_requests(p_symbols text[])
returns void language sql security definer set search_path = public as $$
  delete from fundamentals_requests where symbol = any(p_symbols) and status = 'pending';
$$;
revoke all on function public.release_fundamentals_requests(text[]) from public, anon, authenticated;
grant execute on function public.release_fundamentals_requests(text[]) to service_role;
