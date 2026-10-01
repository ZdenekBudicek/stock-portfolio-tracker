-- Authoritative current holdings per broker (shares + avg cost) straight from the
-- broker API/statement. Used so each position's cost basis matches what the broker
-- shows — T212 exposes averagePrice incl. full history (older/SPAC lots) that its
-- /history/orders endpoint omits, so trade-replay alone understates/overstates cost.
create table if not exists public.broker_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null,
  ticker text not null,
  shares numeric not null,
  avg_price_usd numeric,
  updated_at timestamptz default now()
);
alter table public.broker_holdings enable row level security;
drop policy if exists broker_holdings_own on public.broker_holdings;
create policy broker_holdings_own on public.broker_holdings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create unique index if not exists broker_holdings_uniq on public.broker_holdings(user_id, broker, ticker);
