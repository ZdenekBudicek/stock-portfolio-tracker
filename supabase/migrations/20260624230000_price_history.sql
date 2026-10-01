-- Shared daily price history (symbols are universal -> fetched once, reused by all users).
-- Filled by a resumable Twelve Data backfill + the daily refresh cron. Used to reconstruct
-- each user's daily_snapshots cheaply (no per-user external calls).
create table if not exists public.price_history (
  symbol text not null,
  date date not null,
  close numeric not null,
  primary key (symbol, date)
);
alter table public.price_history enable row level security;
create policy "price_history read (authenticated)" on public.price_history for select using (auth.role() = 'authenticated');
-- writes only via service role (bypasses RLS)

create index if not exists idx_price_history_symbol on public.price_history(symbol);
