-- Běh 27: the news analyst reads more of the pages it explains (company research, analyst expectations, the industry).
-- Its model call may reserve up to 9,000 tokens (input + output, by the byte upper bound) and a question 12,000; the real
-- Groq usage stays well below its 8,000 tokens a minute. `agent_runs.max_call_tokens` (the largest charged call) is
-- widened from 5,000 to 9,000 and the question total from 8,000 to 12,000. No rows are changed or removed.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_catalog.pg_constraint c
    where c.conrelid = 'public.agent_runs'::regclass and c.contype = 'c'
      and (pg_catalog.pg_get_constraintdef(c.oid) like '%max_call_tokens%'
        or (pg_catalog.pg_get_constraintdef(c.oid) like '%tokens_in%' and pg_catalog.pg_get_constraintdef(c.oid) like '%tokens_out%'))
  loop
    execute pg_catalog.format('alter table public.agent_runs drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.agent_runs
  add constraint agent_runs_max_call_tokens_check check (max_call_tokens between 0 and 9000),
  add constraint agent_runs_question_tokens_check check (tokens_in::bigint + tokens_out::bigint <= 12000);
