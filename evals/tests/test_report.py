import json
from pathlib import Path

import pytest

from trackora_evals.client import ChatResult
from trackora_evals.manifest import cases_sha256, required_manifest
from trackora_evals.report import REPORT_SCHEMA_VERSION, write_report
from trackora_evals.run import load_cases, run_case
from trackora_evals.score import score_case, summarize, turn_record

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "evals" / "cases" / "mvp.yaml"
META = {"mode": "live", "git_sha": "a" * 40, "calculation_version": "b" * 64, "date": "2026-10-23T12:00:00+00:00", "model": "m",
        "seed": 1, "frozen_market_date": "2026-10-23", "pace_seconds": 12, "cases_sha256": "c" * 64, "case_ids": ["c1"]}


def chat(text="Bez čísel.", terminal="done", attempts=None, tokens=(100, 20), request_id="r1", wall=10.0):
    metrics = {"model": "m", "tokensIn": tokens[0], "tokensOut": tokens[1], "maxCallTokens": 120, "outcome": "ok", "errorCode": None}
    if attempts is not None:
        metrics["attempts"] = attempts
    audit = {"metrics": metrics, "facts": [], "calculations": [], "toolsUsed": [], "snapshotId": "fixture-A"}
    return ChatResult(events=[{"type": "meta", "threadId": "t1"}], text=text, links=[], terminal=terminal, http_status=200, outcome="ok",
                      error_code=None, persisted=True, ttft_ms=1.0, wall_ms=wall, tokens={"in": tokens[0], "out": tokens[1]}, audit=audit,
                      failure=None, request_id=request_id)


ATTEMPT = {"id": "a1", "phase": "writer", "model": "m", "chargedInput": 1000, "chargedOutput": 200, "usageSource": "reported",
           "finishReason": "stop", "outcome": "ok"}
CASE = {"id": "c1", "lang": "cs", "user": "A", "turns": ["Ahoj"], "expect_tools": [], "golden": [], "expect_verdict": False, "scenario": "general"}


@pytest.mark.parametrize("extra,leaks,other", [
    ({"tools_missing": ["get_portfolio_summary"]}, 0, 1),
    ({"forbidden": ["SYNA"]}, 1, 0),
    ({"foreign_thread_hidden": False}, 1, 0),
    ({"foreign_audit_hidden": False}, 1, 0),
    ({"forbidden": ["SYNA"], "required_missing": ["portfolio:total_value"]}, 1, 1),
])
def test_isolation_counts_leaks_separately_from_answer_failures(extra, leaks, other):
    from trackora_evals.score import failures_of
    scored = score_case({**CASE, "scenario": "isolation"}, chat(), {})
    scored["checks"].update({"foreign_thread_hidden": True, "foreign_audit_hidden": True, **extra})
    scored["failures"] = failures_of(scored["checks"])
    scored["passed"] = not scored["failures"]
    summary = summarize([scored])
    assert summary["leaks"] == leaks
    assert summary["isolation_other_failures"] == other


def test_attempt_rejection_codes_survive_report_without_private_suffixes():
    attempt = {**ATTEMPT, "outcome": "http", "rejectionReasons": ["http_400", "invalid_request_error", "tool_use_failed",
               "unknown_fact:private-987654", "private-987654"]}
    turn = turn_record(chat(attempts=[attempt]), 0, "cold")
    assert turn["attempts"][0]["rejection_reasons"] == ["http_400", "invalid_request_error", "tool_use_failed", "unknown_fact", "invalid"]
    assert "private" not in json.dumps(turn)


def test_audit_allowlist_matches_the_runtime():
    import re
    from trackora_evals.score import REJECTION_CODES
    source = (ROOT / "supabase/functions/agent/core/attemptReasons.ts").read_text(encoding="utf-8")
    codes = set(re.findall(r"'([^']+)'", source.split("new Set([", 1)[1].split("]);", 1)[0]))
    assert REJECTION_CODES == codes


def test_each_turn_keeps_its_own_evidence_including_per_attempt_usage():
    turn = turn_record(chat(attempts=[ATTEMPT]), 0, "cold")
    assert turn["attempts"] == [{"phase": "writer", "model": "m", "tokens_in": 1000, "tokens_out": 200, "usage_source": "reported",
                                 "finish_reason": "stop", "outcome": "ok"}]
    assert turn["phase"] == "cold" and turn["replay"] is False and turn["tokens"] == {"in": 100, "out": 20, "max_call": 120}
    # Without per-attempt usage the limits are unproven, never assumed to be zero.
    assert turn_record(chat(), 0, "cold")["attempts"] is None


def test_token_limits_are_checked_per_attempt_and_per_question():
    big_call = {**ATTEMPT, "chargedInput": 2900, "chargedOutput": 200}
    many = [{**ATTEMPT, "chargedInput": 2500, "chargedOutput": 200}] * 3
    scored = [score_case(CASE, chat(), {}, turns=[turn_record(chat(attempts=[big_call]), 0, "cold")]),
              score_case({**CASE, "id": "c2"}, chat(), {}, turns=[turn_record(chat(attempts=many), 0, "cold")]),
              score_case({**CASE, "id": "c3"}, chat(), {}, turns=[turn_record(chat(), 0, "cold")])]
    tokens = summarize(scored)["tokens"]
    assert tokens["call_limit_violations"] == 1
    assert tokens["question_limit_violations"] == 1
    assert tokens["turns_without_attempts"] == 1
    assert tokens["max_call"] == 3100 and tokens["max_question"] == 8100


def test_the_news_analyst_call_may_use_5000_tokens_and_no_other_call_may():
    analyst = {**ATTEMPT, "phase": "answer", "callLimit": 5000, "chargedInput": 3500, "chargedOutput": 1400}
    over = {**analyst, "chargedInput": 3700}
    router = {**ATTEMPT, "phase": "router", "callLimit": 5000, "chargedInput": 2900, "chargedOutput": 200}
    writer = {**ATTEMPT, "phase": "answer", "callLimit": 3000, "chargedInput": 2900, "chargedOutput": 200}
    claimed = {**ATTEMPT, "phase": "answer", "callLimit": 9000, "chargedInput": 2900, "chargedOutput": 200}
    turn = turn_record(chat(attempts=[analyst]), 0, "cold")
    assert turn["attempts"][0]["call_limit"] == 5000
    for attempts, violations in (([analyst], 0), ([over], 1), ([router], 1), ([writer], 1), ([claimed], 1)):
        scored = [score_case(CASE, chat(), {}, turns=[turn_record(chat(attempts=attempts), 0, "cold")])]
        assert summarize(scored)["tokens"]["call_limit_violations"] == violations, attempts


def test_latency_is_split_into_cold_and_warm_and_replays_are_not_new_questions():
    turns = [turn_record(chat(wall=900.0), 0, "cold"), turn_record(chat(wall=100.0, request_id="r2"), 1, "warm"),
             turn_record(chat(wall=5.0, request_id="r2"), 2, "warm", replay=True)]
    summary = summarize([score_case(CASE, chat(), {}, turns=turns)])
    assert summary["wall_ms"]["cold"] == {"n": 1, "p50": 900.0, "p95": 900.0, "max": 900.0}
    assert summary["wall_ms"]["warm"] == {"n": 1, "p50": 100.0, "p95": 100.0, "max": 100.0}


def test_the_report_recomputes_the_summary_and_refuses_a_result_whose_flag_contradicts_its_checks(tmp_path):
    scored = score_case(CASE, chat(), {})
    out = tmp_path / "r"
    write_report([scored], META, str(out))
    doc = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    assert doc["schema_version"] == REPORT_SCHEMA_VERSION == 2
    assert doc["summary"] == json.loads(json.dumps(summarize([scored])))
    assert set(doc) == {"schema_version", "status", "metadata", "summary", "results"}
    lying = {**scored, "passed": False}
    with pytest.raises(ValueError, match="contradicts"):
        write_report([lying], META, str(tmp_path / "x"))


def test_report_metadata_names_the_case_set_it_ran(tmp_path):
    with pytest.raises(ValueError, match="cases_sha256"):
        write_report([], {k: v for k, v in META.items() if k != "cases_sha256"}, str(tmp_path / "y"))


def test_the_committed_required_case_list_matches_the_case_file():
    required = json.loads((ROOT / "evals" / "cases" / "required.json").read_text(encoding="utf-8"))
    assert required == required_manifest(str(CASES))
    assert required["cases_sha256"] == cases_sha256(str(CASES))
    assert [c["id"] for c in required["cases"]] == [c["id"] for c in load_cases(str(CASES))]


def test_the_case_hash_ignores_line_endings(tmp_path):
    lf, crlf = tmp_path / "a.yaml", tmp_path / "b.yaml"
    lf.write_bytes(b"cases: []\n")
    crlf.write_bytes(b"cases: []\r\n")
    assert cases_sha256(str(lf)) == cases_sha256(str(crlf))


class FakeClient:
    """Two-turn conversation then nothing else; records the identities it was called with."""

    def __init__(self):
        self.calls = []

    def tool(self, name, args, token):
        return {"ok": True, "facts": []}

    def chat(self, request, token):
        self.calls.append((request["question"], token))
        return chat(request_id=request["requestId"], attempts=[ATTEMPT], wall=50.0 * len(self.calls))


def test_a_multi_turn_case_records_every_turn_cold_then_warm():
    client = FakeClient()
    case = {**CASE, "turns": ["Ahoj", "A dál?"], "user": "C"}
    scored = run_case(client, case, 3, {})
    assert [(t["index"], t["phase"]) for t in scored["turns"]] == [(0, "cold"), (1, "warm")]
    assert all(t["attempts"] for t in scored["turns"])
    assert [token for _, token in client.calls] == ["fixture-user-c-3", "fixture-user-c-3"]


@pytest.mark.parametrize("status,leaks,other", [(404, 0, 0), (200, 1, 0), (503, 0, 1)])
def test_isolation_probes_distinguish_visible_from_unavailable(status, leaks, other):
    import httpx

    class IsolationClient(FakeClient):
        def audit(self, request_id, token):
            return {} if status == 200 else None

        def audit_response(self, request_id, token):
            return httpx.Response(status, json={})

        def thread(self, thread_id, token):
            return httpx.Response(status, json={})

    scored = run_case(IsolationClient(), {**CASE, "scenario": "isolation"}, 1, {})
    summary = summarize([scored])
    assert summary["leaks"] == leaks
    assert summary["isolation_other_failures"] == other
