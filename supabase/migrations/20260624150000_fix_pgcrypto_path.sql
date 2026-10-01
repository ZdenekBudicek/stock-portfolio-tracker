-- pgcrypto lives in the `extensions` schema on Supabase; the broker key functions
-- had search_path 'public','vault' which excluded it -> "pgp_sym_encrypt does not exist".
-- Add 'extensions' to the path.

create or replace function public.set_broker_connection(p_broker text, p_env text, p_key text)
returns jsonb language plpgsql security definer set search_path to 'public', 'vault', 'extensions' as $fn$
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

create or replace function public.get_broker_key(p_user_id uuid, p_broker text)
returns table(api_key text, environment text, last_sync_cursor text)
language plpgsql security definer set search_path to 'public', 'vault', 'extensions' as $fn$
declare enc_key text;
begin
  select decrypted_secret into enc_key from vault.decrypted_secrets where name = 'broker_enc_key' limit 1;
  return query
    select pgp_sym_decrypt(bc.api_key_encrypted, enc_key), bc.environment, bc.last_sync_cursor
    from public.broker_connections bc
    where bc.user_id = p_user_id and bc.broker = p_broker;
end; $fn$;

revoke all on function public.get_broker_key(uuid, text) from public, anon, authenticated;
grant execute on function public.get_broker_key(uuid, text) to service_role;
