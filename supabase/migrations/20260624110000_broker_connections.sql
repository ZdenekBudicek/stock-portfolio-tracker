create extension if not exists pgcrypto;

create table if not exists public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  broker text not null,
  environment text not null default 'live',
  api_key_encrypted bytea,
  last_sync_cursor text,
  last_sync_at timestamptz,
  status text,
  created_at timestamptz not null default now(),
  unique (user_id, broker)
);
alter table public.broker_connections enable row level security;
-- No direct client access; everything goes through the SECURITY DEFINER RPCs below.
revoke all on public.broker_connections from anon, authenticated;

-- Vault master key (idempotent): create a random 32-byte key once if missing.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'broker_enc_key') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'broker_enc_key', 'symmetric key for broker api keys');
  end if;
end $$;

-- Save / replace a connection. Encrypts the key with the Vault master key (read inline; not exposed).
create or replace function public.set_broker_connection(p_broker text, p_env text, p_key text)
returns jsonb language plpgsql security definer set search_path to 'public', 'vault' as $fn$
declare uid uuid := auth.uid(); enc_key text;
begin
  if uid is null then raise exception 'auth required'; end if;
  select decrypted_secret into enc_key from vault.decrypted_secrets where name = 'broker_enc_key' limit 1;
  insert into public.broker_connections (user_id, broker, environment, api_key_encrypted, status)
  values (uid, p_broker, coalesce(p_env, 'live'), pgp_sym_encrypt(p_key, enc_key), 'connected')
  on conflict (user_id, broker) do update
    set environment = excluded.environment,
        api_key_encrypted = excluded.api_key_encrypted,
        status = 'connected';
  return jsonb_build_object('ok', true, 'broker', p_broker, 'environment', coalesce(p_env, 'live'));
end; $fn$;

create or replace function public.get_broker_connection_status()
returns table(broker text, environment text, last_sync_at timestamptz, status text)
language sql security definer set search_path to 'public' as
$$ select broker, environment, last_sync_at, status from public.broker_connections where user_id = auth.uid() $$;

create or replace function public.delete_broker_connection(p_broker text)
returns void language sql security definer set search_path to 'public' as
$$ delete from public.broker_connections where user_id = auth.uid() and broker = p_broker $$;

-- Decrypt for the sync backend. NOT callable by clients (revoked below; granted to service_role only).
create or replace function public.get_broker_key(p_user_id uuid, p_broker text)
returns table(api_key text, environment text, last_sync_cursor text)
language plpgsql security definer set search_path to 'public', 'vault' as $fn$
declare enc_key text;
begin
  select decrypted_secret into enc_key from vault.decrypted_secrets where name = 'broker_enc_key' limit 1;
  return query
    select pgp_sym_decrypt(bc.api_key_encrypted, enc_key), bc.environment, bc.last_sync_cursor
    from public.broker_connections bc
    where bc.user_id = p_user_id and bc.broker = p_broker;
end; $fn$;

-- Client-callable management RPCs
grant execute on function public.set_broker_connection(text, text, text) to authenticated;
grant execute on function public.get_broker_connection_status() to authenticated;
grant execute on function public.delete_broker_connection(text) to authenticated;

-- Lock down the decrypt RPC: never callable by clients.
revoke all on function public.get_broker_key(uuid, text) from public, anon, authenticated;
grant execute on function public.get_broker_key(uuid, text) to service_role;
