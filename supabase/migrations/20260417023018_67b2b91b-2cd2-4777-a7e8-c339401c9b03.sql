-- Enable required extensions for cron
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- POSITIONS
create table public.positions (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  name text not null,
  type text not null default 'Stock',
  shares numeric not null default 0,
  avg_cost_usd numeric not null default 0,
  sector text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- TRANSACTIONS
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  side text not null check (side in ('BUY','SELL')),
  shares numeric not null,
  price_usd numeric not null,
  fee_usd numeric not null default 0,
  executed_at timestamptz not null,
  note text,
  created_at timestamptz not null default now()
);
create index idx_transactions_ticker on public.transactions(ticker);
create index idx_transactions_executed on public.transactions(executed_at desc);

-- DAILY SNAPSHOTS
create table public.daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null unique,
  value_usd numeric not null,
  value_czk numeric not null,
  profit_usd numeric not null default 0,
  profit_pct numeric not null default 0,
  profit_czk numeric not null default 0,
  fx_rate numeric not null,
  created_at timestamptz not null default now()
);
create index idx_snapshots_date on public.daily_snapshots(snapshot_date desc);

-- PRICE CACHE
create table public.price_cache (
  symbol text primary key, -- ticker or 'USDCZK'
  price numeric not null,
  prev_close numeric,
  change_pct numeric,
  fetched_at timestamptz not null default now()
);

-- Enable RLS
alter table public.positions enable row level security;
alter table public.transactions enable row level security;
alter table public.daily_snapshots enable row level security;
alter table public.price_cache enable row level security;

-- Public read (single-user app, no auth yet)
create policy "Public read positions" on public.positions for select using (true);
create policy "Public read transactions" on public.transactions for select using (true);
create policy "Public read snapshots" on public.daily_snapshots for select using (true);
create policy "Public read price_cache" on public.price_cache for select using (true);

-- Public insert/update/delete for transactions (single-user app)
create policy "Public insert transactions" on public.transactions for insert with check (true);
create policy "Public update transactions" on public.transactions for update using (true);
create policy "Public delete transactions" on public.transactions for delete using (true);

-- Public insert/update positions (managed via UI)
create policy "Public insert positions" on public.positions for insert with check (true);
create policy "Public update positions" on public.positions for update using (true);
create policy "Public delete positions" on public.positions for delete using (true);

-- Updated_at trigger
create or replace function public.update_updated_at_column()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_positions_updated
before update on public.positions
for each row execute function public.update_updated_at_column();