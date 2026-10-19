-- Mirror a Trading 212 account's free cash into CASH atomically.
--
-- syncCashFromApi (supabase/functions/_shared/t212.ts) used three separate calls: read
-- broker_connections.cash_base_free_usd, apply_cash_delta(free − base), write the new base.
-- The cron (auto-sync) and a manual sync (sync-broker) can run at the same moment for the same
-- user; both read the same base and both applied the same delta, so the change in cash was
-- counted twice. This function does the whole step under a per-user advisory lock in one
-- transaction: the second caller waits, then sees the base the first one stored and applies
-- only what is left (normally nothing).
--
-- Semantics are exactly those of the old client-side code:
--   * no base yet  → delta = free − current CASH (first sync adopts the API value)
--   * base known   → delta = free − base         (later syncs accrue only the change)
--   * |delta| ≤ 0.005 → cash untouched; the base is always moved to the new free value.
-- Returns the delta it computed (applied or not). Service role only.
--
-- The edge functions fall back to the old unlocked path while this function is missing, so
-- deploying functions and migration in either order is safe.

-- Exists in production (added by hand); recorded again here so the function below always has
-- its column. Idempotent.
alter table public.broker_connections add column if not exists cash_base_free_usd numeric;

create or replace function public.sync_t212_cash(p_user_id uuid, p_free_usd numeric)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_base numeric;
  v_cash numeric;
  v_delta numeric;
begin
  if p_user_id is null or p_free_usd is null then
    return null;
  end if;

  -- Serialize every cash mirror of this user (cron + manual sync) until commit.
  perform pg_advisory_xact_lock(hashtext('sync_t212_cash:' || p_user_id::text));

  select cash_base_free_usd into v_base
    from public.broker_connections
   where user_id = p_user_id and broker = 'T212'
   limit 1;

  if v_base is null then
    select shares into v_cash from public.positions
     where user_id = p_user_id and ticker = 'CASH'
     limit 1;
    v_delta := p_free_usd - coalesce(v_cash, 0);
  else
    v_delta := p_free_usd - v_base;
  end if;

  if abs(v_delta) > 0.005 then
    perform public.apply_cash_delta(p_user_id, v_delta);
  end if;

  update public.broker_connections
     set cash_base_free_usd = p_free_usd
   where user_id = p_user_id and broker = 'T212';

  return v_delta;
end;
$fn$;

revoke all on function public.sync_t212_cash(uuid, numeric) from public, anon, authenticated;
grant execute on function public.sync_t212_cash(uuid, numeric) to service_role;
