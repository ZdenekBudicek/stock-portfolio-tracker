-- Guard against reconciling an account against an INCOMPLETE scope.
--
-- reconcile_broker_account counts only rows whose broker_account matches. Rows written
-- before per-account scoping existed carry NULL, so an account-scoped call could not see
-- them: it concluded the account held nothing and inserted an adjustment BUY for the whole
-- snapshot ON TOP of shares that were already there — every position doubled.
--
-- Callers are expected to claim those rows first (the statement import and the T212 sync
-- both do). This makes the invariant the database's own rule, so a caller that forgets
-- fails loudly instead of silently inflating the portfolio.
create or replace function public.reconcile_broker_account(
  p_user_id uuid, p_broker text, p_account text, p_holdings jsonb,
  p_note text default 'Dorovnání podle brokera')
returns int language plpgsql security definer set search_path to 'public' as $fn$
declare
  tk text; own numeric; tgt numeric; d numeric; n int := 0; stray int;
  pfx text := lower(p_broker) || ':adj:' || coalesce(p_account, '-') || ':';
  touched text[] := '{}';
begin
  -- SECURITY DEFINER + a user-supplied p_user_id: a signed-in caller may only ever
  -- reconcile their OWN rows. auth.uid() is NULL for the service role (the sync backend).
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'forbidden';
  end if;

  if p_account is not null then
    select count(*) into stray from public.transactions
     where user_id = p_user_id and broker = p_broker and broker_account is null and ticker <> 'CASH';
    if stray > 0 then
      raise exception
        'reconcile_broker_account: % transakcí brokera % nemá přiřazený účet — dorovnání by je nezapočítalo a pozice by se zdvojily. Přiřaď je nejdřív k účtu.',
        stray, p_broker;
    end if;
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
  delete from public.positions
   where user_id = p_user_id and ticker <> 'CASH' and ticker = any(touched) and shares <= 0.0001;
  return n;
end; $fn$;

revoke all on function public.reconcile_broker_account(uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.reconcile_broker_account(uuid, text, text, jsonb, text) to authenticated, service_role;
