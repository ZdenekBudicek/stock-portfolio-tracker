-- apply_split restates earlier trades by the split ratio. A broker statement (Revolut) may
-- already carry THIS split as its own $0 increment row (ext_id '…:split:<TICKER>:<date>'),
-- and restating that account's buys as well counted the split twice (1 share + 3:1 → 3 + 2).
--  - Coverage is per account: only the accounts (broker + broker_account) that have an
--    increment row around this split's date are left as they are; every other account's
--    earlier trades (XTB, manual, …) are restated as before.
--  - Increment rows of OLDER splits are ordinary pre-split shares now and are restated too.
--  - The position is rebuilt from the ledger (the transaction trigger does it per row; the
--    explicit call covers a split where nothing needed restating). A position without any
--    transactions keeps the old direct restatement.
create or replace function public.apply_split(split_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare s record; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'auth required'; end if;
  select * into s from public.splits where id = split_id and user_id = uid and status = 'pending';
  if not found then raise exception 'Split not found or already processed'; end if;

  if not exists (select 1 from public.transactions where user_id = uid and ticker = s.ticker) then
    update public.positions
      set shares = shares * s.ratio, avg_cost_usd = avg_cost_usd / s.ratio, updated_at = now()
      where ticker = s.ticker and ticker <> 'CASH' and user_id = uid;
  else
    update public.transactions t
      set shares = t.shares * s.ratio, price_usd = t.price_usd / s.ratio
      where t.ticker = s.ticker and t.user_id = uid and t.executed_at::date < s.split_date
        and not exists (
          select 1 from public.transactions c
          where c.user_id = uid and c.ticker = s.ticker and c.ext_id like '%:split:%'
            and c.executed_at::date between s.split_date - 10 and s.split_date + 10
            and c.broker is not distinct from t.broker
            and c.broker_account is not distinct from t.broker_account
        );
    perform public.recalc_position(s.ticker, uid);
  end if;

  update public.splits set status = 'applied', applied_at = now() where id = split_id and user_id = uid;
end;
$function$;
