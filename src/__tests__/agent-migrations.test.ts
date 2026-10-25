// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('adds unique newer migrations with non-cascading quota ledger and composite ownership FKs', () => {
  const files = readdirSync('supabase/migrations').sort();
  expect(new Set(files.map(f => f.slice(0, 14))).size).toBe(files.length);
  expect(files.filter(f => f.startsWith('202610251'))).toEqual(['20261025100000_ai_assistant.sql', '20261025100010_ai_market_cache.sql', '20261025100020_agent_runs_analyst_call.sql',
    '20261025100030_agent_runs_deeper_analysis.sql']);
  const sql = readFileSync('supabase/migrations/20261025100000_ai_assistant.sql', 'utf8');
  expect(sql.match(/foreign key \(thread_id, user_id\)/g)).toHaveLength(2);
  expect(sql).toContain("at time zone 'Europe/Prague'");
  expect(sql).toContain('v_used >= 20');
  expect(sql).toContain("interval '50 seconds'");
  expect(sql).toContain('execution_token_hash');
  expect(sql).toContain("set search_path = ''");
  expect(sql).toContain('revoke all on function public.begin_agent_request');
  const ledger = sql.slice(sql.indexOf('create table public.agent_requests'), sql.indexOf('create index agent_requests'));
  expect(ledger).not.toMatch(/references public.chat_threads/);
});
it('fails incompatible news schema without dropping rows and removes legacy public policies', () => {
  const sql = readFileSync('supabase/migrations/20261025100010_ai_market_cache.sql', 'utf8');
  expect(sql).toContain('Incompatible stock_news schema');
  expect(sql).toContain('pg_catalog.pg_policy');
  expect(sql).toContain('drop policy');
  expect(sql).not.toMatch(/drop table|truncate|delete from/i);
  expect(sql).toContain('to authenticated using (true)');
  expect(sql).toContain('public.analyst_snapshots');
});
it('Běh 27: widens the agent_runs call and question checks to 9,000 and 12,000 for the deeper analysis, keeping rows', () => {
  const sql = readFileSync('supabase/migrations/20261025100030_agent_runs_deeper_analysis.sql', 'utf8');
  expect(sql).toContain('check (max_call_tokens between 0 and 9000)');
  expect(sql).toContain('check (tokens_in::bigint + tokens_out::bigint <= 12000)');
  expect(sql).not.toMatch(/drop table|truncate|delete from|update public/i);
});
it('widens only the per-call check of agent_runs to the analyst cap of 5,000, keeping rows and the 8,000 question check', () => {
  const sql = readFileSync('supabase/migrations/20261025100020_agent_runs_analyst_call.sql', 'utf8');
  expect(sql).toContain('check (max_call_tokens between 0 and 5000)');
  expect(sql).toContain("like '%max_call_tokens%'");
  expect(sql).not.toMatch(/drop table|truncate|delete from|update public|8000/i);
});
it('audit A1/A4/A6/A11: shared daily caps, one question at a time, erased answers and bounded completions', () => {
  const sql = readFileSync('supabase/migrations/20261026100100_agent_shared_limits.sql', 'utf8');
  expect(sql).toContain("('questions', 150), ('tavily', 30), ('github_dispatch', 40)");
  // Neither table is readable or writable by clients; the budgets move only through the definer functions.
  expect(sql).toContain('revoke all on public.agent_shared_limits, public.agent_shared_usage from public, anon, authenticated');
  expect(sql).toContain('revoke all on function public.reserve_shared_resource(text, integer) from public, anon, authenticated');
  // Searches only for the caller's running question (codex review): 6 per question, 12 per user a day.
  expect(sql).toContain("p_resource is distinct from 'tavily'");
  expect(sql).toContain("v_request.state <> 'active'");
  expect(sql).toContain('v_today + p_units > 12');
  // Thread deletion only through the locked function.
  expect(sql).toContain('revoke delete on public.chat_threads from authenticated');
  expect(sql.match(/set search_path = ''/g)!.length).toBeGreaterThanOrEqual(5);
  expect(sql).toContain("where user_id = v_user and state = 'active' limit 1");
  expect(sql).toContain("jsonb_build_object('kind', 'quota', 'scope', 'shared'");
  expect(sql).toContain('octet_length(p_answer::text) > 131072');
  expect(sql).toContain('create trigger chat_threads_erase_answers after delete on public.chat_threads');
  // Usage is never refunded: no ledger row of a deleted thread is removed by the trigger, only its answer.
  const trigger = sql.slice(sql.indexOf('create function public.erase_deleted_thread_answers'), sql.indexOf('create trigger'));
  expect(trigger).not.toMatch(/delete from/i);
  expect(sql).not.toMatch(/drop table|truncate/i);
});
