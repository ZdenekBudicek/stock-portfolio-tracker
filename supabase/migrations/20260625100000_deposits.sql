-- Dated external cash flows (deposits/withdrawals) per broker. Separate from
-- transactions so it never interferes with cash balance or positions. Statement
-- importers write here (Revolut top-ups, XTB cash-in); the app reads it for the
-- per-year deposits in Roční zhodnocení and the deposit baseline of the chart.
create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text,
  flow_date date not null,
  amount_usd numeric not null,        -- + deposit, - withdrawal
  source text,
  ext_id text,                         -- dedupe key per broker
  created_at timestamptz default now()
);
alter table public.deposits enable row level security;
drop policy if exists deposits_own on public.deposits;
create policy deposits_own on public.deposits for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create unique index if not exists deposits_user_extid_uniq on public.deposits(user_id, ext_id) where ext_id is not null;
create index if not exists deposits_user_date_idx on public.deposits(user_id, flow_date);
