-- Bulk import path: a session flag `app.bulk_import='on'` makes the per-row triggers
-- skip, then the import function recalculates each affected ticker once at the end.
-- Avoids O(n^2) recalculation when importing thousands of broker orders.

create or replace function public.on_transaction_change()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if current_setting('app.bulk_import', true) = 'on' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    perform public.recalc_position(old.ticker, old.user_id);
    return old;
  elsif tg_op = 'UPDATE' then
    if new.ticker <> old.ticker or new.user_id <> old.user_id then
      perform public.recalc_position(old.ticker, old.user_id);
    end if;
    perform public.recalc_position(new.ticker, new.user_id);
    return new;
  else
    perform public.recalc_position(new.ticker, new.user_id);
    return new;
  end if;
end; $fn$;

create or replace function public.apply_transaction_cash_change()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare wanted_delta numeric := 0; applied_delta numeric := 0;
begin
  if current_setting('app.bulk_import', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    if new.user_id is null then new.user_id := auth.uid(); end if;
    new.cash_delta_applied := 0;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.ext_id is not null then return old; end if;
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied, 0));
    return old;
  end if;
  if new.user_id is null then new.user_id := auth.uid(); end if;
  if new.ext_id is not null then new.cash_delta_applied := 0; return new; end if;
  if tg_op = 'UPDATE' then
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied, 0));
  end if;
  wanted_delta := public.transaction_cash_delta(new.ticker, new.side, new.shares, new.price_usd, new.fee_usd);
  applied_delta := public.apply_cash_delta(new.user_id, wanted_delta);
  new.cash_delta_applied := applied_delta;
  return new;
end; $fn$;

-- Bulk replace a broker's imported rows in one fast transaction.
create or replace function public.import_broker_transactions(p_user_id uuid, p_broker text, p_rows jsonb)
returns int language plpgsql security definer set search_path to 'public' as $fn$
declare tk text; n int;
begin
  perform set_config('app.bulk_import', 'on', true);
  delete from public.transactions where user_id = p_user_id and broker = p_broker and ext_id like (lower(p_broker) || ':%');
  insert into public.transactions (ticker, side, shares, price_usd, fee_usd, executed_at, broker, ext_id, user_id, note, cash_delta_applied)
  select r.ticker, r.side, r.shares, r.price_usd, coalesce(r.fee_usd, 0), r.executed_at::timestamptz, p_broker, r.ext_id, p_user_id, r.note, 0
  from jsonb_to_recordset(p_rows) as r(ticker text, side text, shares numeric, price_usd numeric, fee_usd numeric, executed_at text, ext_id text, note text);
  get diagnostics n = row_count;
  perform set_config('app.bulk_import', 'off', true);
  for tk in select distinct ticker from public.transactions where user_id = p_user_id and broker = p_broker and ticker <> 'CASH' loop
    perform public.recalc_position(tk, p_user_id);
  end loop;
  return n;
end; $fn$;

revoke all on function public.import_broker_transactions(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_broker_transactions(uuid, text, jsonb) to service_role;
