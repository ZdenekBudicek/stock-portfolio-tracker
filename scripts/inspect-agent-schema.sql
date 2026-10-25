-- Metadata only. Run in the SQL editor of the explicitly reviewed TEST_DB_URL target.
-- Capture before and after the migrations; never select cached/private row contents.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('stock_news', 'analyst_snapshots', 'chat_threads',
  'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests')
order by table_name, ordinal_position;

select c.relname as table_name, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid) as definition
from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('stock_news', 'analyst_snapshots', 'chat_threads',
  'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests')
order by c.relname, k.conname;

select tablename, indexname, indexdef from pg_catalog.pg_indexes
where schemaname = 'public' and tablename in ('stock_news', 'analyst_snapshots', 'chat_threads',
  'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests') order by tablename, indexname;

select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_catalog.pg_policies
where schemaname = 'public' and tablename in ('stock_news', 'analyst_snapshots', 'chat_threads',
  'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests') order by tablename, policyname;

select table_name, grantee, privilege_type from information_schema.table_privileges
where table_schema = 'public' and table_name in ('stock_news', 'analyst_snapshots', 'chat_threads',
  'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests') order by table_name, grantee, privilege_type;
select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
where table_schema = 'public' and table_name in ('stock_news', 'analyst_snapshots', 'chat_threads',
  'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests') order by table_name, column_name, grantee;

select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef, p.proconfig, p.proacl
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('begin_agent_request', 'complete_agent_request');

-- Fail instead of treating a partial migration as a successful schema inspection.
do $$
declare v_table text;
begin
  foreach v_table in array array['stock_news', 'analyst_snapshots', 'chat_threads', 'chat_messages', 'agent_runs', 'agent_daily_usage', 'agent_requests'] loop
    if not exists (select 1 from pg_catalog.pg_class where oid = to_regclass('public.' || v_table) and relrowsecurity) then
      raise exception 'Missing RLS: %', v_table;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_constraint where contype = 'f'
      and conrelid in ('public.chat_messages'::regclass, 'public.agent_runs'::regclass)
      and confrelid = 'public.chat_threads'::regclass and cardinality(conkey) = 2) <> 2 then
    raise exception 'Missing composite ownership FK';
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.begin_agent_request(uuid,uuid,text,text,text,text)', 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', 'public.complete_agent_request(uuid,text,jsonb,jsonb)', 'EXECUTE')
    or pg_catalog.has_table_privilege('authenticated', 'public.agent_requests', 'INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.agent_daily_usage', 'INSERT,UPDATE,DELETE')
    or pg_catalog.has_any_column_privilege('anon', 'public.stock_news', 'SELECT') then
    raise exception 'Unsafe agent grants';
  end if;
end;
$$;
