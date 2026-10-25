"""CLI: python -m trackora_evals.run --base http://127.0.0.1:8787 --cases evals/cases/mvp.yaml --mode fake|live --output evals/reports/mvp-fake [--pace-seconds N]

The runner must already be listening (see evals/README.md). Live mode refuses to run without
GROQ_API_KEY in this process's environment and then writes a NOT RUN report; the key value is never
read beyond its presence, printed or written. Every case uses its own synthetic fixture identity
(`fixture-user-a-<n>`), so the 20-question daily limit of one identity does not cut the run.
`--pace-seconds N` (live mode only) sleeps N seconds between cases so the free per-minute token limits
can recover; the applied pacing is recorded in the report metadata.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import uuid
from typing import Callable
from pathlib import Path

import httpx

import yaml

from .client import AgentClient, ChatResult
from .manifest import cases_sha256
from .report import write_report
from .score import failures_of, score_case, turn_record

CASE_KEYS = {"id": str, "lang": str, "user": str, "turns": list, "expect_tools": list, "golden": list, "expect_verdict": bool, "scenario": str}
OPTIONAL_KEYS = {"expect_insufficient", "expect_error", "forbid", "require", "note"}
FAKE_MODEL = "fake-llm (rate-limited router, provocative writer)"
# Synthetic fixture users: A (CZ), B (SK), C (residence outside every tax model), D (CZ, purchase FX missing), E (empty).
USERS = ("A", "B", "C", "D", "E")


def load_cases(path: str) -> list[dict]:
    cases = yaml.safe_load(Path(path).read_text(encoding="utf-8"))["cases"]
    seen = set()
    for case in cases:
        for key, kind in CASE_KEYS.items():
            if not isinstance(case.get(key), kind):
                raise ValueError(f"case {case.get('id')}: {key} must be {kind.__name__}")
        extra = set(case) - set(CASE_KEYS) - OPTIONAL_KEYS
        if extra or case["lang"] not in ("cs", "sk", "en") or case["user"] not in USERS or not case["turns"] or case["id"] in seen:
            raise ValueError(f"case {case['id']}: invalid ({', '.join(sorted(extra)) or 'lang/user/turns/id'})")
        seen.add(case["id"])
    return cases


def schema_errors(args: dict, schema: dict) -> list[str]:
    """The subset of JSON Schema the tools use at the top level: required, unknown keys, enum and basic types."""
    errors = [f"missing {k}" for k in schema.get("required", []) if k not in args]
    props = schema.get("properties", {})
    if schema.get("additionalProperties") is False:
        errors += [f"unknown {k}" for k in args if k not in props]
    types = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict, "array": list}
    for key, value in args.items():
        prop = props.get(key, {})
        if "enum" in prop and value not in prop["enum"]:
            errors.append(f"{key} not in enum")
        if isinstance(prop.get("type"), str) and prop["type"] in types and not isinstance(value, types[prop["type"]]):
            errors.append(f"{key} not {prop['type']}")
    return errors


def git_sha(repo: Path) -> str:
    try:
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        return f"{sha}{'+dirty' if dirty else ''}"
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def applied_pace(mode: str, pace_seconds: float) -> float:
    """Pacing only matters against a live provider; fake runs are never slowed down."""
    return pace_seconds if mode == "live" and pace_seconds > 0 else 0


def metadata_for(mode: str, repo: Path, models: set[str], pace_seconds: float = 0, cases_path: str | None = None,
                 cases: list[dict] | None = None) -> dict:
    manifest = json.loads((repo / "supabase/functions/agent/_lib/manifest.json").read_text(encoding="utf-8"))
    fixture = json.loads((repo / "supabase/functions/agent/fixtures/demo.json").read_text(encoding="utf-8"))
    return {"mode": mode, "git_sha": git_sha(repo), "calculation_version": manifest.get("calculationVersion"),
            "date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "model": FAKE_MODEL if mode == "fake" else (", ".join(sorted(models)) or "none (no model answered)"),
            "seed": fixture.get("seed"), "frozen_market_date": fixture.get("today"), "pace_seconds": applied_pace(mode, pace_seconds),
            "cases_sha256": cases_sha256(cases_path) if cases_path else None, "case_ids": [c["id"] for c in cases or []]}


def run_case(client: AgentClient, case: dict, index: int, schemas: dict) -> dict:
    token = f"fixture-user-{case['user'].lower()}-{index}"
    golden: dict = {}
    harness_errors: list[str] = []
    for g in case["golden"]:
        errors = schema_errors(g["args"], schemas.get(g["tool"], {}).get("inputSchema", {})) if g["tool"] in schemas else [f"unknown tool {g['tool']}"]
        if errors:
            harness_errors.append(f"{g['tool']}: {'; '.join(errors)}")
            continue
        result = client.tool(g["tool"], g["args"], token)
        if not result.get("ok"):
            harness_errors.append(f"{g['tool']}: {result.get('error', {}).get('code')}")
            continue
        golden.update({f["id"]: f for f in result.get("facts", []) if f["id"] in g["fact_ids"]})
    thread_id = None
    last: ChatResult | None = None
    request: dict = {}
    turns: list[dict] = []
    for i, turn in enumerate(case["turns"]):
        request = {"requestId": str(uuid.uuid4()), "question": turn, **({"threadId": thread_id} if thread_id else {})}
        last = client.chat(request, token)
        # Cold: the first request of a case (new identity, new thread); warm: its follow-up turns.
        turns.append(turn_record(last, i, "cold" if i == 0 else "warm"))
        meta = next((e for e in last.events if e.get("type") == "meta"), None)
        thread_id = thread_id or (meta or {}).get("threadId")
        if last.terminal != "done":
            break
    extra: dict = {}
    if case["scenario"] == "retry" and last and last.terminal == "done":
        # The exact retry of a completed request: same text, no second quota use.
        replay = client.chat(dict(request), token)
        turns.append(turn_record(replay, len(turns), "warm", replay=True))
        extra["replay_same_text"] = replay.text == last.text and replay.text is not None
        extra["replay_no_quota"] = replay.remaining_today == last.remaining_today
    scored = score_case(case, last, golden, turns=turns)
    if case["scenario"] == "isolation" and last and last.request_id:
        # Another fixture user must not see this run's audit or thread.
        other = f"fixture-user-{'b' if case['user'] == 'A' else 'a'}-{index}"
        for name, probe in [("foreign_audit_hidden", lambda: client.audit_response(last.request_id, other)),
                            ("foreign_thread_hidden", lambda: client.thread(thread_id, other) if thread_id else None)]:
            try:
                response = probe()
                status = response.status_code if response is not None else None
                if status == 404 or (status is not None and 200 <= status < 300):
                    extra[name] = status == 404
                else:
                    harness_errors.append(f"{name}: probe unavailable")
            except httpx.HTTPError:
                harness_errors.append(f"{name}: probe unavailable")
    if harness_errors:
        extra["harness_errors"] = harness_errors
    scored["checks"].update(extra)
    scored["failures"] = failures_of(scored["checks"])
    scored["passed"] = not scored["failures"]
    return scored


def run_cases(client: AgentClient, cases: list[dict], schemas: dict, mode: str, pace_seconds: float = 0,
              sleep: Callable[[float], None] = time.sleep) -> list[dict]:
    """Runs every case in order; in live mode waits `pace_seconds` between cases (not before the first or after the last)."""
    pace = applied_pace(mode, pace_seconds)
    results = []
    for i, case in enumerate(cases):
        if i and pace:
            sleep(pace)
        results.append(run_case(client, case, i + 1, schemas))
    return results


def _pace(value: str) -> float:
    seconds = float(value)
    if not seconds >= 0 or seconds == float("inf"):
        raise argparse.ArgumentTypeError("must be a finite number >= 0")
    return int(seconds) if seconds.is_integer() else seconds


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://127.0.0.1:8787")
    parser.add_argument("--cases", default="evals/cases/mvp.yaml")
    parser.add_argument("--mode", choices=["fake", "live"], required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--pace-seconds", type=_pace, default=0, help="live mode: seconds to wait between cases (default 0)")
    args = parser.parse_args(argv)
    repo = Path(args.repo).resolve()
    cases = load_cases(args.cases)
    if args.mode == "live" and not os.environ.get("GROQ_API_KEY"):
        meta = metadata_for("live", repo, set(), args.pace_seconds, args.cases, cases)
        meta.update(status="NOT RUN", reason="GROQ_API_KEY is not set in the process environment; no live result exists.", cases=len(cases))
        write_report([], meta, args.output)
        print("NOT RUN: GROQ_API_KEY missing; wrote a NOT RUN report.", file=sys.stderr)
        return 2
    client = AgentClient(args.base)
    try:
        schemas = {t["name"]: t for t in client.tools("fixture-user-a")}
        results = run_cases(client, cases, schemas, args.mode, args.pace_seconds)
    finally:
        client.close()
    models = {r["model"] for r in results if r.get("model")}
    write_report(results, metadata_for(args.mode, repo, models, args.pace_seconds, args.cases, cases), args.output)
    passed = sum(r["passed"] for r in results)
    print(f"{args.mode}: {passed}/{len(results)} cases passed -> {args.output}.json/.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
