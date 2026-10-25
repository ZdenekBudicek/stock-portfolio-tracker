-- Běh 23b: the news analyst's model call may use up to 5,000 tokens (input + output); every other call stays at 3,000
-- and a question at 8,000 (unchanged table check). `agent_runs.max_call_tokens` is the largest charged call of a
-- question, so its check is widened from 3,000 to 5,000. No rows are changed or removed.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_catalog.pg_constraint c
    where c.conrelid = 'public.agent_runs'::regclass and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%max_call_tokens%'
  loop
    execute pg_catalog.format('alter table public.agent_runs drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.agent_runs
  add constraint agent_runs_max_call_tokens_check check (max_call_tokens between 0 and 5000);
