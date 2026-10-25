create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  user_id uuid not null,
  request_id uuid not null,
  seq integer not null check (seq > 0),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  lang text not null check (lang in ('cs', 'sk', 'en')),
  trace jsonb not null default '[]'::jsonb check (jsonb_typeof(trace) = 'array'),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  created_at timestamptz not null default now(),
  foreign key (thread_id, user_id) references public.chat_threads(id, user_id) on delete cascade,
  unique (thread_id, seq),
  unique (user_id, request_id, role)
);
create index chat_messages_history on public.chat_messages(user_id, thread_id, seq);
create index chat_threads_history on public.chat_threads(user_id, updated_at desc, id);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  user_id uuid not null,
  request_id uuid not null,
  model text,
  router_model text,
  tokens_in integer not null check (tokens_in >= 0),
  tokens_out integer not null check (tokens_out >= 0),
  max_call_tokens integer not null check (max_call_tokens between 0 and 3000),
  tool_calls integer not null check (tool_calls >= 0),
  tools_used text[] not null,
  wall_ms integer not null check (wall_ms >= 0),
  ttft_ms integer check (ttft_ms >= 0),
  outcome text not null check (outcome in ('ok', 'fallback', 'timeout', 'error')),
  grounding_ok boolean not null,
  calculation_version text not null,
  error_code text,
  created_at timestamptz not null default now(),
  foreign key (thread_id, user_id) references public.chat_threads(id, user_id) on delete cascade,
  unique (user_id, request_id),
  check (tokens_in::bigint + tokens_out::bigint <= 8000)
);
create index agent_runs_history on public.agent_runs(user_id, created_at);

create table public.agent_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  used integer not null check (used between 0 and 20),
  primary key (user_id, day)
);

-- Intentionally no thread FK: deleting history must never refund a reservation.
create table public.agent_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  thread_id uuid not null,
  requested_thread_id uuid,
  fingerprint text not null,
  question_hash bytea not null,
  lang text not null check (lang in ('cs', 'sk', 'en')),
  state text not null check (state in ('active', 'completed', 'timeout')),
  execution_token_hash bytea not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  answer jsonb,
  primary key (user_id, request_id),
  check ((state = 'active' and completed_at is null and answer is null)
    or (state <> 'active' and completed_at is not null and answer is not null))
);
create index agent_requests_thread on public.agent_requests(user_id, thread_id);
create unique index agent_requests_active_thread on public.agent_requests(user_id, thread_id) where state = 'active';

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_daily_usage enable row level security;
alter table public.agent_requests enable row level security;

revoke all on public.chat_threads, public.chat_messages, public.agent_runs, public.agent_daily_usage, public.agent_requests from public, anon, authenticated;
grant select, delete on public.chat_threads to authenticated;
grant update (title) on public.chat_threads to authenticated;
grant select on public.chat_messages, public.agent_runs, public.agent_daily_usage to authenticated;
-- Execution hashes and stored answers are available only through the bounded RPCs.
grant all on public.chat_threads, public.chat_messages, public.agent_runs, public.agent_daily_usage, public.agent_requests to service_role;

create policy chat_threads_select on public.chat_threads for select to authenticated using (user_id = (select auth.uid()));
create policy chat_threads_update on public.chat_threads for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy chat_threads_delete on public.chat_threads for delete to authenticated using (user_id = (select auth.uid()));
create policy chat_messages_select on public.chat_messages for select to authenticated using (user_id = (select auth.uid()));
create policy agent_runs_select on public.agent_runs for select to authenticated using (user_id = (select auth.uid()));
create policy agent_daily_usage_select on public.agent_daily_usage for select to authenticated using (user_id = (select auth.uid()));

create function public.begin_agent_request(p_request_id uuid, p_thread_id uuid, p_question text,
  p_lang text, p_fingerprint text, p_execution_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz;
  v_day date;
  v_used integer;
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

  if p_thread_id is not null then
    select id into v_thread from public.chat_threads where id = p_thread_id and user_id = v_user for update;
    if not found then return jsonb_build_object('kind', 'conflict'); end if;
    select * into v_active from public.agent_requests where user_id = v_user and thread_id = v_thread and state = 'active';
    if found then return jsonb_build_object('kind', 'busy', 'retry_at', v_active.created_at + interval '50 seconds'); end if;
  end if;
  if v_used >= 20 then
    return jsonb_build_object('kind', 'quota', 'retry_at', (v_day + 1)::timestamp at time zone 'Europe/Prague');
  end if;
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
  return jsonb_build_object('kind', 'accepted', 'thread_id', v_thread, 'remaining_today', 19 - v_used);
end;
$$;

create function public.complete_agent_request(p_request_id uuid, p_execution_token text, p_answer jsonb, p_metrics jsonb)
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
    or (p_answer->'verified') is distinct from 'true'::jsonb
    or jsonb_typeof(p_answer->'text') is distinct from 'string' or char_length(p_answer->>'text') not between 1 and 32000
    or jsonb_typeof(p_answer->'links') is distinct from 'array' or jsonb_typeof(p_answer->'trace') is distinct from 'array'
    or (p_answer->>'lang') is distinct from v_request.lang
    or coalesce(p_answer->>'outcome', '') not in ('ok', 'fallback', 'timeout', 'error')
    or p_metrics is null or jsonb_typeof(p_metrics) <> 'object'
    or jsonb_typeof(p_metrics->'tools_used') is distinct from 'array'
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

revoke all on function public.begin_agent_request(uuid, uuid, text, text, text, text) from public, anon;
revoke all on function public.complete_agent_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.begin_agent_request(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.complete_agent_request(uuid, text, jsonb, jsonb) to authenticated;
