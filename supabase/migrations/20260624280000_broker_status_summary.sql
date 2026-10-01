-- Expose account_summary through the existing security-definer status RPC so the
-- client can read its own broker summary without a direct select on broker_connections
-- (which has RLS and holds the encrypted API key — never exposed to the client).
drop function if exists public.get_broker_connection_status();
create function public.get_broker_connection_status()
returns table(broker text, environment text, last_sync_at timestamptz, status text, account_summary jsonb)
language sql
security definer
set search_path to 'public'
as $$
  select broker, environment, last_sync_at, status, account_summary
  from public.broker_connections
  where user_id = auth.uid()
$$;

grant execute on function public.get_broker_connection_status() to authenticated;
