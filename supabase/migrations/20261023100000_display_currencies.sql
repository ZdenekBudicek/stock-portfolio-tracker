-- base_currency is the user's default display currency: besides dollars and koruny also euro,
-- pound and złoty (the app converts them through the ČNB cross rate of each day).
alter table public.user_settings drop constraint if exists user_settings_base_currency_check;
alter table public.user_settings
  add constraint user_settings_base_currency_check
  check (base_currency in ('USD', 'CZK', 'EUR', 'GBP', 'PLN'));
