-- Broker tagging on transactions
alter table public.transactions add column if not exists broker text not null default 'manual';
alter table public.transactions add column if not exists t212_id text;
create unique index if not exists ux_transactions_user_t212 on public.transactions(user_id, t212_id) where t212_id is not null;

-- Cash: allow true running balance (remove the zero-clamp that silently swallowed buys)
create or replace function public.apply_cash_delta(p_user_id uuid, p_delta numeric)
returns numeric language plpgsql security definer set search_path to 'public' as $fn$
declare current_cash numeric := 0;
begin
  if p_user_id is null or coalesce(p_delta,0) = 0 then return 0; end if;
  select shares into current_cash from public.positions where ticker='CASH' and user_id=p_user_id for update;
  if not found then
    insert into public.positions (ticker,name,type,shares,avg_cost_usd,user_id)
    values ('CASH','Cash Balance','Cash',p_delta,1,p_user_id);
    return p_delta;
  end if;
  update public.positions set shares = coalesce(current_cash,0) + p_delta, avg_cost_usd=1, updated_at=now()
    where ticker='CASH' and user_id=p_user_id;
  return p_delta;
end; $fn$;

-- Dividends -> cash when status is 'paid' (idempotent via cash_delta_applied)
alter table public.dividends add column if not exists cash_delta_applied numeric not null default 0;

create or replace function public.apply_dividend_cash_change()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare wanted numeric := 0;
begin
  if tg_op = 'DELETE' then
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied,0));
    return old;
  end if;
  if new.user_id is null then new.user_id := auth.uid(); end if;
  if tg_op = 'UPDATE' then
    perform public.apply_cash_delta(old.user_id, -coalesce(old.cash_delta_applied,0));
  end if;
  if new.status = 'paid' then
    wanted := coalesce(new.total_amount_usd, new.amount_per_share * coalesce(new.shares_held,0));
  else
    wanted := 0;
  end if;
  perform public.apply_cash_delta(new.user_id, wanted);
  new.cash_delta_applied := wanted;
  return new;
end; $fn$;

drop trigger if exists trg_apply_dividend_cash on public.dividends;
create trigger trg_apply_dividend_cash before insert or update or delete on public.dividends
  for each row execute function public.apply_dividend_cash_change();
