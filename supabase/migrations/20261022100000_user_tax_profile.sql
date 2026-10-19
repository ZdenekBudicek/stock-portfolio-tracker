-- Inputs a country's tax estimate needs beyond the trades themselves (e.g. US filing status
-- and other taxable income, German church tax). Validated by the app per jurisdiction
-- (src/lib/tax/*); stored as JSON so a new country needs no schema change. The row is the
-- user's own (existing RLS on user_settings: select/insert/update only where user_id = auth.uid()).
alter table public.user_settings add column if not exists tax_profile jsonb not null default '{}'::jsonb;
alter table public.user_settings drop constraint if exists user_settings_tax_profile_object;
alter table public.user_settings add constraint user_settings_tax_profile_object check (jsonb_typeof(tax_profile) = 'object');
