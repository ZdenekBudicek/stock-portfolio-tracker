-- Cheap in-app reconcile: given the broker's current holdings (from its API/snapshot),
-- recompute the per-ticker adjustment so (imported orders + adjustment) == holdings,
-- without re-pulling the full order history. Keeps dated history + exact positions.
create or replace function public.reconcile_broker_to_portfolio(p_user_id uuid, p_broker text, p_holdings jsonb)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare tk text; onet numeric; tgt numeric; d numeric; pfx text := lower(p_broker);
begin
  perform set_config('app.bulk_import', 'on', true);
  delete from public.transactions where user_id = p_user_id and broker = p_broker and ext_id like (pfx || ':adj:%');

  for tk in
    select distinct ticker from public.transactions
      where user_id = p_user_id and broker = p_broker and ext_id like (pfx || ':ord:%')
    union
    select h->>'ticker' from jsonb_array_elements(p_holdings) h
  loop
    select coalesce(sum(case when side = 'BUY' then shares else -shares end), 0) into onet
      from public.transactions
      where user_id = p_user_id and broker = p_broker and ticker = tk and ext_id like (pfx || ':ord:%');
    select coalesce((select (h->>'qty')::numeric from jsonb_array_elements(p_holdings) h where h->>'ticker' = tk), 0) into tgt;
    d := tgt - onet;
    if abs(d) > 1e-4 then
      insert into public.transactions (ticker, side, shares, price_usd, fee_usd, executed_at, broker, ext_id, user_id, note, cash_delta_applied)
      values (tk, case when d > 0 then 'BUY' else 'SELL' end, abs(d),
        coalesce((select (h->>'avg')::numeric from jsonb_array_elements(p_holdings) h where h->>'ticker' = tk), 0),
        0, now(), p_broker, pfx || ':adj:' || tk, p_user_id, 'Úprava (dividendy/splity)', 0);
    end if;
  end loop;

  perform set_config('app.bulk_import', 'off', true);
  for tk in select distinct ticker from public.transactions where user_id = p_user_id and broker = p_broker and ticker <> 'CASH' loop
    perform public.recalc_position(tk, p_user_id);
  end loop;
end; $fn$;

revoke all on function public.reconcile_broker_to_portfolio(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_broker_to_portfolio(uuid, text, jsonb) to service_role;
