interface Workflow { on: Record<string, { inputs: Record<string, { default: unknown }> }>; permissions: Record<string, string>; jobs: Record<string, { needs?: string; if?: string; environment?: string; with?: Record<string, string>; steps: { run?: string; env?: Record<string, string> }[] }> }
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import yaml from 'js-yaml';

it('commits rates independently, then builds a second commit and releases its exact SHA', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/cnb-rates.yml', 'utf8')) as Workflow;
  const refresh = workflow.jobs.refresh.steps.map((s) => s.run ?? '').join('\n');
  expect(refresh).not.toMatch(/npm ci|vitest|tsc|deno|agent-lib|_lib/);
  expect(refresh).toContain('git push');
  const bundle = workflow.jobs['build-agent'];
  expect(bundle.needs).toBe('refresh');
  expect(bundle.if).toContain("needs.refresh.outputs.changed == 'true'");
  const steps = bundle.steps.map((s) => s.run ?? '').join('\n');
  expect(steps).toContain('npm run build:agent-lib');
  expect(steps).toContain('npm run check:agent-lib');
  expect(steps).toContain('git push');
  expect(steps).not.toContain('--cached-only');
  expect(workflow.jobs['release-agent'].needs).toBe('build-agent');
  expect(workflow.jobs['release-agent'].with.sha).toContain('needs.build-agent.outputs.sha');
  const release = readFileSync('.github/workflows/agent-release.yml', 'utf8');
  expect(release).toContain("AGENT_DEPLOY_ENABLED: 'false'");
  expect(release).not.toContain('--cached-only');
});

it('gates a production deploy on the release evidence of the exact SHA, behind the production environment', () => {
  const release = yaml.load(readFileSync('.github/workflows/agent-release.yml', 'utf8')) as Workflow;
  const deploy = release.jobs.deploy;
  expect(deploy.environment).toBe('production');
  const steps = deploy.steps.map((s) => s.run ?? '');
  const gate = steps.findIndex((run: string) => run.includes('node scripts/agent-release-check.mjs --sha="$RELEASE_SHA"'));
  const ship = steps.findIndex((run: string) => run.includes('supabase functions deploy agent'));
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(gate).toBeLessThan(ship);
  expect(steps[ship]).toContain('--project-ref "$PROJECT_REF"');
  expect(steps.join('\n')).not.toMatch(/db push/);
});

it('runs evals by hand only, against the synthetic test project with separate secrets, never deploying', () => {
  const evals = yaml.load(readFileSync('.github/workflows/agent-evals.yml', 'utf8')) as Workflow;
  expect(Object.keys(evals.on)).toEqual(['workflow_dispatch']);
  expect(evals.permissions).toEqual({ contents: 'read' });
  const text = readFileSync('.github/workflows/agent-evals.yml', 'utf8');
  expect(text).toContain('environment: agent-test');
  expect(text).toContain('secrets.TEST_GROQ_API_KEY');
  expect(text).not.toMatch(/SUPABASE_SERVICE_KEY|SUPABASE_ACCESS_TOKEN|functions deploy|db push/);
  expect(text).toContain('python -m trackora_evals.run');
});

it('paces the live eval for the free model quota (12 s by default) and stays manual-only', () => {
  const evals = yaml.load(readFileSync('.github/workflows/agent-evals.yml', 'utf8')) as Workflow;
  expect(Object.keys(evals.on)).toEqual(['workflow_dispatch']);
  const pace = evals.on.workflow_dispatch.inputs.pace_seconds;
  expect(pace).toMatchObject({ required: true, type: 'string' });
  expect(String(pace.default)).toBe('12');
  const run = evals.jobs.evals.steps.find((s) => (s.run ?? '').includes('python -m trackora_evals.run'));
  expect(run.run).toContain('--pace-seconds "$PACE"');
  expect(run.env.PACE).toBe('${{ inputs.pace_seconds }}');
  // The required case list must be in sync before any run.
  expect(evals.jobs.evals.steps.some((s) => (s.run ?? '').includes('python -m pytest evals/tests'))).toBe(true);
});
