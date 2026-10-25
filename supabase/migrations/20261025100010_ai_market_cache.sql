-- Preserve cached news JSON verbatim, including en/cs/sumEn/sumCs/publisher/url/ts.
do $$
declare
  v_column record;
  v_policy record;
  v_pk text[];
begin
  if to_regclass('public.stock_news') is null then
    create table public.stock_news (symbol text primary key, items jsonb, fetched_at timestamptz);
  else
    if not exists (select 1 from pg_catalog.pg_class where oid = 'public.stock_news'::regclass and relkind = 'r') then
      raise exception 'Incompatible stock_news schema: expected an ordinary table';
    end if;
    for v_column in select a.attname, a.atttypid, a.attnotnull, a.atthasdef, a.attgenerated
      from pg_catalog.pg_attribute a where a.attrelid = 'public.stock_news'::regclass and a.attnum > 0 and not a.attisdropped
    loop
      if (v_column.attname = 'symbol' and v_column.atttypid not in ('text'::regtype, 'varchar'::regtype))
        or (v_column.attname = 'items' and v_column.atttypid not in ('json'::regtype, 'jsonb'::regtype))
        or (v_column.attname = 'fetched_at' and v_column.atttypid <> 'timestamptz'::regtype)
        or (v_column.attname in ('symbol', 'items', 'fetched_at') and v_column.attgenerated <> '')
        or (v_column.attname not in ('symbol', 'items', 'fetched_at') and v_column.attnotnull and not v_column.atthasdef and v_column.attgenerated = '') then
        raise exception 'Incompatible stock_news schema: column % requires explicit review', v_column.attname;
      end if;
    end loop;
    if not exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.stock_news'::regclass and attname = 'symbol' and not attisdropped) then
      raise exception 'Incompatible stock_news schema: symbol missing';
    end if;
    select array_agg(a.attname::text order by k.ordinality) into v_pk
      from pg_catalog.pg_constraint c cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.conrelid = 'public.stock_news'::regclass and c.contype = 'p';
    if v_pk is not null and v_pk <> array['symbol'] then
      raise exception 'Incompatible stock_news schema: primary key must be symbol';
    end if;
    if exists (select 1 from public.stock_news where symbol is null)
      or exists (select symbol from public.stock_news group by symbol having count(*) > 1) then
      raise exception 'Incompatible stock_news schema: null or duplicate symbols';
    end if;
    alter table public.stock_news add column if not exists items jsonb;
    alter table public.stock_news add column if not exists fetched_at timestamptz;
    alter table public.stock_news alter column symbol type text;
    alter table public.stock_news alter column items type jsonb using items::jsonb;
    if v_pk is null then alter table public.stock_news add primary key (symbol); end if;
  end if;
  alter table public.stock_news enable row level security;
  for v_policy in select polname from pg_catalog.pg_policy where polrelid = 'public.stock_news'::regclass loop
    execute format('drop policy %I on public.stock_news', v_policy.polname);
  end loop;
  revoke all on public.stock_news from public, anon, authenticated;
  -- Table REVOKE alone leaves legacy column-level grants intact.
  for v_column in select attname from pg_catalog.pg_attribute
    where attrelid = 'public.stock_news'::regclass and attnum > 0 and not attisdropped loop
    execute format('revoke all (%I) on public.stock_news from public, anon, authenticated', v_column.attname);
  end loop;
end;
$$;

create policy stock_news_authenticated_read on public.stock_news for select to authenticated using (true);
grant select (symbol, items, fetched_at) on public.stock_news to authenticated;
grant all on public.stock_news to service_role;

create table public.analyst_snapshots (
  symbol text primary key,
  data jsonb,
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  status text not null check (status in ('ok', 'unavailable', 'error'))
);
alter table public.analyst_snapshots enable row level security;
revoke all on public.analyst_snapshots from public, anon, authenticated;
grant select on public.analyst_snapshots to authenticated;
grant all on public.analyst_snapshots to service_role;
create policy analyst_snapshots_authenticated_read on public.analyst_snapshots for select to authenticated using (true);
