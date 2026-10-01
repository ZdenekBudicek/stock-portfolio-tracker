-- Per-ACCOUNT broker scoping.
--
-- One person can hold several accounts at the same broker (two Trading 212 Invest
-- accounts, two Revolut profiles, …). Until now everything was keyed on the broker NAME
-- alone, so all of them shared one bucket. The consequences were data loss:
--   * syncing the API-connected T212 account reconciled it against ALL rows tagged 'T212',
--     so every ticker belonging to the OTHER account was zeroed by a phantom adjustment;
--   * a ticker held at two accounts got one account's cost basis stamped over the whole
--     blended position.
-- From here on every transaction/deposit/dividend records WHICH account it came from, and
-- reconciliation may only ever touch rows of that same (broker, account).
alter table public.transactions add column if not exists broker_account text;
alter table public.deposits add column if not exists broker_account text;
alter table public.dividends add column if not exists broker_account text;
alter table public.broker_connections add column if not exists account_id text;

create index if not exists transactions_user_broker_acct
  on public.transactions(user_id, broker, broker_account, ticker);

-- Bulk import, account-aware. Same contract as before plus p_account, which is stamped on
-- every inserted row (NULL keeps the old behaviour for callers that don't know an account).
--
-- The earlier 3- and 5-argument versions MUST go first: adding a variant that only differs
-- by a defaulted trailing parameter makes every existing call site ambiguous ("function is
-- not unique"), which would break the sync outright rather than degrade it.
drop function if exists public.import_broker_transactions(uuid, text, jsonb);
drop function if exists public.import_broker_transactions(uuid, text, jsonb, boolean, boolean);

create or replace function public.import_broker_transactions(
  p_user_id uuid, p_broker text, p_rows jsonb,
  p_replace boolean default true, p_recalc boolean default true, p_account text default null)
returns int language plpgsql security definer set search_path to 'public' as $fn$
declare tk text; n int;
begin
  perform set_config('app.bulk_import', 'on', true);
  if p_replace then
    -- Scoped to the account when one is given: replacing a broker's rows must not delete
    -- another account's history at the same broker.
    delete from public.transactions
     where user_id = p_user_id and broker = p_broker
       and ext_id like (lower(p_broker) || ':%')
       and (p_account is null or broker_account is not distinct from p_account);
  end if;
  insert into public.transactions (ticker, side, shares, price_usd, fee_usd, executed_at, broker, broker_account, ext_id, user_id, note, cash_delta_applied)
  select r.ticker, r.side, r.shares, r.price_usd, coalesce(r.fee_usd, 0), r.executed_at::timestamptz, p_broker,
         coalesce(r.account, p_account), r.ext_id, p_user_id, r.note, 0
  from jsonb_to_recordset(p_rows) as r(ticker text, side text, shares numeric, price_usd numeric, fee_usd numeric, executed_at text, ext_id text, note text, account text)
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

revoke all on function public.import_broker_transactions(uuid, text, jsonb, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.import_broker_transactions(uuid, text, jsonb, boolean, boolean, text) to service_role;

-- Reconcile ONE broker account against its authoritative holdings snapshot (broker API
-- portfolio, or the "Otevřené pozice" / "Portfolio breakdown" table of its statement).
--
-- p_holdings: [{ticker, qty, avg}]  — avg is optional, used as the adjustment's cost.
--
-- Rules that make this safe:
--   * only rows with (broker, broker_account) = (p_broker, p_account) are counted or
--     touched — another account, another broker and manual entries are invisible here;
--   * a ticker is only considered if THIS account traded it or the broker reports it, so
--     the snapshot can never zero a position that lives somewhere else;
--   * the adjustment is a normal dated transaction, so the blended cross-broker average
--     stays a plain consequence of the transaction list — nothing overwrites it.
create or replace function public.reconcile_broker_account(
  p_user_id uuid, p_broker text, p_account text, p_holdings jsonb,
  p_note text default 'Dorovnání podle brokera')
returns int language plpgsql security definer set search_path to 'public' as $fn$
declare
  tk text; own numeric; tgt numeric; d numeric; n int := 0;
  pfx text := lower(p_broker) || ':adj:' || coalesce(p_account, '-') || ':';
  touched text[] := '{}';
begin
  -- SECURITY DEFINER + a user-supplied p_user_id: a signed-in caller may only ever
  -- reconcile their OWN rows. auth.uid() is NULL for the service role (the sync backend).
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'forbidden';
  end if;
  perform set_config('app.bulk_import', 'on', true);
  delete from public.transactions
   where user_id = p_user_id and broker = p_broker
     and broker_account is not distinct from p_account
     and ext_id like (pfx || '%');

  for tk in
    select distinct ticker from public.transactions
      where user_id = p_user_id and broker = p_broker
        and broker_account is not distinct from p_account and ticker <> 'CASH'
    union
    select h->>'ticker' from jsonb_array_elements(coalesce(p_holdings, '[]'::jsonb)) h
  loop
    select coalesce(sum(case when side = 'BUY' then shares else -shares end), 0) into own
      from public.transactions
      where user_id = p_user_id and broker = p_broker
        and broker_account is not distinct from p_account and ticker = tk;
    select coalesce((select (h->>'qty')::numeric from jsonb_array_elements(coalesce(p_holdings, '[]'::jsonb)) h where h->>'ticker' = tk), 0) into tgt;
    d := tgt - own;
    touched := touched || tk;
    if abs(d) > 1e-4 then
      insert into public.transactions (ticker, side, shares, price_usd, fee_usd, executed_at, broker, broker_account, ext_id, user_id, note, cash_delta_applied)
      values (tk, case when d > 0 then 'BUY' else 'SELL' end, abs(d),
        coalesce((select nullif(h->>'avg','')::numeric from jsonb_array_elements(coalesce(p_holdings, '[]'::jsonb)) h where h->>'ticker' = tk), 0),
        0, now(), p_broker, p_account, pfx || tk, p_user_id, p_note, 0);
      n := n + 1;
    end if;
  end loop;

  perform set_config('app.bulk_import', 'off', true);
  foreach tk in array touched loop
    perform public.recalc_position(tk, p_user_id);
  end loop;
  -- Drop positions that are now empty ACROSS ALL brokers (recalc_position already summed
  -- every broker, so a zero here really means the user holds none of it anywhere).
  delete from public.positions
   where user_id = p_user_id and ticker <> 'CASH' and ticker = any(touched) and shares <= 0.0001;
  return n;
end; $fn$;

revoke all on function public.reconcile_broker_account(uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.reconcile_broker_account(uuid, text, text, jsonb, text) to authenticated, service_role;

-- NOTE: the account-blind predecessor reconcile_broker_to_portfolio() is deliberately LEFT
-- IN PLACE. The currently deployed sync-broker edge function still calls it, and dropping it
-- here would break every user's sync the moment this migration runs — the schema and the
-- functions deploy independently. Remove it in a follow-up, once the new edge function is
-- live and nothing calls the old name any more.
