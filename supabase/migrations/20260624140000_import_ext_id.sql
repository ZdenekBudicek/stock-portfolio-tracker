-- Idempotency keys for statement / broker imports.
alter table public.transactions add column if not exists ext_id text;
create unique index if not exists ux_transactions_user_broker_ext
  on public.transactions(user_id, broker, ext_id) where ext_id is not null;

alter table public.dividends add column if not exists broker text not null default 'manual';
alter table public.dividends add column if not exists ext_id text;
create unique index if not exists ux_dividends_user_broker_ext
  on public.dividends(user_id, broker, ext_id) where ext_id is not null;
