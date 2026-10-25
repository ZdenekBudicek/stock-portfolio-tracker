# Trackora assistant evals

HTTP evals of the chat agent over synthetic fixture users — `supabase/functions/agent/fixtures/demo.json`,
frozen at 2026-10-23: A (CZ), B (SK), C (residence outside every tax model), D (CZ, purchase before the
bundled ČNB rates, so its purchase FX stays missing whatever the daily refresh adds) and E (empty account).
No family data, no production.

- `cases/mvp.yaml` — 37 scenarios (21 cs / 7 sk / 9 en): the 30 MVP cases, 3 data-quality cases (OTHER
  residence, missing purchase FX, empty portfolio) and 4 semantic negatives (price offered as tax, another
  period, a gain asked as a loss, a pressured refusal). Golden values come from `POST /agent/tools` over the
  same snapshot, independent of the chat path; their `fact_ids` are the required data of the intent (Běh 15).
  The accounting itself is covered by the regression suites of runs 2–5, not here; a tool-vs-LLM eval does not
  replace them or RLS tests.
- `cases/required.json` — the case IDs/turn counts and the case file hash the release gate requires;
  regenerate with `python -m trackora_evals.manifest` after any case change (a pytest checks it).
- `trackora_evals/client.py` — SSE chat with a hard 50 s client deadline; every end (done, EOF,
  HTTP error, timeout, invalid event) is recorded, nothing waits forever.
- `trackora_evals/score.py` — reads numbers back from the answer by locale (`98.650` is 98 650 in cs,
  98.65 in en), with sign, currency, the line's tickers, the meaning words in front of the number and the
  years around it. A number is verified only by a fact **of this run** (eval audit) with the same value,
  ticker, sign ("ztráta 3,35" = −3,35), period and meaning: a price under a tax label, last year's value
  under this year or a gain shown as a loss fails. Golden tool results are never trusted as evidence; each
  required golden fact must appear with its own meaning, and chat evidence that disagrees with the golden
  tool result fails. Buy verdicts are structural (verdict from the fixed set, basis, consistent confidence,
  what would change it, risks; analysts/valuation for a complete analysis). A refusal while required data
  exist, technical labels, forbidden text and missing tools fail. Failed requests stay in the denominator.
- `trackora_evals/report.py` — schema 2: `<output>.json` + `<output>.md` with metadata (mode, git SHA,
  calculationVersion, date, model, seed, frozen market date, pacing, case-file hash and case IDs), per-case
  checks and per-turn evidence (`cold` = first request of a case, `warm` = follow-up turns; replays are not
  new questions) with per-attempt model usage from the audit. The summary is recomputed from the turns, and
  `scripts/agent-release-check.mjs` recomputes it again: per call ≤ 3,000 and per question ≤ 8,000 tokens are
  checked from per-attempt usage; a question without per-attempt usage is unproven, never a pass.
  Attempts also retain sanitized `rejection_reasons` (Běh 21b). Inspect these codes for invalid drafts,
  truncated routing and provider HTTP failures; prompts, drafts and provider error prose are not stored.
  Legacy reports without these codes remain readable but rejected attempts without diagnostics block release.

## Setup

```powershell
python -m venv evals/.venv          # gitignored
evals/.venv/Scripts/python -m pip install -e "./evals[test]"
evals/.venv/Scripts/python -m pytest evals/tests
```

## Fake mode (no model, no key)

```powershell
node --experimental-transform-types scripts/agent-local.ts --fixture-auth --fake-llm --port=8787     # terminal 1
evals/.venv/Scripts/python -m trackora_evals.run --base http://127.0.0.1:8787 --cases evals/cases/mvp.yaml --mode fake --output evals/reports/mvp-fake
```

The fake model rate-limits the router (the keyword router decides) and always drafts an invented
number plus a tool name, which grounding must reject — every answer is the verified template.
The fake report is evidence of the harness and the safety path only, never of Groq quality or p95.

## Live mode (Groq, synthetic data)

`GROQ_API_KEY` must be in the **process environment** of both commands (never read from `.env`, never
printed). Start the runner **without** `--fake-llm`, from a clean commit:

```powershell
node --experimental-transform-types scripts/agent-local.ts --fixture-auth --fixture-agent --port=8787     # terminal 1, key in env
evals/.venv/Scripts/python -m trackora_evals.run --base http://127.0.0.1:8787 --cases evals/cases/mvp.yaml --mode live --output evals/reports/mvp-live
```

Without the key the harness writes a `NOT RUN` report and exits 2 — never a live PASS. The report
counts rate limits, timeouts and the template share; latency is the measured sample, not a guarantee.
Each case uses its own fixture identity (`fixture-user-a-<n>`) so one identity's 20-question daily
limit does not cut the run. 30 cases with the free Groq tier may hit per-minute limits: those show up
as `rate_limited_runs`, not as hidden retries. Add `--pace-seconds N` (live only, CLI default 0, the `Agent evals` workflow passes 12; recorded as `pace_seconds`
in the report metadata) to wait N seconds between cases: one question may use up to 8,000 tokens, a full
minute of one model's free Groq limit, so a pace of 30–60 s avoids most limits. The agent itself waits out a 429 whose reset is ≤ 6 s once per model
and question (see `core/llm.ts`).

The runner is TypeScript with parameter properties, so Node 24 needs `--experimental-transform-types`.
The package script includes it: `npm run agent:local -- --fake-llm --port=8787` starts the same fake runner.

## Release gate inputs

`node scripts/agent-release-check.mjs --sha=<sha>` reads only committed files: `docs/ai-assistant/INTEGRATION.md`
(integration block), `evals/reports/mvp-live.json` (schema 2, `mode: live`, every required case, no fake model),
`evals/cases/required.json` + `mvp.yaml` (coverage, hash) and `docs/ai-assistant/gateway-evidence.json` — written
only by `scripts/agent-gateway-smoke.ts` against a local `supabase functions serve agent`
(`http://127.0.0.1:54321/functions/v1/agent`; usage in the script header). `scripts/agent-test-edge.ts` serves the
handler from its own Deno server and is never gateway evidence.
