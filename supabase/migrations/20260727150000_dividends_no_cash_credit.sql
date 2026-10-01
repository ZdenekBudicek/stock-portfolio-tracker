-- Dividends must NOT credit the synthetic CASH balance.
--
-- CASH is mirrored authoritatively from each broker's live free-cash figure
-- (syncCashFromApi), and dividends that were reinvested already appear as buy transactions.
-- Crediting every 'paid' dividend to CASH on top of that double-counted and inflated the
-- balance without bound — seen: CASH showed $103 while the user's real free cash across
-- brokers was ~$0.43. The T212 API path already imported dividends with cash_delta_applied=0
-- (via import_broker_dividends under app.bulk_import); the statement/manual/Revolut/XTB paths
-- went through a plain INSERT and the trigger credited them. This makes the rule uniform:
-- no dividend, on any path, moves CASH.
--
-- The DELETE / UPDATE branches still REVERSE any legacy credit (old.cash_delta_applied),
-- so removing or editing an old dividend cleanly unwinds the cash it once added.
create or replace function public.apply_dividend_cash_change()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  -- Bulk import (statement/API dividend loads): never touch cash, just stamp 0.
  if current_setting('app.bulk_import', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    if new.user_id is null then new.user_id := auth.uid(); end if;
    new.cash_delta_applied := 0;
    return new;
  end if;
  if tg_op = 'DELETE' then
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied, 0));
    return old;
  end if;
  if new.user_id is null then new.user_id := auth.uid(); end if;
  -- Reverse any credit a prior version of this row had applied; add nothing new.
  if tg_op = 'UPDATE' and coalesce(old.cash_delta_applied, 0) <> 0 then
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied, 0));
  end if;
  new.cash_delta_applied := 0;
  return new;
end; $fn$;
