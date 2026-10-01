-- Authoritative per-broker account figures pulled straight from the broker API
-- (T212 /equity/account/cash + /info). Lets us compute the TRUE return and net
-- deposits without unreliable trade/flow inference. Stored in the account's base
-- currency; the app converts to the display currency.
alter table public.broker_connections add column if not exists account_summary jsonb;
