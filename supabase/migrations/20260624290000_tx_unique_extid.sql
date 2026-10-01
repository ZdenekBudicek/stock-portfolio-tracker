-- Unique key for broker imports so import_broker_transactions' ON CONFLICT works
-- (it upserts on user_id+broker+ext_id). Without this the bulk import RPC errors out.
create unique index if not exists transactions_user_broker_extid_uniq
  on public.transactions(user_id, broker, ext_id);
