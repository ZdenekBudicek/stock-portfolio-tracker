-- Audit 2026-10-25 (A1, A4, A6, A11): the free providers are shared by every account, so the per-user
-- daily 20 is not enough on its own. A shared daily question cap and per-provider unit budgets
-- (Tavily) are reserved atomically in the database; one user may run one question at a time;
-- deleting a thread erases its stored answers; old ledger rows are pruned on the caller's next question.

create table public.agent_shared_limits (
  resource text primary key check (resource ~ '^[a-z_]{1,32}$'),
  daily_limit integer not null check (daily_limit between 0 and 100000)
);
-- Groq free quotas are per organisation and per model; the chain spreads a question over three
-- models, so ~150 questions a day fit. Tavily free is 1,000 credits a month (~30 a day). GitHub
-- workflow runs for companies nobody has data for (A6) stay well inside the free Actions minutes.
insert into public.agent_shared_limits(resource, daily_limit) values ('questions', 150), ('tavily', 30), ('github_dispatch', 40);

create table public.agent_shared_usage (
  day date not null,
  resource text not null references public.agent_shared_limits(resource) on delete cascade,
  used integer not null check (used >= 0),
  primary key (day, resource)
);

alter table public.agent_shared_limits enable row level security;
alter table public.agent_shared_usage enable row level security;
revoke all on public.agent_shared_limits, public.agent_shared_usage from public, anon, authenticated;
grant all on public.agent_shared_limits, public.agent_shared_usage to service_role;

-- Units of a shared budget for today (Prague); false once the day's budget is spent and the caller
-- goes on without that provider. Service role only (edge functions: GitHub workflow runs, A6).
create function public.reserve_shared_resource(p_resource text, p_units integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_day date := (clock_timestamp() at time zone 'Europe/Prague')::date;
  v_limit integer;
  v_used integer;
begin
  if p_resource is null or p_units is null or p_units not between 1 and 50 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  select daily_limit into v_limit from public.agent_shared_limits where resource = p_resource;
  if not found then raise exception 'Invalid request' using errcode = '22023'; end if;
  insert into public.agent_shared_usage(day, resource, used) values (v_day, p_resource, 0) on conflict do nothing;
  select used into v_used from public.agent_shared_usage where day = v_day and resource = p_resource for update;
  if v_used + p_units > v_limit then return false; end if;
  update public.agent_shared_usage set used = used + p_units where day = v_day and resource = p_resource;
  return true;
end;
$$;
revoke all on function public.reserve_shared_resource(text, integer) from public, anon, authenticated;
grant execute on function public.reserve_shared_resource(text, integer) to service_role;

-- Searches a question has taken from the shared Tavily budget.
alter table public.agent_requests add column searches integer not null default 0 check (searches between 0 and 6);

-- A Tavily search for the caller's own RUNNING question: at most 6 per question and 12 per user a
-- day, then the shared daily budget. A client cannot spend the shared budget without a question in
-- flight, and a spent or failed reservation means no search. ('questions' is reserved by
-- begin_agent_request, workflow runs by the edge functions.)
create function public.reserve_agent_resource(p_request_id uuid, p_resource text, p_units integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz;
  v_request public.agent_requests%rowtype;
  v_today integer;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_request_id is null or p_resource is distinct from 'tavily' or p_units is null or p_units not between 1 and 3 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 62026));
  v_now := clock_timestamp();
  select * into v_request from public.agent_requests where user_id = v_user and request_id = p_request_id for update;
  if not found or v_request.state <> 'active' or v_request.created_at + interval '50 seconds' <= v_now
    or v_request.searches + p_units > 6 then
    return false;
  end if;
  select coalesce(sum(searches), 0) into v_today from public.agent_requests
    where user_id = v_user and created_at >= ((v_now at time zone 'Europe/Prague')::date)::timestamp at time zone 'Europe/Prague';
  if v_today + p_units > 12 or not public.reserve_shared_resource(p_resource, p_units) then return false; end if;
  update public.agent_requests set searches = searches + p_units where user_id = v_user and request_id = p_request_id;
  return true;
end;
$$;
revoke all on function public.reserve_agent_resource(uuid, text, integer) from public, anon;
grant execute on function public.reserve_agent_resource(uuid, text, integer) to authenticated;

-- begin_agent_request as in 20261025100000, plus: one active question per user (any thread), the
-- shared daily question cap ('quota' with scope 'shared'), and pruning of the caller's old rows.
create or replace function public.begin_agent_request(p_request_id uuid, p_thread_id uuid, p_question text,
  p_lang text, p_fingerprint text, p_execution_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz;
  v_day date;
  v_used integer;
  v_shared_used integer;
  v_shared_limit integer;
  v_thread uuid;
  v_seq integer;
  v_request public.agent_requests%rowtype;
  v_active public.agent_requests%rowtype;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_request_id is null or p_question is null or char_length(btrim(p_question)) = 0 or char_length(p_question) > 2000
    or p_lang is null or p_lang not in ('cs', 'sk', 'en')
    or p_fingerprint is null or char_length(p_fingerprint) not between 1 and 256
    or p_execution_token is null or char_length(p_execution_token) not between 32 and 256 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  -- Serialize this caller across midnight as well as within the quota day.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 62026));
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'Europe/Prague')::date;
  insert into public.agent_daily_usage(user_id, day, used) values (v_user, v_day, 0) on conflict do nothing;
  select used into v_used from public.agent_daily_usage where user_id = v_user and day = v_day for update;

  select * into v_request from public.agent_requests where user_id = v_user and request_id = p_request_id for update;
  if found then
    if v_request.fingerprint <> p_fingerprint or v_request.question_hash <> pg_catalog.sha256(pg_catalog.convert_to(p_question, 'UTF8')) or v_request.lang <> p_lang
      or v_request.requested_thread_id is distinct from p_thread_id then
      return jsonb_build_object('kind', 'conflict');
    end if;
    if not exists (select 1 from public.chat_threads where id = v_request.thread_id and user_id = v_user) then
      return jsonb_build_object('kind', 'conflict');
    end if;
    if v_request.state = 'active' and v_request.created_at + interval '50 seconds' > v_now then
      return jsonb_build_object('kind', 'busy', 'retry_at', v_request.created_at + interval '50 seconds');
    end if;
  end if;

  -- Expiration is terminal. It never releases usage, nor transfers an execution token.
  update public.agent_requests set state = 'timeout', completed_at = v_now,
    answer = jsonb_build_object('text', case lang when 'cs' then 'Čas na odpověď vypršel. Zkus nový dotaz.'
      when 'sk' then 'Čas na odpoveď vypršal. Skús novú otázku.' else 'The response timed out. Try a new question.' end,
      'links', '[]'::jsonb, 'trace', '[]'::jsonb, 'lang', lang, 'outcome', 'timeout', 'verified', true)
    where user_id = v_user and state = 'active' and created_at + interval '50 seconds' <= v_now;
  if v_request.request_id is not null then
    select * into v_request from public.agent_requests where user_id = v_user and request_id = p_request_id;
    return jsonb_build_object('kind', 'replay', 'thread_id', v_request.thread_id, 'answer', v_request.answer, 'remaining_today', 20 - v_used);
  end if;

  -- One question at a time per user, whichever thread: parallel threads would multiply the shared load.
  select * into v_active from public.agent_requests where user_id = v_user and state = 'active' limit 1;
  if found then return jsonb_build_object('kind', 'busy', 'retry_at', v_active.created_at + interval '50 seconds'); end if;
  if p_thread_id is not null then
    select id into v_thread from public.chat_threads where id = p_thread_id and user_id = v_user for update;
    if not found then return jsonb_build_object('kind', 'conflict'); end if;
  end if;
  if v_used >= 20 then
    return jsonb_build_object('kind', 'quota', 'retry_at', (v_day + 1)::timestamp at time zone 'Europe/Prague');
  end if;
  -- The shared cap last, so a user's own limits answer first and never spend shared units.
  select daily_limit into v_shared_limit from public.agent_shared_limits where resource = 'questions';
  insert into public.agent_shared_usage(day, resource, used) values (v_day, 'questions', 0) on conflict do nothing;
  select used into v_shared_used from public.agent_shared_usage where day = v_day and resource = 'questions' for update;
  if v_shared_used >= coalesce(v_shared_limit, 0) then
    return jsonb_build_object('kind', 'quota', 'scope', 'shared', 'retry_at', (v_day + 1)::timestamp at time zone 'Europe/Prague');
  end if;
  update public.agent_shared_usage set used = used + 1 where day = v_day and resource = 'questions';

  if p_thread_id is null then
    insert into public.chat_threads(user_id, title, created_at, updated_at)
      values (v_user, left(p_question, 120), v_now, v_now) returning id into v_thread;
  end if;
  update public.agent_daily_usage set used = used + 1 where user_id = v_user and day = v_day;
  insert into public.agent_requests(user_id, request_id, thread_id, requested_thread_id, fingerprint, question_hash, lang, state, execution_token_hash, created_at)
    values (v_user, p_request_id, v_thread, p_thread_id, p_fingerprint, pg_catalog.sha256(pg_catalog.convert_to(p_question, 'UTF8')), p_lang, 'active',
      pg_catalog.sha256(pg_catalog.convert_to(p_execution_token, 'UTF8')), v_now);
  select coalesce(max(seq), 0) + 1 into v_seq from public.chat_messages where thread_id = v_thread and user_id = v_user;
  insert into public.chat_messages(thread_id, user_id, request_id, seq, role, content, lang, created_at)
    values (v_thread, v_user, p_request_id, v_seq, 'user', p_question, p_lang, v_now);
  update public.chat_threads set updated_at = v_now where id = v_thread and user_id = v_user;

  -- Retention: the caller's finished ledger rows older than 90 days (their answers, not usage) and
  -- daily counters older than 60 days; shared counters older than 60 days. Small, indexed deletes.
  delete from public.agent_requests where user_id = v_user and state <> 'active' and created_at < v_now - interval '90 days';
  delete from public.agent_daily_usage where user_id = v_user and day < v_day - 60;
  delete from public.agent_shared_usage where day < v_day - 60;
  return jsonb_build_object('kind', 'accepted', 'thread_id', v_thread, 'remaining_today', 19 - v_used);
end;
$$;

-- complete_agent_request as in 20261025100000, with the whole payload bounded: an authenticated
-- client can call it directly, so the 32 KiB edge limit must hold here too.
create or replace function public.complete_agent_request(p_request_id uuid, p_execution_token text, p_answer jsonb, p_metrics jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_request public.agent_requests%rowtype;
  v_now timestamptz;
  v_seq integer;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 62026));
  v_now := clock_timestamp();
  select * into v_request from public.agent_requests where user_id = v_user and request_id = p_request_id for update;
  if not found or p_execution_token is null or v_request.execution_token_hash <> pg_catalog.sha256(pg_catalog.convert_to(p_execution_token, 'UTF8')) then
    raise exception 'Invalid execution' using errcode = '42501';
  end if;
  if v_request.state = 'completed' then return; end if;
  if v_request.state <> 'active' or v_request.created_at + interval '50 seconds' <= v_now then
    raise exception 'Execution expired' using errcode = '55000';
  end if;
  perform 1 from public.chat_threads where id = v_request.thread_id and user_id = v_user for update;
  if not found then raise exception 'Thread unavailable' using errcode = '55000'; end if;
  if p_answer is null or jsonb_typeof(p_answer) <> 'object'
    or pg_catalog.octet_length(p_answer::text) > 131072
    or (p_answer->'verified') is distinct from 'true'::jsonb
    or jsonb_typeof(p_answer->'text') is distinct from 'string' or char_length(p_answer->>'text') not between 1 and 32000
    or jsonb_typeof(p_answer->'links') is distinct from 'array' or jsonb_array_length(p_answer->'links') > 50
    or jsonb_typeof(p_answer->'trace') is distinct from 'array' or jsonb_array_length(p_answer->'trace') > 100
    or (p_answer->>'lang') is distinct from v_request.lang
    or coalesce(p_answer->>'outcome', '') not in ('ok', 'fallback', 'timeout', 'error')
    or p_metrics is null or jsonb_typeof(p_metrics) <> 'object' or pg_catalog.octet_length(p_metrics::text) > 8192
    or jsonb_typeof(p_metrics->'tools_used') is distinct from 'array' or jsonb_array_length(p_metrics->'tools_used') > 64
    or (p_metrics->>'outcome') is distinct from (p_answer->>'outcome') then
    raise exception 'Invalid completion' using errcode = '22023';
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.chat_messages where thread_id = v_request.thread_id and user_id = v_user;
  insert into public.chat_messages(thread_id, user_id, request_id, seq, role, content, lang, trace, links, created_at)
    values (v_request.thread_id, v_user, p_request_id, v_seq, 'assistant', p_answer->>'text', v_request.lang, p_answer->'trace', p_answer->'links', v_now);
  insert into public.agent_runs(thread_id, user_id, request_id, model, router_model, tokens_in, tokens_out, max_call_tokens,
    tool_calls, tools_used, wall_ms, ttft_ms, outcome, grounding_ok, calculation_version, error_code, created_at)
    values (v_request.thread_id, v_user, p_request_id, p_metrics->>'model', p_metrics->>'router_model',
      (p_metrics->>'tokens_in')::integer, (p_metrics->>'tokens_out')::integer, (p_metrics->>'max_call_tokens')::integer,
      (p_metrics->>'tool_calls')::integer, array(select jsonb_array_elements_text(p_metrics->'tools_used')),
      (p_metrics->>'wall_ms')::integer, (p_metrics->>'ttft_ms')::integer, p_metrics->>'outcome',
      (p_metrics->>'grounding_ok')::boolean, p_metrics->>'calculation_version', p_metrics->>'error_code', v_now);
  update public.agent_requests set state = 'completed', completed_at = v_now, answer = p_answer
    where user_id = v_user and request_id = p_request_id;
  update public.chat_threads set updated_at = v_now where id = v_request.thread_id and user_id = v_user;
end;
$$;

-- Deleting a thread erases the answers kept for replay (the ledger row itself stays, so usage is
-- never refunded) and ends a question still running in it: its completion can no longer be stored,
-- and the user's one active question must not stay blocked by a thread that is gone.
-- A replay of an erased request is a conflict: its thread no longer exists.
create function public.erase_deleted_thread_answers()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.agent_requests set answer = jsonb_build_object('erased', true),
      state = case when state = 'active' then 'timeout' else state end, completed_at = coalesce(completed_at, clock_timestamp())
    where user_id = old.user_id and thread_id = old.id;
  return old;
end;
$$;
revoke all on function public.erase_deleted_thread_answers() from public, anon, authenticated;
create trigger chat_threads_erase_answers after delete on public.chat_threads
  for each row execute function public.erase_deleted_thread_answers();

-- Answers of threads deleted before this migration.
update public.agent_requests r set answer = jsonb_build_object('erased', true)
  where r.state <> 'active' and not exists (select 1 from public.chat_threads t where t.id = r.thread_id and t.user_id = r.user_id);


-- Deleting a thread goes through this function (codex review of A4): it takes the same per-user lock
-- as complete_agent_request BEFORE the delete, so a deletion and an answer being stored never wait
-- on each other's row locks (deadlock). Clients lose the direct DELETE.
create function public.delete_agent_thread(p_thread_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 62026));
  delete from public.chat_threads where id = p_thread_id and user_id = v_user;
  return found;
end;
$$;
revoke all on function public.delete_agent_thread(uuid) from public, anon;
grant execute on function public.delete_agent_thread(uuid) to authenticated;
revoke delete on public.chat_threads from authenticated;
