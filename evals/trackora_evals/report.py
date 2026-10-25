"""JSON + Markdown eval reports (schema 2). A fake report states that it says nothing about model quality or production latency.

Schema 2: every result keeps its own per-turn evidence (`turns`, each with per-attempt model usage when the
audit reports it); the summary is recomputed here from the results and recomputed again by the release
gate (`scripts/agent-release-check.mjs`), which never trusts it. The metadata names the case set that ran
(`cases_sha256`, `case_ids`).
"""

from __future__ import annotations

import json
from pathlib import Path

from .score import failures_of, summarize

REPORT_SCHEMA_VERSION = 2
REQUIRED_METADATA = ("mode", "git_sha", "calculation_version", "date", "model", "seed", "frozen_market_date", "pace_seconds",
                     "cases_sha256", "case_ids")
FAKE_NOTE = ("FAKE mode: deterministic fake model (rate-limited router, provocative writer). This report is evidence of the harness, "
             "the grounding/safety path and the verified templates only — it makes no claim about Groq model quality, "
             "answer language quality or production p95 latency.")


def _check_result(result: dict) -> None:
    expected = failures_of(result["checks"])
    if result["failures"] != expected or result["passed"] != (not expected):
        raise ValueError(f"result {result.get('id')}: passed/failures contradicts its checks")
    if not result.get("turns"):
        raise ValueError(f"result {result.get('id')}: no per-turn evidence")


def write_report(results: list[dict], metadata: dict, path: str) -> None:
    """Writes `<path>.json` and `<path>.md` (a trailing .json/.md in `path` is ignored)."""
    missing = [k for k in REQUIRED_METADATA if k not in metadata]
    if missing:
        raise ValueError(f"report metadata missing: {', '.join(missing)}")
    for result in results:
        _check_result(result)
    base = Path(path)
    if base.suffix in (".json", ".md"):
        base = base.with_suffix("")
    base.parent.mkdir(parents=True, exist_ok=True)
    status = metadata.get("status", "RUN")
    summary = summarize(results) if results else None
    document = {"schema_version": REPORT_SCHEMA_VERSION, "status": status, "metadata": metadata, "summary": summary, "results": results}
    if metadata["mode"] == "fake":
        document["note"] = FAKE_NOTE
    base.with_suffix(".json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    base.with_suffix(".md").write_text(_markdown(document), encoding="utf-8", newline="\n")


def _ms(stats: dict) -> str:
    return f"n={stats['n']}: p50 {stats['p50']}, p95 {stats['p95']}, max {stats['max']}"


def _markdown(doc: dict) -> str:
    meta, summary = doc["metadata"], doc["summary"]
    lines = [f"# Trackora assistant eval — {meta['mode']}", ""]
    if doc.get("note"):
        lines += [f"> {doc['note']}", ""]
    shown = {k: (f"{len(v)} cases" if k == "case_ids" else v) for k, v in meta.items()}
    lines += ["| Metadata | Value |", "| --- | --- |"] + [f"| {k} | {shown[k]} |" for k in shown] + [""]
    if doc["status"] != "RUN":
        lines += [f"**Status: {doc['status']}.** {meta.get('reason', '')}", ""]
        return "\n".join(lines) + "\n"
    s = summary
    t = s["tokens"]
    lines += [
        "## Summary", "",
        "| Metric | Value |", "| --- | --- |",
        f"| Cases (all in the denominator) | {s['cases']} |",
        f"| Passed | {s['passed']} ({s['pass_rate']:.0%}) |",
        f"| Portfolio text cases with required data | {s['portfolio_text_passed']} of {s['portfolio_text_cases']} ({s['portfolio_text_pass_rate']:.0%}) |"
        if s["portfolio_text_cases"] else "| Portfolio text cases | 0 |",
        f"| Unverified numbers shown | {s['unverified_numbers']} |",
        f"| Answers with technical labels | {s['technical_labels']} |",
        f"| A/B leaks | {s['leaks']} |",
        f"| Other failures in isolation cases | {s['isolation_other_failures']} |",
        f"| Unterminated requests | {s['unterminated']} |",
        f"| Verdict checks OK | {s['verdict_ok']} of {s['verdict_cases']} |",
        f"| Outcomes | {', '.join(f'{k}: {v}' for k, v in sorted(s['outcomes'].items()))} |",
        f"| Verified-template share | {s['template_share']:.0%} |",
        f"| Runs with a model rate limit | {s['rate_limited_runs']} |",
        f"| Timeouts | {s['timeouts']} |",
        f"| Wall ms, cold (first turn of a case) | {_ms(s['wall_ms']['cold'])} |",
        f"| Wall ms, warm (follow-up turns) | {_ms(s['wall_ms']['warm'])} |",
        f"| Tokens: max per call / per question | {t['max_call']} / {t['max_question']} (limits 3,000 / 8,000) |",
        f"| Calls over their cap (3,000; analyst 5,000) / questions over 8,000 | {t['call_limit_violations']} / {t['question_limit_violations']} |",
        f"| Questions without per-attempt usage | {t['turns_without_attempts']} |",
        "",
        "Latency is the measured sample of this run only (local loopback runner), not a production guarantee.", "",
        "## Cases", "", "| Case | Scenario | Lang | Result | Outcome | Turns | Wall ms | Failed checks |",
        "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ]
    for r in doc["results"]:
        asked = [x for x in r["turns"] if not x["replay"]]
        last = asked[-1] if asked else r["turns"][-1]
        lines.append(f"| {r['id']} | {r['scenario']} | {r['lang']} | {'PASS' if r['passed'] else 'FAIL'} | {last['outcome'] or last['terminal']} | "
                     f"{len(asked)} | {sum(x['wall_ms'] for x in asked):.1f} | {', '.join(r['failures']) or '—'} |")
    return "\n".join(lines) + "\n"
