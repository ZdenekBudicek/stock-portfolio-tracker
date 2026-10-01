-- Make `splits` per-user. Previously it was a global table with a single
-- "Public read" (USING true) policy and no per-user scoping, so apply_split /
-- dismiss_split changed a split's status globally — the first user to act on a
-- detected split resolved it for everyone. Now each user has their own row and
-- their own pending/applied/dismissed state.

alter table public.splits add column if not exists user_id uuid;
update public.splits set user_id = auth.uid() where user_id is null; -- 0 rows at migration time
alter table public.splits alter column user_id set default auth.uid();
alter table public.splits alter column user_id set not null;

drop trigger if exists trg_set_user_id_splits on public.splits;
create trigger trg_set_user_id_splits before insert on public.splits
  for each row execute function public.set_user_id_default();

-- RLS: replace global read with per-user CRUD
drop policy if exists "Public read splits" on public.splits;
create policy "splits_select_own" on public.splits for select using (auth.uid() = user_id);
create policy "splits_insert_own" on public.splits for insert with check (auth.uid() = user_id);
create policy "splits_update_own" on public.splits for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "splits_delete_own" on public.splits for delete using (auth.uid() = user_id);

-- Scope apply/dismiss to the caller's own split row.
create or replace function public.apply_split(split_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare s record; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'auth required'; end if;
  select * into s from public.splits where id = split_id and user_id = uid and status = 'pending';
  if not found then raise exception 'Split not found or already processed'; end if;
  update public.positions
    set shares = shares * s.ratio, avg_cost_usd = avg_cost_usd / s.ratio, updated_at = now()
    where ticker = s.ticker and ticker <> 'CASH' and user_id = uid;
  update public.transactions
    set shares = shares * s.ratio, price_usd = price_usd / s.ratio
    where ticker = s.ticker and user_id = uid and executed_at::date < s.split_date;
  update public.splits set status = 'applied', applied_at = now() where id = split_id and user_id = uid;
end; $function$;

create or replace function public.dismiss_split(split_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is null then raise exception 'auth required'; end if;
  update public.splits set status = 'dismissed'
    where id = split_id and user_id = auth.uid() and status = 'pending';
end; $function$;
