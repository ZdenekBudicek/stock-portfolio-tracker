-- Connecting credentials is an explicit account choice. Never resume the previous key's history.
create or replace function public.set_broker_connection(p_broker text, p_env text, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare uid uuid := auth.uid(); enc_key text;
begin
  if uid is null then raise exception 'auth required'; end if;
  if p_broker <> 'T212' or coalesce(p_env, 'live') not in ('live', 'demo') then
    raise exception 'unsupported broker or environment';
  end if;
  select decrypted_secret into enc_key from vault.decrypted_secrets where name = 'broker_enc_key' limit 1;
  insert into public.broker_connections as bc (user_id, broker, environment, api_key_encrypted, status)
  values (uid, p_broker, coalesce(p_env, 'live'), extensions.pgp_sym_encrypt(p_key, enc_key), 'connected')
  on conflict (user_id, broker) do update
    set environment = excluded.environment,
        api_key_encrypted = excluded.api_key_encrypted,
        account_id = null,
        last_sync_cursor = null,
        last_sync_at = null,
        account_summary = null,
        cash_base_free_usd = null,
        cash_sync_state = null,
        status = 'connected';
  return pg_catalog.jsonb_build_object('ok', true, 'broker', p_broker, 'environment', coalesce(p_env, 'live'));
end; $fn$;
revoke all on function public.set_broker_connection(text, text, text) from public, anon;
grant execute on function public.set_broker_connection(text, text, text) to authenticated;

-- Also cover a confirmed account switch made by either sync path. No ledger rows are deleted.
create or replace function public.reset_broker_account_state()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.environment is distinct from old.environment
     or new.account_id is distinct from old.account_id then
    new.last_sync_cursor := null;
    new.last_sync_at := null;
    new.account_summary := null;
    new.cash_base_free_usd := null;
    new.cash_sync_state := null;
  end if;
  return new;
end; $fn$;
revoke all on function public.reset_broker_account_state() from public, anon;
create trigger reset_broker_account_state before update on public.broker_connections
for each row execute function public.reset_broker_account_state();
