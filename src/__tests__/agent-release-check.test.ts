// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReleaseEvidence, failuresOf, GATEWAY_CHECKS, REQUIRED_CHECKS, summarizeResults, validateReport } from '../../scripts/agent-release-check.mjs';

const SHA = 'a'.repeat(40), VERSION = 'b'.repeat(64);
const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
let n = 0;
function file(content: unknown, ext = 'json'): string {
  const path = join(dir, `f${++n}.${ext}`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const allPass = Object.fromEntries((REQUIRED_CHECKS as string[]).map(c => [c, 'PASS']));
const integration = (checks: Record<string, string> = allPass, sha = SHA) =>
  file(`# Integration\n\n\`\`\`json release-evidence\n${JSON.stringify({ sha, checks })}\n\`\`\`\n`, 'md');
const manifest = () => file({ calculationVersion: VERSION });

// A small required case set; the case file's hash ties the report to it.
const casesText = 'cases:\n  - id: tx\n  - id: multi\n  - id: buy\n';
const casesPath = file(casesText, 'yaml');
const CASES_SHA = createHash('sha256').update(casesText).digest('hex');
const requiredPath = file({ cases_file: 'evals/cases/mvp.yaml', cases_sha256: CASES_SHA, cases: [
  { id: 'tx', turns: 1, scenario: 'transactions', lang: 'cs' }, { id: 'multi', turns: 2, scenario: 'multi_turn', lang: 'sk' },
  { id: 'buy', turns: 1, scenario: 'buy', lang: 'en' }] });

const attempt = (tokensIn = 1200, tokensOut = 300) => ({ phase: 'writer', model: 'openai/gpt-oss-120b', tokens_in: tokensIn, tokens_out: tokensOut,
  usage_source: 'reported', finish_reason: 'stop', outcome: 'ok' });
const turn = (index: number, over: Record<string, unknown> = {}) => ({ index, phase: index === 0 ? 'cold' : 'warm', replay: false,
  request_id: `r-${index}`, terminal: 'done', http_status: 200, outcome: 'ok', error_code: null, model: 'openai/gpt-oss-120b', model_error: null,
  wall_ms: 4000 + index, ttft_ms: 300, tokens: { in: 1200, out: 300, max_call: 1500 }, attempts: [attempt()], ...over });
const baseChecks = { terminated: true, answered: true, technical: false, unverified_numbers: [], required_missing: [], golden_disagrees: [],
  refused: false, forbidden: [], required_text_missing: [], tools_missing: [] };
const result = (id: string, scenario: string, lang: string, turns: number, extra: Record<string, unknown> = {}) => ({
  id, scenario, lang, user: 'A', passed: true, failures: [], checks: { ...baseChecks, ...extra }, model: 'openai/gpt-oss-120b', failure: null,
  text: 'ok', turns: Array.from({ length: turns }, (_, i) => turn(i)) });
function liveDoc() {
  const results = [result('tx', 'transactions', 'cs', 1), result('multi', 'multi_turn', 'sk', 2),
    result('buy', 'buy', 'en', 1, { verdict: true, verdict_detail: { missing: [], verdict: 'attractive', confidence: 'medium' } })];
  return { schema_version: 2, status: 'RUN', metadata: { mode: 'live', git_sha: SHA, calculation_version: VERSION, date: '2026-10-24T10:00:00+00:00',
    model: 'openai/gpt-oss-120b', seed: 20261023, frozen_market_date: '2026-10-23', pace_seconds: 12, cases_sha256: CASES_SHA,
    case_ids: ['tx', 'multi', 'buy'] }, summary: summarizeResults(results), results };
}
type Doc = ReturnType<typeof liveDoc>;
const resync = (doc: Doc) => { doc.summary = summarizeResults(doc.results); return doc; };
const gatewayDoc = (over: Record<string, unknown> = {}) => ({ schema_version: 1, kind: 'supabase-functions-serve-smoke', runner: 'scripts/agent-gateway-smoke.ts',
  sha: SHA, calculation_version: VERSION, base_url: 'http://127.0.0.1:54321/functions/v1/agent', started_at: '2026-10-24T09:00:00Z',
  checks: Object.fromEntries((GATEWAY_CHECKS as string[]).map(c => [c, 'PASS'])), observations: {}, ...over });
const inputs = (over: { live?: unknown; gateway?: unknown; integration?: string } = {}) => ({
  integrationPath: over.integration ?? integration(), liveReportPath: file(over.live ?? liveDoc()), manifestPath: manifest(),
  gatewayPath: over.gateway === null ? join(dir, 'no-gateway.json') : file(over.gateway ?? gatewayDoc()), requiredCasesPath: requiredPath, casesPath });

describe('checkReleaseEvidence', () => {
  it.each([
    [{ tools_missing: ['get_portfolio_summary'] }, 0, 1],
    [{ forbidden: ['SYNA'] }, 1, 0],
    [{ foreign_thread_hidden: false }, 1, 0],
    [{ foreign_audit_hidden: false }, 1, 0],
    [{ forbidden: ['SYNA'], required_missing: ['portfolio:total_value'] }, 1, 1],
  ])('separates isolation leaks from other failures: %j', (checks, leaks, other) => {
    const row = result('isolation', 'isolation', 'en', 1, { foreign_thread_hidden: true, foreign_audit_hidden: true, ...checks });
    row.failures = failuresOf(row.checks); row.passed = !row.failures.length;
    expect(summarizeResults([row])).toMatchObject({ leaks, isolation_other_failures: other });
  });

  it('is GO only with every required PASS, a matching live report, gateway evidence and SHA', () => {
    expect(checkReleaseEvidence(inputs())).toEqual({ ok: true, missing: [] });
  });

  it('a fake report, or a live-labelled report from the fake model, is not live evidence', () => {
    const fake = liveDoc(); fake.metadata.mode = 'fake';
    expect(checkReleaseEvidence(inputs({ live: fake })).missing).toContain('live report: mode is fake, not live');
    const disguised = liveDoc(); disguised.metadata.model = 'fake-llm (rate-limited router, provocative writer)';
    expect(checkReleaseEvidence(inputs({ live: disguised })).missing).toContain('live report: produced by the fake model');
    const fakeAttempt = liveDoc(); fakeAttempt.results[0].turns[0].attempts[0].model = 'fake-llm';
    expect(checkReleaseEvidence(inputs({ live: resync(fakeAttempt) })).missing).toContain('live report: produced by the fake model');
  });

  it('a required SKIP, FAIL or NOT RUN integration check is NO-GO', () => {
    for (const state of ['SKIP', 'FAIL', 'NOT RUN']) {
      const result = checkReleaseEvidence(inputs({ integration: integration({ ...allPass, real_rls: state }) }));
      expect(result.ok).toBe(false);
      expect(result.missing).toContain(`integration: real_rls is ${state}`);
    }
  });

  it('a missing or NOT RUN live report is NO-GO', () => {
    expect(checkReleaseEvidence({ ...inputs(), liveReportPath: join(dir, 'none.json') }).missing).toContain('live report: missing');
    const notRun = { ...liveDoc(), status: 'NOT RUN', summary: null, results: [] };
    expect(checkReleaseEvidence(inputs({ live: notRun })).missing).toContain('live report: status NOT RUN');
  });

  it('rejects a report with a missing, duplicated or unknown case', () => {
    const missing = liveDoc(); missing.results.pop(); missing.metadata.case_ids.pop();
    expect(checkReleaseEvidence(inputs({ live: resync(missing) })).missing).toContain('live report: required case buy missing');
    const dup = liveDoc(); dup.results[2] = clone(dup.results[0]);
    expect(checkReleaseEvidence(inputs({ live: resync(dup) })).missing).toEqual(expect.arrayContaining(['live report: case tx appears 2 times',
      'live report: required case buy missing']));
    const other = liveDoc(); other.metadata.cases_sha256 = 'd'.repeat(64);
    expect(checkReleaseEvidence(inputs({ live: other })).missing).toContain('live report: ran another case set than evals/cases/mvp.yaml');
  });

  it('rejects a case that stopped asking before its last turn while claiming a pass', () => {
    const short = liveDoc(); short.results[1].turns.pop();
    expect(checkReleaseEvidence(inputs({ live: resync(short) })).missing).toContain('live report: case multi has 1 of 2 turns');
  });

  it('never trusts the summary: it must equal the summary recomputed from the turns', () => {
    const inflated = liveDoc(); inflated.summary.passed = 3; inflated.results[0].checks.unverified_numbers = ['999 USD' as never];
    inflated.results[0].failures = ['unverified_numbers']; inflated.results[0].passed = false;
    const missing = checkReleaseEvidence(inputs({ live: inflated })).missing;
    expect(missing).toContain('live report: summary.passed 3 differs from the recomputed 2');
    expect(missing).toContain('live report: summary.unverified_numbers 0 differs from the recomputed 1');
    expect(missing).toContain('live report: 1 unverified numbers');
  });

  it('rejects a result whose pass flag contradicts its own checks', () => {
    const lying = liveDoc(); lying.results[0].checks.required_missing = ['transactions:all:sell_usd' as never];
    expect(checkReleaseEvidence(inputs({ live: resync(lying) })).missing).toContain('live report: case tx passed/failures contradict its checks');
  });

  it('missing verdict counters are a schema error, never equal', () => {
    const doc = liveDoc() as unknown as { summary: Record<string, unknown> };
    delete doc.summary.verdict_cases; delete doc.summary.verdict_ok;
    const missing = checkReleaseEvidence(inputs({ live: doc })).missing;
    expect(missing).toEqual(expect.arrayContaining(['live report: schema: summary.verdict_cases missing', 'live report: schema: summary.verdict_ok missing']));
    const failedVerdict = liveDoc(); (failedVerdict.results[2].checks as Record<string, unknown>).verdict = false;
    failedVerdict.results[2].failures = ['verdict']; failedVerdict.results[2].passed = false;
    expect(checkReleaseEvidence(inputs({ live: resync(failedVerdict) })).missing).toContain('live report: 1 verdict checks failed');
  });

  it('is strict about unknown fields and wrong types', () => {
    const extra = liveDoc() as unknown as Record<string, unknown>; extra.trust_me = true;
    expect(validateReport(extra)).toContain('schema: unknown field trust_me');
    const wrong = liveDoc() as unknown as { results: { turns: { wall_ms: unknown }[] }[] }; wrong.results[0].turns[0].wall_ms = 'fast';
    expect(validateReport(wrong)).toContain('schema: results[0].turns[0].wall_ms must be a number');
  });

  it('checks every token limit from per-attempt usage', () => {
    const bigCall = liveDoc(); bigCall.results[0].turns[0].attempts = [attempt(2800, 400)];
    const over = 'live report: 1 model calls over their cap (3,000; news analyst 9,000)';
    expect(checkReleaseEvidence(inputs({ live: resync(bigCall) })).missing).toContain(over);
    // The news analyst's answer/repair call may use 9,000 when admitted under that cap (Běh 27); nothing else may.
    const analyst = liveDoc(); analyst.results[0].turns[0].attempts = [{ ...attempt(7000, 1400), phase: 'answer', call_limit: 9000 }] as never;
    expect(checkReleaseEvidence(inputs({ live: resync(analyst) })).missing.join('\n')).not.toMatch(/over their cap/);
    const analystOver = liveDoc(); analystOver.results[0].turns[0].attempts = [{ ...attempt(7700, 1400), phase: 'answer', call_limit: 9000 }] as never;
    expect(checkReleaseEvidence(inputs({ live: resync(analystOver) })).missing).toContain(over);
    const router = liveDoc(); router.results[0].turns[0].attempts = [{ ...attempt(2800, 400), phase: 'router', call_limit: 9000 }] as never;
    expect(checkReleaseEvidence(inputs({ live: resync(router) })).missing).toContain(over);
    const questionOver = 'live report: 1 questions over their cap (8,000; analysis 12,000)';
    const bigQuestion = liveDoc(); bigQuestion.results[0].turns[0].attempts = [attempt(2500, 300), attempt(2500, 300), attempt(2500, 300)];
    expect(checkReleaseEvidence(inputs({ live: resync(bigQuestion) })).missing).toContain(questionOver);
    // A question that ran the analyst may use 12,000 in total.
    const analysis = liveDoc(); analysis.results[0].turns[0].attempts = [attempt(1500, 300), { ...attempt(7000, 1400), phase: 'answer', call_limit: 9000 }] as never;
    expect(checkReleaseEvidence(inputs({ live: resync(analysis) })).missing).not.toContain(questionOver);
    const analysisOver = liveDoc(); analysisOver.results[0].turns[0].attempts = [attempt(2500, 300), { ...attempt(7000, 1400), phase: 'answer', call_limit: 9000 },
      { ...attempt(1500, 300), phase: 'repair', call_limit: 3000 }] as never;
    expect(checkReleaseEvidence(inputs({ live: resync(analysisOver) })).missing).toContain(questionOver);
    const unproven = liveDoc(); (unproven.results[0].turns[0] as { attempts: unknown }).attempts = null;
    expect(checkReleaseEvidence(inputs({ live: resync(unproven) })).missing).toContain('live report: 1 questions without per-attempt usage');
  });

  it('checks cold and warm latency separately', () => {
    const slowWarm = liveDoc(); slowWarm.results[1].turns[1].wall_ms = 25_000;
    expect(checkReleaseEvidence(inputs({ live: resync(slowWarm) })).missing).toContain('live report: warm p95 wall 25000 ms >= 20000 ms');
    const noWarm = liveDoc(); noWarm.results[1].turns.pop();
    expect(checkReleaseEvidence(inputs({ live: resync(noWarm) })).missing).toContain('live report: no warm (follow-up) turn measured');
  });

  it('quality thresholds use the recomputed numbers', () => {
    const bad = liveDoc(); bad.results[0].checks.required_missing = ['x' as never]; bad.results[0].failures = ['required_missing']; bad.results[0].passed = false;
    bad.results[1].turns[0].wall_ms = 21_000;
    const missing = checkReleaseEvidence(inputs({ live: resync(bad) })).missing;
    expect(missing).toContain('live report: portfolio text cases 50% < 90%');
    expect(missing).toContain('live report: cold p95 wall 21000 ms >= 20000 ms');
  });

  it('agent-test-edge.ts is never gateway evidence; a local functions-serve smoke is required', () => {
    const noGateway = checkReleaseEvidence(inputs({ gateway: null }));
    expect(noGateway.missing).toContain('gateway: missing');
    // A PASS for the old Deno runner in the integration block does not stand in for the gateway.
    const edge = checkReleaseEvidence(inputs({ gateway: null, integration: integration({ ...allPass, deno_gateway: 'PASS' }) }));
    expect(edge.missing).toContain('gateway: missing');
    expect(checkReleaseEvidence(inputs({ gateway: gatewayDoc({ runner: 'scripts/agent-test-edge.ts' }) })).missing)
      .toContain('gateway: not produced by scripts/agent-gateway-smoke.ts');
    expect(checkReleaseEvidence(inputs({ gateway: gatewayDoc({ base_url: 'http://127.0.0.1:8787/agent' }) })).missing)
      .toContain('gateway: not the Supabase functions gateway (/functions/v1/agent)');
    expect(checkReleaseEvidence(inputs({ gateway: gatewayDoc({ checks: { ...gatewayDoc().checks as object, user_b_foreign_thread_404: 'SKIP' } }) })).missing)
      .toContain('gateway: user_b_foreign_thread_404 is SKIP');
    expect(checkReleaseEvidence(inputs({ gateway: gatewayDoc({ sha: 'c'.repeat(40) }) })).missing).toContain('gateway SHA differs from the evidence SHA');
    expect(checkReleaseEvidence(inputs({ gateway: gatewayDoc({ calculation_version: 'x' }) })).missing)
      .toContain('gateway: calculation version differs from the manifest');
  });

  it('mismatched SHA, dirty tree or calculation version is NO-GO', () => {
    expect(checkReleaseEvidence(inputs({ integration: integration(allPass, 'c'.repeat(40)) })).missing).toContain('integration SHA differs from the live report SHA');
    const dirty = liveDoc(); dirty.metadata.git_sha = `${SHA}+dirty`;
    expect(checkReleaseEvidence(inputs({ live: dirty })).missing).toContain('live report: not from a clean commit');
    const version = liveDoc(); version.metadata.calculation_version = 'x';
    expect(checkReleaseEvidence(inputs({ live: version })).missing).toContain('live report: calculation version differs from the manifest');
    expect(checkReleaseEvidence({ ...inputs(), sha: 'd'.repeat(40) }).missing).toContain('release SHA differs from the evidence SHA');
  });

  it('a release commit may differ from the evidence commit only by evidence files', () => {
    const base = { ...inputs(), sha: 'd'.repeat(40) };
    expect(checkReleaseEvidence({ ...base, changedFiles: ['evals/reports/mvp-live.json', 'docs/ai-assistant/INTEGRATION.md'] })).toEqual({ ok: true, missing: [] });
    expect(checkReleaseEvidence({ ...base, changedFiles: ['evals/reports/mvp-live.json', 'supabase/functions/agent/core/agent.ts'] }).missing)
      .toContain('release SHA changes code after the evidence: supabase/functions/agent/core/agent.ts');
  });

  it('integration evidence without the machine-readable block is NO-GO', () => {
    expect(checkReleaseEvidence(inputs({ integration: file('# Integration\nall good', 'md') })).missing).toContain('integration: no release-evidence block');
  });

  it('recomputes exactly what the Python harness wrote (committed fake report, same rules in both languages)', () => {
    const report = JSON.parse(readFileSync('evals/reports/mvp-fake.json', 'utf8'));
    expect(validateReport(report)).toEqual([]);
    expect(summarizeResults(report.results)).toEqual(report.summary);
    for (const r of report.results) expect(failuresOf(r.checks)).toEqual(r.failures);
  });

  it('the evidence in this repository is honestly NO-GO today', () => {
    const result = checkReleaseEvidence({ integrationPath: 'docs/ai-assistant/INTEGRATION.md', liveReportPath: 'evals/reports/mvp-live.json',
      manifestPath: 'supabase/functions/agent/_lib/manifest.json', gatewayPath: 'docs/ai-assistant/gateway-evidence.json',
      requiredCasesPath: 'evals/cases/required.json', casesPath: 'evals/cases/mvp.yaml' });
    expect(result.ok).toBe(false);
    expect(result.missing.some(m => m.startsWith('live report: '))).toBe(true);
    expect(result.missing).toContain('integration: edge_cpu is NOT RUN');
  });

  it('keeps an isolation answer failure as a separate release blocker', () => {
    const doc = liveDoc();
    doc.results[0].scenario = 'isolation';
    Object.assign(doc.results[0].checks, { tools_missing: ['get_portfolio_summary'], foreign_audit_hidden: true, foreign_thread_hidden: true });
    doc.results[0].failures = failuresOf(doc.results[0].checks); doc.results[0].passed = false;
    const result = checkReleaseEvidence(inputs({ live: resync(doc) }));
    expect(result.missing).toContain('live report: 1 other failures in isolation cases');
    expect(result.missing).not.toContain('live report: 1 A/B leaks');
  });

  it('still rejects missing gateway evidence independently of the checked-in smoke report', () => {
    expect(checkReleaseEvidence({ ...inputs(), gatewayPath: join(dir, 'absent-gateway.json') }).missing).toContain('gateway: missing');
  });

  it('keeps rejected-attempt diagnostics as release evidence', () => {
    const doc = liveDoc();
    doc.results[0].turns[0].attempts = [{ ...attempt(), outcome: 'invalid' }];
    expect(checkReleaseEvidence(inputs({ live: doc })).missing).toContain('live report: case tx has rejected attempts without reason codes');
  });

  it('rejects arbitrary data disguised as rejection codes', () => {
    const doc = liveDoc();
    Object.assign(doc.results[0].turns[0].attempts[0], { rejection_reasons: ['private_account_987654'] });
    expect(validateReport(doc)).toContain('schema: results[0].turns[0].attempts[0].rejection_reasons contains unknown codes');
  });
});
