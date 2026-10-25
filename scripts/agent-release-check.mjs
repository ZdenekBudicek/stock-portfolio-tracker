import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REJECTION_CODES } from '../supabase/functions/agent/core/attemptReasons.ts';

// Release evidence gate of the AI assistant: reads files only — no network, deploy or DB access.
// GO needs every required integration check PASS, a local Supabase gateway smoke (functions serve), a real
// live eval report of the same clean commit and calculation bundle that covers every required case, and the
// acceptance thresholds of the plan. SKIP / NOT RUN is never PASS. Nothing in a report is trusted: the
// schema is strict, pass flags are recomputed from each case's checks and the summary from each case's
// per-turn and per-attempt evidence (same rules as evals/trackora_evals/score.py).

export const REQUIRED_CHECKS = [
  'migrations_applied_test', // both AI migrations applied to the explicit test project
  'real_rls', // A/B RLS suites with real JWTs
  'quota_21_way', // 21 concurrent reservations → exactly 20 accepted
  'http_ab_jwt', // HTTP runner over real A/B JWTs: auth/401, thread CRUD, foreign 404, retry, cancel, delete
  'deno_http_real_auth', // scripts/agent-test-edge.ts: Deno HTTP with real Auth — NOT the gateway (see GATEWAY_CHECKS)
  'edge_cpu', // hosted Edge CPU of the final bundle within the limit, or limited mode accepted explicitly
  'prod_migration_history', // metadata-only comparison of production migration history and stock_news grants
];
// Produced only by scripts/agent-gateway-smoke.ts against `supabase functions serve agent`.
export const GATEWAY_CHECKS = ['no_token_401', 'forged_token_401', 'user_a_chat_done', 'user_a_thread_listed', 'user_b_foreign_thread_404', 'user_a_cleanup'];
const GATEWAY_RUNNER = 'scripts/agent-gateway-smoke.ts';
const GATEWAY_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/functions\/v1\/agent$/;
// A release commit may add evidence after the evaluated commit, nothing else.
const EVIDENCE_FILES = /^(evals\/reports\/|docs\/ai-assistant\/)/;
const THRESHOLDS = { portfolioTextPassRate: 0.9, p95WallMs: 20_000 };
const CALL_TOKEN_LIMIT = 3_000, QUESTION_TOKEN_LIMIT = 8_000;
// The news analyst's call may use 9,000 and its question 12,000 (Běh 27, migration 20261025100030); an attempt says
// which cap admitted it, never more than this.
const ANALYST_CALL_TOKEN_LIMIT = 9_000, ANALYSIS_QUESTION_TOKEN_LIMIT = 12_000;
const callLimit = a => a.call_limit === ANALYST_CALL_TOKEN_LIMIT && ['answer', 'repair'].includes(a.phase) ? ANALYST_CALL_TOKEN_LIMIT : CALL_TOKEN_LIMIT;
const EVIDENCE_BLOCK = /```json release-evidence\s*\n([\s\S]*?)\n```/;
const PORTFOLIO_SCENARIOS = new Set(['transactions', 'realized', 'tax', 'simulation', 'performance', 'dividends', 'allocation', 'price', 'multi_turn', 'empty', 'movers', 'move']);
const FAIL_WHEN_TRUE = new Set(['technical', 'refused']);
const ISOLATION_LEAK_CHECKS = new Set(['forbidden', 'foreign_thread_hidden', 'foreign_audit_hidden']);
const cleanSha = sha => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const fakeModel = name => typeof name === 'string' && /fake/i.test(name);
/** SHA-256 of a text file with LF line endings (same as evals/trackora_evals/manifest.py). */
export const fileSha256 = path => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

/* ----------------------------- recomputation (mirror of score.py) ----------------------------- */

/** Failed check names: technical/refused when true; any other check when false or a non-empty list; objects are details. */
export function failuresOf(checks) {
  return Object.entries(checks).filter(([name, value]) => FAIL_WHEN_TRUE.has(name) ? value === true
    : value === false || (Array.isArray(value) && value.length > 0)).map(([name]) => name);
}
const round4 = x => Math.round(x * 1e4) / 1e4;
function p95(sorted) { return sorted.length ? sorted[Math.max(0, Math.ceil((95 * sorted.length) / 100) - 1)] : null; }
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: s.length ? s[Math.floor(s.length / 2)] : null, p95: p95(s), max: s.length ? s[s.length - 1] : null };
}
function tokenSummary(results) {
  let maxCall = 0, maxQuestion = 0, callsOver = 0, questionsOver = 0, without = 0;
  for (const r of results) for (const t of r.turns) {
    if (t.replay) continue;
    const reported = (t.tokens.in ?? 0) + (t.tokens.out ?? 0);
    let question, questionLimit = QUESTION_TOKEN_LIMIT;
    if (t.attempts === null) { without++; question = reported; }
    else {
      const calls = t.attempts.map(a => a.tokens_in + a.tokens_out);
      callsOver += calls.filter((c, k) => c > callLimit(t.attempts[k])).length;
      maxCall = Math.max(maxCall, ...calls);
      question = Math.max(calls.reduce((a, b) => a + b, 0), reported);
      if (t.attempts.some(a => callLimit(a) === ANALYST_CALL_TOKEN_LIMIT)) questionLimit = ANALYSIS_QUESTION_TOKEN_LIMIT;
    }
    maxCall = Math.max(maxCall, t.tokens.max_call ?? 0);
    if (question > questionLimit) questionsOver++;
    maxQuestion = Math.max(maxQuestion, question);
  }
  return { max_call: maxCall, max_question: maxQuestion, call_limit_violations: callsOver, question_limit_violations: questionsOver,
    turns_without_attempts: without };
}

/** The summary of a report, recomputed from its results only. */
export function summarizeResults(results) {
  const total = results.length, passed = results.filter(r => r.passed).length;
  const portfolio = results.filter(r => PORTFOLIO_SCENARIOS.has(r.scenario));
  const portfolioPassed = portfolio.filter(r => r.passed).length;
  const asked = results.flatMap(r => r.turns.filter(t => !t.replay));
  const outcomes = {};
  for (const r of results) {
    const last = r.turns.filter(t => !t.replay).at(-1) ?? { outcome: null, terminal: 'not_run' };
    const key = last.outcome || last.terminal;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  return {
    cases: total, passed, pass_rate: total ? round4(passed / total) : null,
    portfolio_text_cases: portfolio.length, portfolio_text_passed: portfolioPassed,
    portfolio_text_pass_rate: portfolio.length ? round4(portfolioPassed / portfolio.length) : null,
    unverified_numbers: results.reduce((n, r) => n + r.checks.unverified_numbers.length, 0),
    technical_labels: results.filter(r => r.checks.technical).length,
    leaks: results.filter(r => r.scenario === 'isolation' && failuresOf(r.checks).some(c => ISOLATION_LEAK_CHECKS.has(c))).length,
    isolation_other_failures: results.filter(r => r.scenario === 'isolation' && failuresOf(r.checks).some(c => !ISOLATION_LEAK_CHECKS.has(c))).length,
    unterminated: results.filter(r => !r.checks.terminated).length,
    verdict_cases: results.filter(r => 'verdict' in r.checks).length,
    verdict_ok: results.filter(r => r.checks.verdict === true).length,
    outcomes,
    template_share: total ? round4((outcomes.fallback ?? 0) / total) : null,
    rate_limited_runs: results.filter(r => r.turns.some(t => t.model_error === 'quota')).length,
    timeouts: results.filter(r => r.turns.some(t => t.terminal === 'timeout' || t.outcome === 'timeout')).length,
    wall_ms: Object.fromEntries(['cold', 'warm'].map(phase => [phase, stats(asked.filter(t => t.phase === phase && t.terminal === 'done').map(t => t.wall_ms))])),
    tokens: tokenSummary(results),
  };
}

/* ----------------------------- strict schema ----------------------------- */

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const T = {
  str: v => typeof v === 'string', num: isNum, int: v => Number.isInteger(v) && v >= 0, bool: v => typeof v === 'boolean',
  strOrNull: v => v === null || typeof v === 'string', numOrNull: v => v === null || isNum(v), intOrNull: v => v === null || Number.isInteger(v),
  list: v => Array.isArray(v), obj: v => v !== null && typeof v === 'object' && !Array.isArray(v), objOrNull: v => v === null || (v !== null && typeof v === 'object'),
};
const TYPE_NAMES = { str: 'a string', num: 'a number', int: 'a non-negative integer', bool: 'a boolean', strOrNull: 'a string or null',
  numOrNull: 'a number or null', intOrNull: 'an integer or null', list: 'a list', obj: 'an object', objOrNull: 'an object or null' };
const STATS = { n: 'int', p50: 'numOrNull', p95: 'numOrNull', max: 'numOrNull' };
const SCHEMA = {
  doc: { required: { schema_version: 'int', status: 'str', metadata: 'obj', summary: 'objOrNull', results: 'list' }, optional: { note: 'str' } },
  metadata: { required: { mode: 'str', git_sha: 'str', calculation_version: 'strOrNull', date: 'str', model: 'str', seed: 'numOrNull',
    frozen_market_date: 'strOrNull', pace_seconds: 'num', cases_sha256: 'strOrNull', case_ids: 'list' }, optional: { status: 'str', reason: 'str', cases: 'int' } },
  summary: { required: { cases: 'int', passed: 'int', pass_rate: 'numOrNull', portfolio_text_cases: 'int', portfolio_text_passed: 'int',
    portfolio_text_pass_rate: 'numOrNull', unverified_numbers: 'int', technical_labels: 'int', leaks: 'int', isolation_other_failures: 'int', unterminated: 'int',
    verdict_cases: 'int', verdict_ok: 'int', outcomes: 'obj', template_share: 'numOrNull', rate_limited_runs: 'int', timeouts: 'int',
    wall_ms: 'obj', tokens: 'obj' } },
  wall: { required: { cold: 'obj', warm: 'obj' } },
  stats: { required: STATS },
  tokenSummary: { required: { max_call: 'int', max_question: 'int', call_limit_violations: 'int', question_limit_violations: 'int', turns_without_attempts: 'int' } },
  result: { required: { id: 'str', scenario: 'str', lang: 'str', user: 'str', passed: 'bool', failures: 'list', checks: 'obj', model: 'strOrNull',
    failure: 'strOrNull', text: 'str', turns: 'list' } },
  checks: { required: { terminated: 'bool', answered: 'bool', technical: 'bool', unverified_numbers: 'list', required_missing: 'list',
    golden_disagrees: 'list', refused: 'bool', forbidden: 'list', required_text_missing: 'list', tools_missing: 'list' },
  optional: { verdict: 'bool', verdict_detail: 'obj', replay_same_text: 'bool', replay_no_quota: 'bool', foreign_audit_hidden: 'bool',
    foreign_thread_hidden: 'bool', harness_errors: 'list' } },
  turn: { required: { index: 'int', phase: 'str', replay: 'bool', request_id: 'strOrNull', terminal: 'str', http_status: 'intOrNull',
    outcome: 'strOrNull', error_code: 'strOrNull', model: 'strOrNull', model_error: 'strOrNull', wall_ms: 'num', ttft_ms: 'numOrNull',
    tokens: 'obj', attempts: 'objOrNull' } },
  turnTokens: { required: { in: 'intOrNull', out: 'intOrNull', max_call: 'intOrNull' } },
  attempt: { required: { phase: 'strOrNull', model: 'strOrNull', tokens_in: 'int', tokens_out: 'int', usage_source: 'strOrNull',
    finish_reason: 'strOrNull', outcome: 'strOrNull' }, optional: { rejection_reasons: 'list', call_limit: 'int' } },
};
function shape(value, schema, path, errors) {
  if (!T.obj(value)) { errors.push(`schema: ${path || 'report'} must be an object`); return false; }
  const known = { ...schema.required, ...schema.optional };
  for (const key of Object.keys(value)) if (!(key in known)) errors.push(`schema: unknown field ${path ? `${path}.` : ''}${key}`);
  for (const [key, type] of Object.entries(known)) {
    const where = `${path ? `${path}.` : ''}${key}`;
    if (!(key in value)) { if (key in schema.required) errors.push(`schema: ${where} missing`); continue; }
    if (!T[type](value[key])) errors.push(`schema: ${where} must be ${TYPE_NAMES[type]}`);
  }
  return true;
}

/** Strict schema of an eval report (schema 2); returns error strings, empty when valid. */
export function validateReport(doc) {
  const errors = [];
  if (!shape(doc, SCHEMA.doc, '', errors)) return errors;
  if (doc.schema_version !== 2) errors.push(`schema: schema_version ${doc.schema_version} is not 2`);
  if (T.obj(doc.metadata)) shape(doc.metadata, SCHEMA.metadata, 'metadata', errors);
  if (doc.status === 'RUN' && !T.obj(doc.summary)) errors.push('schema: summary missing for a run');
  if (T.obj(doc.summary)) {
    shape(doc.summary, SCHEMA.summary, 'summary', errors);
    if (T.obj(doc.summary.wall_ms) && shape(doc.summary.wall_ms, SCHEMA.wall, 'summary.wall_ms', errors)) {
      for (const phase of ['cold', 'warm']) if (T.obj(doc.summary.wall_ms[phase])) shape(doc.summary.wall_ms[phase], SCHEMA.stats, `summary.wall_ms.${phase}`, errors);
    }
    if (T.obj(doc.summary.tokens)) shape(doc.summary.tokens, SCHEMA.tokenSummary, 'summary.tokens', errors);
  }
  (Array.isArray(doc.results) ? doc.results : []).forEach((r, i) => {
    if (!shape(r, SCHEMA.result, `results[${i}]`, errors)) return;
    if (T.obj(r.checks)) shape(r.checks, SCHEMA.checks, `results[${i}].checks`, errors);
    if (Array.isArray(r.turns) && r.turns.length === 0) errors.push(`schema: results[${i}].turns is empty`);
    (Array.isArray(r.turns) ? r.turns : []).forEach((t, j) => {
      const where = `results[${i}].turns[${j}]`;
      if (!shape(t, SCHEMA.turn, where, errors)) return;
      if (!['cold', 'warm'].includes(t.phase)) errors.push(`schema: ${where}.phase must be cold or warm`);
      if (T.obj(t.tokens)) shape(t.tokens, SCHEMA.turnTokens, `${where}.tokens`, errors);
      if (t.attempts !== null && !Array.isArray(t.attempts)) errors.push(`schema: ${where}.attempts must be a list or null`);
      (Array.isArray(t.attempts) ? t.attempts : []).forEach((a, k) => {
        const path = `${where}.attempts[${k}]`;
        if (!shape(a, SCHEMA.attempt, path, errors)) return;
        if (Array.isArray(a.rejection_reasons) && (a.rejection_reasons.length > 10 || a.rejection_reasons.some(code => !REJECTION_CODES.has(code)))) {
          errors.push(`schema: ${path}.rejection_reasons contains unknown codes`);
        }
      });
    });
  });
  return errors;
}

function differences(stated, computed, path, out) {
  if (T.obj(computed)) {
    for (const key of new Set([...Object.keys(computed), ...Object.keys(T.obj(stated) ? stated : {})])) {
      differences(T.obj(stated) ? stated[key] : undefined, computed[key], `${path}.${key}`, out);
    }
    return;
  }
  const same = isNum(stated) && isNum(computed) ? Math.abs(stated - computed) <= 1e-4 : stated === computed;
  if (!same) out.push(`${path} ${stated ?? 'missing'} differs from the recomputed ${computed ?? 'missing'}`);
}

/* ----------------------------- evidence ----------------------------- */

function integrationEvidence(path, missing) {
  if (!existsSync(path)) { missing.push('integration: missing'); return null; }
  const block = EVIDENCE_BLOCK.exec(readFileSync(path, 'utf8'));
  if (!block) { missing.push('integration: no release-evidence block'); return null; }
  let evidence;
  try { evidence = JSON.parse(block[1]); } catch { missing.push('integration: release-evidence block is not JSON'); return null; }
  for (const check of REQUIRED_CHECKS) {
    const state = evidence.checks?.[check] ?? 'NOT RUN';
    if (state !== 'PASS') missing.push(`integration: ${check} is ${state}`);
  }
  if (!cleanSha(evidence.sha)) missing.push('integration: no clean commit SHA');
  return evidence;
}

function gatewayEvidence(path, manifest, missing) {
  if (!path || !existsSync(path)) { missing.push('gateway: missing'); return null; }
  let g;
  try { g = readJson(path); } catch { missing.push('gateway: not JSON'); return null; }
  if (g.kind !== 'supabase-functions-serve-smoke' || g.schema_version !== 1) missing.push('gateway: not a functions-serve smoke (schema 1)');
  if (g.runner !== GATEWAY_RUNNER || /agent-test-edge/.test(JSON.stringify(g))) missing.push(`gateway: not produced by ${GATEWAY_RUNNER}`);
  if (!GATEWAY_URL.test(g.base_url ?? '')) missing.push('gateway: not the Supabase functions gateway (/functions/v1/agent)');
  for (const check of GATEWAY_CHECKS) {
    const state = g.checks?.[check] ?? 'NOT RUN';
    if (state !== 'PASS') missing.push(`gateway: ${check} is ${state}`);
  }
  if (!cleanSha(g.sha)) missing.push('gateway: no clean commit SHA');
  if (manifest && g.calculation_version !== manifest.calculationVersion) missing.push('gateway: calculation version differs from the manifest');
  return g;
}

function liveEvidence(input, manifest, missing) {
  const path = input.liveReportPath;
  if (!existsSync(path)) { missing.push('live report: missing'); return null; }
  const report = readJson(path);
  const add = m => missing.push(`live report: ${m}`);
  const meta = T.obj(report?.metadata) ? report.metadata : {};
  if (meta.mode !== 'live') add(`mode is ${meta.mode ?? 'unknown'}, not live`);
  if (report?.status !== 'RUN') { add(`status ${report?.status ?? 'unknown'}`); return report; }
  const errors = validateReport(report);
  errors.forEach(add);
  // Malformed results cannot be recomputed; a malformed summary is replaced by the recomputed one anyway.
  if (errors.some(e => !e.startsWith('schema: summary') && !e.startsWith('schema: metadata'))) return report;
  if (!cleanSha(meta.git_sha)) add('not from a clean commit');
  if (manifest && meta.calculation_version !== manifest.calculationVersion) add('calculation version differs from the manifest');
  const results = report.results;
  if (fakeModel(meta.model) || results.some(r => fakeModel(r.model) || r.turns.some(t => fakeModel(t.model) || (t.attempts ?? []).some(a => fakeModel(a.model))))) {
    add('produced by the fake model');
  }

  // Coverage of the required case set, of exactly this case file.
  if (!existsSync(input.requiredCasesPath) || !existsSync(input.casesPath)) add('required case list missing');
  else {
    const required = readJson(input.requiredCasesPath);
    const sha = fileSha256(input.casesPath);
    if (required.cases_sha256 !== sha) add('required case list is stale (run python -m trackora_evals.manifest)');
    if (meta.cases_sha256 !== sha) add('ran another case set than evals/cases/mvp.yaml');
    const ids = required.cases.map(c => c.id);
    if (JSON.stringify(meta.case_ids) !== JSON.stringify(ids)) add('metadata.case_ids differ from the required case list');
    const counts = new Map();
    for (const r of results) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (!ids.includes(id)) add(`unknown case ${id}`);
      else if (count > 1) add(`case ${id} appears ${count} times`);
    }
    for (const c of required.cases) {
      if (!counts.has(c.id)) { add(`required case ${c.id} missing`); continue; }
      const asked = results.find(r => r.id === c.id).turns.filter(t => !t.replay);
      const stoppedEarly = asked.length < c.turns && asked.at(-1)?.terminal !== 'done';
      if (asked.length !== c.turns && !stoppedEarly) add(`case ${c.id} has ${asked.length} of ${c.turns} turns`);
    }
  }
  for (const r of results) {
    if (r.turns.some(t => (t.attempts ?? []).some(a => ['invalid', 'http'].includes(a.outcome)
      && !a.rejection_reasons?.length))) add(`case ${r.id} has rejected attempts without reason codes`);
    const failures = failuresOf(r.checks);
    if (JSON.stringify(failures) !== JSON.stringify(r.failures) || r.passed !== (failures.length === 0)) add(`case ${r.id} passed/failures contradict its checks`);
  }
  // Recompute every pass flag from its checks, then the summary from the results; never trust either.
  const recomputed = results.map(r => ({ ...r, failures: failuresOf(r.checks), passed: failuresOf(r.checks).length === 0 }));
  const s = summarizeResults(recomputed);
  if (T.obj(report.summary)) { const diffs = []; differences(report.summary, s, 'summary', diffs); diffs.forEach(add); }
  if (s.unverified_numbers !== 0) add(`${s.unverified_numbers} unverified numbers`);
  if (s.technical_labels !== 0) add(`${s.technical_labels} answers with technical labels`);
  if (s.leaks !== 0) add(`${s.leaks} A/B leaks`);
  if (s.isolation_other_failures !== 0) add(`${s.isolation_other_failures} other failures in isolation cases`);
  if (s.unterminated !== 0) add(`${s.unterminated} unterminated requests`);
  if (s.verdict_ok !== s.verdict_cases) add(`${s.verdict_cases - s.verdict_ok} verdict checks failed`);
  if (!(s.portfolio_text_pass_rate >= THRESHOLDS.portfolioTextPassRate)) {
    add(`portfolio text cases ${Math.round((s.portfolio_text_pass_rate ?? 0) * 100)}% < 90%`);
  }
  for (const phase of ['cold', 'warm']) {
    const w = s.wall_ms[phase];
    if (w.n === 0) add(phase === 'cold' ? 'no cold (first) turn measured' : 'no warm (follow-up) turn measured');
    else if (!(w.p95 < THRESHOLDS.p95WallMs)) add(`${phase} p95 wall ${w.p95} ms >= 20000 ms`);
  }
  if (s.tokens.call_limit_violations) add(`${s.tokens.call_limit_violations} model calls over their cap (3,000; news analyst 9,000)`);
  if (s.tokens.question_limit_violations) add(`${s.tokens.question_limit_violations} questions over their cap (8,000; analysis 12,000)`);
  if (s.tokens.turns_without_attempts) add(`${s.tokens.turns_without_attempts} questions without per-attempt usage`);
  return report;
}

/** @param {{integrationPath:string; liveReportPath:string; manifestPath:string; gatewayPath:string; requiredCasesPath:string;
 * casesPath:string; sha?:string; changedFiles?:string[]}} input
 * `changedFiles`: files changed between the evidence commit and `sha` (the CLI reads them from git). */
export function checkReleaseEvidence(input) {
  const missing = [];
  let manifest = null;
  if (existsSync(input.manifestPath)) manifest = readJson(input.manifestPath);
  else missing.push('manifest: missing');
  const integration = integrationEvidence(input.integrationPath, missing);
  const gateway = gatewayEvidence(input.gatewayPath, manifest, missing);
  const live = liveEvidence(input, manifest, missing);
  const liveSha = live?.metadata?.git_sha;
  if (integration?.sha && cleanSha(liveSha) && integration.sha !== liveSha) missing.push('integration SHA differs from the live report SHA');
  const evidenceSha = integration?.sha ?? liveSha;
  if (gateway && cleanSha(gateway.sha) && evidenceSha && gateway.sha !== evidenceSha) missing.push('gateway SHA differs from the evidence SHA');
  if (input.sha && evidenceSha && input.sha !== evidenceSha) {
    if (!input.changedFiles) missing.push('release SHA differs from the evidence SHA');
    else for (const file of input.changedFiles.filter(f => !EVIDENCE_FILES.test(f))) missing.push(`release SHA changes code after the evidence: ${file}`);
  }
  return { ok: missing.length === 0, missing };
}

export const DEFAULT_PATHS = { integrationPath: 'docs/ai-assistant/INTEGRATION.md', liveReportPath: 'evals/reports/mvp-live.json',
  manifestPath: 'supabase/functions/agent/_lib/manifest.json', gatewayPath: 'docs/ai-assistant/gateway-evidence.json',
  requiredCasesPath: 'evals/cases/required.json', casesPath: 'evals/cases/mvp.yaml' };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv.find(a => a.startsWith('--sha='))?.slice(6);
  const paths = DEFAULT_PATHS;
  let changedFiles;
  const text = existsSync(paths.integrationPath) ? readFileSync(paths.integrationPath, 'utf8') : '';
  let evidenceSha = null;
  try { evidenceSha = JSON.parse(EVIDENCE_BLOCK.exec(text)?.[1] ?? 'null')?.sha ?? null; } catch { evidenceSha = null; }
  if (sha && cleanSha(sha) && cleanSha(evidenceSha) && sha !== evidenceSha) {
    // Read-only: which files the release commit changes after the evaluated one.
    try { changedFiles = execFileSync('git', ['diff', '--name-only', evidenceSha, sha], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean); }
    catch { changedFiles = undefined; }
  }
  const result = checkReleaseEvidence({ ...paths, ...(sha ? { sha } : {}), ...(changedFiles ? { changedFiles } : {}) });
  console.info(JSON.stringify({ decision: result.ok ? 'GO' : 'NO-GO', ...result }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
