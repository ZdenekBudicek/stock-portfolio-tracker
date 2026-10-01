-- T212 sync mirrors positions via synthetic transactions (ext_id 't212:pos:%').
-- These represent holdings, not real cash movements, so they must NOT move CASH.
create or replace function public.apply_transaction_cash_change()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare wanted_delta numeric := 0; applied_delta numeric := 0;
begin
  if tg_op = 'DELETE' then
    if old.ext_id like 't212:pos:%' then return old; end if;
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied, 0));
    return old;
  end if;

  if new.user_id is null then new.user_id := auth.uid(); end if;

  -- Position-mirror rows: never touch cash.
  if new.ext_id like 't212:pos:%' then
    new.cash_delta_applied := 0;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied, 0));
  end if;

  wanted_delta := public.transaction_cash_delta(new.ticker, new.side, new.shares, new.price_usd, new.fee_usd);
  applied_delta := public.apply_cash_delta(new.user_id, wanted_delta);
  new.cash_delta_applied := applied_delta;
  return new;
end; $fn$;
