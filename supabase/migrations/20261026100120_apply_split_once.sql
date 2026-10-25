-- Audit B7: a split is applied exactly once.
--  - apply_split claims the pending row (FOR UPDATE, then re-checks its status) and serializes per user and
--    ticker, so two confirmations at once cannot both restate the trades by the ratio.
--  - One split row per user, ticker and day: pending duplicates beside another row for the same split are
--    removed (never an applied or dismissed one), then a unique index keeps detect-splits from adding more.
--    The index is required (detect-splits upserts on it): if applied/dismissed duplicates remain, the
--    migration stops with the list to review instead of half-applying.
do $$
begin
  delete from public.splits d
    where d.status = 'pending' and exists (
      select 1 from public.splits o
      where o.user_id = d.user_id and o.ticker = d.ticker and o.split_date = d.split_date and o.id <> d.id
        and (o.status <> 'pending' or o.created_at < d.created_at or (o.created_at = d.created_at and o.id < d.id)));
  if exists (select 1 from public.splits group by user_id, ticker, split_date having count(*) > 1) then
    raise exception 'splits: duplicate applied/dismissed rows for %; review them (a split may have been applied twice) and rerun',
      (select string_agg(distinct ticker || ' ' || split_date, ', ') from (select ticker, split_date from public.splits
        group by user_id, ticker, split_date having count(*) > 1) d);
  end if;
  create unique index if not exists splits_one_per_user_day on public.splits(user_id, ticker, split_date);
end;
$$;

create or replace function public.apply_split(split_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare s record; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'auth required'; end if;
  select * into s from public.splits where id = split_id and user_id = uid;
  if not found then raise exception 'Split not found or already processed'; end if;
  -- One restatement of this user's ticker at a time, then the row itself is claimed and checked again.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || ':' || s.ticker, 20261026));
  select * into s from public.splits where id = split_id and user_id = uid for update;
  if not found or s.status <> 'pending' then raise exception 'Split not found or already processed'; end if;

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
