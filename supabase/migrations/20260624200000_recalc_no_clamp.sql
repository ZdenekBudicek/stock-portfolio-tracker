-- Remove the GREATEST(0, ...) clamp in recalc_position so the stored shares equal the
-- true signed net of transactions. The clamp (combined with same-timestamp ordering)
-- made reconciliation adjustments overshoot. Real order sequences never oversell, so
-- the clamp only caused inaccuracy; a true net lets broker reconciliation be exact.
create or replace function public.recalc_position(p_ticker text, p_user_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  t record; cur_shares numeric := 0; cur_cost numeric := 0; avg numeric := 0; start_date date := null;
begin
  if upper(p_ticker) = 'CASH' then return; end if;
  for t in
    select * from public.transactions where ticker = p_ticker and user_id = p_user_id
    order by executed_at asc, created_at asc
  loop
    if t.side = 'BUY' then
      cur_cost := cur_cost + t.shares * t.price_usd;
      cur_shares := cur_shares + t.shares;
      if start_date is null then start_date := t.executed_at::date; end if;
    elsif t.side = 'SELL' then
      if cur_shares > 0 then
        cur_cost := cur_cost - (cur_cost * (least(t.shares, cur_shares) / cur_shares));
      end if;
      cur_shares := cur_shares - t.shares;
      if cur_shares <= 1e-9 then cur_cost := 0; end if;
    end if;
  end loop;
  if cur_shares > 1e-9 then avg := cur_cost / cur_shares; else avg := 0; cur_shares := greatest(cur_shares, 0); end if;

  if exists (select 1 from public.positions where ticker = p_ticker and user_id = p_user_id) then
    update public.positions set shares = cur_shares, avg_cost_usd = avg, holding_start_date = start_date, updated_at = now()
      where ticker = p_ticker and user_id = p_user_id;
  else
    if cur_shares > 1e-9 then
      insert into public.positions (ticker, name, type, shares, avg_cost_usd, holding_start_date, user_id)
      values (p_ticker, p_ticker, 'Stock', cur_shares, avg, start_date, p_user_id);
    end if;
  end if;
end; $function$;
