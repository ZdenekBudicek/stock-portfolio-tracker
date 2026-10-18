-- Shared reference data, written only by the service-role nightly worker.
create table if not exists public.company_fundamentals (
  symbol text primary key,
  data jsonb not null,
  currency text,
  fetched_at timestamptz not null default now(),
  status text not null default 'ok',
  last_error text
);

alter table public.company_fundamentals enable row level security;

drop policy if exists "company_fundamentals_read" on public.company_fundamentals;
create policy "company_fundamentals_read" on public.company_fundamentals
  for select to authenticated using (true);

-- No client write policies; service_role bypasses RLS.
grant select on public.company_fundamentals to authenticated;
grant all on public.company_fundamentals to service_role;
