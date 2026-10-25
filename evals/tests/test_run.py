import re
import json
from pathlib import Path

from trackora_evals.run import load_cases, main, schema_errors

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "evals" / "cases" / "mvp.yaml"


def test_the_case_set_has_50_scenarios_in_the_planned_language_mix():
    cases = load_cases(str(CASES))
    assert len(cases) == 50
    langs = [c["lang"] for c in cases]
    assert (langs.count("cs"), langs.count("sk"), langs.count("en")) == (28, 10, 12)
    scenarios = {c["scenario"] for c in cases}
    assert {"buy", "injection", "isolation", "retry", "outage", "multi_turn", "unknown", "general", "empty", "movers"} <= scenarios
    # Production fix 2026-10-24: today's movers and general questions in cs/sk/en; none may get the off-topic text.
    movers = [c for c in cases if c["scenario"] == "movers"]
    assert sorted(c["lang"] for c in movers) == ["cs", "en", "sk"] and all("get_stock_news" in c["expect_tools"] for c in movers)
    general = [c for c in cases if c["id"].startswith("general-")]
    assert {c["lang"] for c in general} == {"cs", "sk", "en"}
    assert all(any(re.search(p, "Pomáhám jen Pomáham len I can only help") for p in c.get("forbid", [])) for c in movers + general)
    # Běh 22: why an instrument moved over recent days, in cs/sk/en, with the period move and the S&P 500 required.
    moves = [c for c in cases if c["scenario"] == "move"]
    assert sorted(c["lang"] for c in moves) == ["cs", "cs", "en", "sk"]
    assert all({"get_price_history", "get_peers", "get_stock_news"} <= set(c["expect_tools"]) for c in moves)
    assert all({"history:SYNN:change_pct", "history:SPX:change_pct"} <= {f for g in c["golden"] for f in g["fact_ids"]} for c in moves)
    buys = [c for c in cases if c["scenario"] == "buy"]
    assert len(buys) == 4 and all(c["expect_verdict"] for c in buys)
    # Data-quality users and semantic negatives (Běh 20).
    by_user = {c["user"] for c in cases}
    assert {"A", "B", "C", "D", "E"} <= by_user
    assert len([c for c in cases if c["id"].startswith("neg-")]) == 4


def test_cases_require_every_datum_of_their_intent():
    cases = {c["id"]: c for c in load_cases(str(CASES))}
    ids = lambda case_id: [f for g in cases[case_id]["golden"] for f in g["fact_ids"]]
    assert set(ids("tx-cs-1")) == {f"transactions:all:{k}" for k in ("count", "buy_count", "sell_count", "buy_usd", "sell_usd", "bought_shares", "sold_shares")}
    assert set(ids("realized-cs-1")) == {f"realized:2026:{k}" for k in ("net", "gains", "losses", "proceeds")}
    assert set(ids("sim-cs-1")) == {f"sale:SYNB:{k}" for k in ("proceeds", "gain", "taxable_gain", "extra_tax")}


def test_live_mode_without_a_key_writes_not_run_and_never_a_pass(tmp_path, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    out = tmp_path / "mvp-live"
    assert main(["--cases", str(CASES), "--mode", "live", "--output", str(out), "--repo", str(ROOT)]) == 2
    report = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    assert report["status"] == "NOT RUN"
    assert report["summary"] is None and report["results"] == []
    assert "NOT RUN" in out.with_suffix(".md").read_text(encoding="utf-8")


def test_golden_arguments_are_validated_against_the_served_schema():
    schema = {"type": "object", "additionalProperties": False, "required": ["year"], "properties": {"year": {"type": "integer"}}}
    assert schema_errors({"year": 2026}, schema) == []
    assert schema_errors({}, schema) == ["missing year"]
    assert schema_errors({"year": "2026", "x": 1}, schema) == ["unknown x", "year not integer"]


def _fake_run_case(calls):
    def run_case(_client, case, index, _schemas):
        calls.append(("case", index))
        return {"id": case["id"], "passed": True}
    return run_case


def test_live_mode_paces_between_cases_but_not_before_the_first_or_after_the_last(monkeypatch):
    import trackora_evals.run as run
    calls = []
    monkeypatch.setattr(run, "run_case", _fake_run_case(calls))
    cases = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
    results = run.run_cases(None, cases, {}, mode="live", pace_seconds=7.5, sleep=lambda s: calls.append(("sleep", s)))
    assert [r["id"] for r in results] == ["a", "b", "c"]
    assert calls == [("case", 1), ("sleep", 7.5), ("case", 2), ("sleep", 7.5), ("case", 3)]


def test_pacing_is_off_by_default_and_never_applied_in_fake_mode(monkeypatch):
    import trackora_evals.run as run
    sleeps = []
    monkeypatch.setattr(run, "run_case", _fake_run_case([]))
    cases = [{"id": "a"}, {"id": "b"}]
    run.run_cases(None, cases, {}, mode="live", pace_seconds=0, sleep=sleeps.append)
    run.run_cases(None, cases, {}, mode="fake", pace_seconds=10, sleep=sleeps.append)
    assert sleeps == []
    assert run.applied_pace("live", 10) == 10 and run.applied_pace("fake", 10) == 0 and run.applied_pace("live", 0) == 0


def test_pacing_is_recorded_in_the_report_metadata(tmp_path, monkeypatch):
    import trackora_evals.run as run
    meta = run.metadata_for("live", ROOT, {"openai/gpt-oss-120b"}, pace_seconds=12)
    assert meta["pace_seconds"] == 12
    assert run.metadata_for("fake", ROOT, set())["pace_seconds"] == 0
    # The NOT RUN report records the requested pacing too.
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    out = tmp_path / "mvp-live"
    assert main(["--cases", str(CASES), "--mode", "live", "--output", str(out), "--repo", str(ROOT), "--pace-seconds", "8"]) == 2
    report = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    assert report["metadata"]["pace_seconds"] == 8
    assert "| pace_seconds | 8" in out.with_suffix(".md").read_text(encoding="utf-8")


def test_negative_pacing_is_rejected(capsys):
    import pytest
    with pytest.raises(SystemExit):
        main(["--mode", "live", "--output", "x", "--pace-seconds", "-1"])
