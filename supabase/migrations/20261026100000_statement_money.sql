alter table public.dividends
  add column if not exists gross_amount_usd numeric,
  add column if not exists withholding_tax_usd numeric,
  add column if not exists original_currency text,
  add column if not exists gross_amount numeric,
  add column if not exists withholding_tax numeric;

alter table public.deposits
  add column if not exists original_currency text,
  add column if not exists original_amount numeric;

-- A statement's API replacement and all replacement trades commit together.
create or replace function public.replace_statement_trades(
  p_account text, p_from timestamptz, p_before timestamptz,
  p_rows jsonb, p_corrections jsonb, p_adopt boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  uid uuid := auth.uid();
  r record;
  tk text;
  affected text[];
  inserted integer;
  corrected integer := 0;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if p_from is null or p_before is null or p_from >= p_before then raise exception 'Invalid statement period'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || ':T212', 0));
  perform pg_catalog.set_config('app.bulk_import', 'on', true);
  if p_adopt and p_account is not null then
    if exists (select 1 from public.transactions where user_id = uid and broker = 'T212' and broker_account <> p_account) then
      raise exception 'Ambiguous legacy account';
    end if;
    update public.transactions set broker_account = p_account where user_id = uid and broker = 'T212' and broker_account is null;
  end if;
  select pg_catalog.array_agg(distinct ticker) into affected from public.transactions where user_id = uid;
  delete from public.transactions where user_id = uid and broker = 'T212'
    and broker_account is not distinct from p_account and ext_id like 't212:ord:%'
    and executed_at >= p_from and executed_at < p_before;
  for r in select * from pg_catalog.jsonb_to_recordset(p_corrections) as x(match_id uuid, ticker text, side text, shares numeric, price_usd numeric, fee_usd numeric, executed_at timestamptz, ext_id text) loop
    update public.transactions set ticker = r.ticker, side = r.side, shares = r.shares,
      price_usd = r.price_usd, fee_usd = r.fee_usd, executed_at = r.executed_at,
      broker = 'T212', broker_account = p_account, ext_id = r.ext_id
    where id = r.match_id and user_id = uid and coalesce(broker, 'manual') = 'manual' and ext_id is null and t212_id is null;
    if not found then raise exception 'Manual trade changed; review statement again'; end if;
    corrected := corrected + 1;
  end loop;
  insert into public.transactions (user_id, broker, broker_account, ticker, side, shares, price_usd, fee_usd, executed_at, ext_id, note, cash_delta_applied)
  select uid, 'T212', p_account, x.ticker, x.side, x.shares, x.price_usd, x.fee_usd, x.executed_at, x.ext_id, x.note, 0
  from pg_catalog.jsonb_to_recordset(p_rows) as x(ticker text, side text, shares numeric, price_usd numeric, fee_usd numeric, executed_at timestamptz, ext_id text, note text)
  on conflict (user_id, broker, ext_id) do nothing;
  get diagnostics inserted = row_count;
  perform pg_catalog.set_config('app.bulk_import', 'off', true);
  for tk in select ticker from public.transactions where user_id = uid
    union select pg_catalog.unnest(affected) loop
    if tk <> 'CASH' then perform public.recalc_position(tk, uid); end if;
  end loop;
  return pg_catalog.jsonb_build_object('inserted', inserted, 'corrected', corrected);
end;
$fn$;
revoke all on function public.replace_statement_trades(text, timestamptz, timestamptz, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.replace_statement_trades(text, timestamptz, timestamptz, jsonb, jsonb, boolean) to authenticated;
