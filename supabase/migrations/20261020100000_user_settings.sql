-- Per-user settings, starting with the tax residence that decides which tax rules the app
-- applies. The whole tax layer (3-year time test, 100 000 Kč limit, ČNB rates, FIFO per
-- account) is Czech; a user taxed elsewhere gets a neutral realized-gains view instead.
--
-- tax_residence: ISO 3166-1 alpha-2 of a supported jurisdiction ('CZ') or 'OTHER'.
--   It is chosen by the user — never derived from the UI language (an English UI user can
--   be a Czech tax resident and vice versa).
-- base_currency: the reporting currency of the neutral view ('USD' | 'CZK' — the two the
--   app has rate history for).
-- confirmed_at: when the user answered the first-login question. NULL = never asked;
--   existing users are backfilled as confirmed Czech residents (the app has only ever
--   applied Czech rules to them), so nothing changes for them.
create table if not exists public.user_settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  tax_residence text not null default 'CZ'
    check (tax_residence ~ '^([A-Z]{2}|OTHER)$'),
  base_currency text not null default 'CZK'
    check (base_currency in ('USD', 'CZK')),
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.user_settings enable row level security;

-- A user reads and writes only their own row.
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.user_settings to authenticated;

create or replace function public.user_settings_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.user_settings_touch();

-- Existing users: Czech residents, already confirmed (no first-login question for them).
insert into public.user_settings (user_id, tax_residence, base_currency, confirmed_at)
select id, 'CZ', 'CZK', now() from auth.users
on conflict (user_id) do nothing;
