-- Global, shared ticker-rename map so ANY broker ticker auto-resolves to the
-- current price-provider symbol. Keyed by the broker's base ticker; isin is the
-- permanent identifier used to resolve it (via OpenFIGI). Populated once per
-- instrument and reused across every user.
create table if not exists public.ticker_alias (
  alias       text primary key,            -- broker base ticker (e.g. "FB", "IPOE")
  canonical   text not null,               -- current ticker our price providers know (e.g. "META")
  isin        text,                         -- permanent instrument id used to resolve it
  name        text,
  source      text default 'openfigi',
  updated_at  timestamptz default now()
);

alter table public.ticker_alias enable row level security;

-- Non-sensitive reference data: any authenticated user may read; only the
-- service role (used by the sync edge function) writes.
drop policy if exists "ticker_alias_read" on public.ticker_alias;
create policy "ticker_alias_read" on public.ticker_alias for select to authenticated using (true);

-- Seed the handful of legacy renames we already know, as a fallback in case
-- OpenFIGI is unavailable for them.
insert into public.ticker_alias (alias, canonical, source) values
  ('IPOE', 'SOFI', 'seed'),
  ('VACQ', 'RKLB', 'seed'),
  ('FB',   'META', 'seed'),
  ('FBA',  'META', 'seed')
on conflict (alias) do nothing;
