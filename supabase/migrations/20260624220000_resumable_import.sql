-- Resumable import: insert a batch of broker order rows fast (triggers skipped),
-- optionally replacing first / deferring recalc to the final reconcile pass.
create or replace function public.import_broker_transactions(
  p_user_id uuid, p_broker text, p_rows jsonb,
  p_replace boolean default true, p_recalc boolean default true)
returns int language plpgsql security definer set search_path to 'public' as $fn$
declare tk text; n int;
begin
  perform set_config('app.bulk_import', 'on', true);
  if p_replace then
    delete from public.transactions where user_id = p_user_id and broker = p_broker and ext_id like (lower(p_broker) || ':%');
  end if;
  insert into public.transactions (ticker, side, shares, price_usd, fee_usd, executed_at, broker, ext_id, user_id, note, cash_delta_applied)
  select r.ticker, r.side, r.shares, r.price_usd, coalesce(r.fee_usd, 0), r.executed_at::timestamptz, p_broker, r.ext_id, p_user_id, r.note, 0
  from jsonb_to_recordset(p_rows) as r(ticker text, side text, shares numeric, price_usd numeric, fee_usd numeric, executed_at text, ext_id text, note text)
  on conflict (user_id, broker, ext_id) do nothing;
  get diagnostics n = row_count;
  perform set_config('app.bulk_import', 'off', true);
  if p_recalc then
    for tk in select distinct ticker from public.transactions where user_id = p_user_id and broker = p_broker and ticker <> 'CASH' loop
      perform public.recalc_position(tk, p_user_id);
    end loop;
  end if;
  return n;
end; $fn$;

revoke all on function public.import_broker_transactions(uuid, text, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.import_broker_transactions(uuid, text, jsonb, boolean, boolean) to service_role;
