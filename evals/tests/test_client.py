import json
import time

import httpx

from trackora_evals.client import AgentClient, SseParser


def sse(*events: dict) -> bytes:
    return b"".join(f"data: {json.dumps(e, ensure_ascii=False)}\n\n".encode() for e in events)


META = {"type": "meta", "requestId": "r1", "threadId": "t1", "remainingToday": 19}
ANSWER = {"type": "answer", "text": "Hodnota portfolia je 3 050 USD.", "links": [], "verified": True}
DONE = {"type": "done", "requestId": "r1", "persisted": True, "outcome": "fallback"}
AUDIT = {"metrics": {"tokensIn": 10, "tokensOut": 5, "outcome": "fallback"}, "facts": [], "calculations": [], "toolsUsed": [], "snapshotId": "fixture-A"}


def client_for(handler, **kwargs) -> AgentClient:
    return AgentClient("http://127.0.0.1:8787", transport=httpx.MockTransport(handler), **kwargs)


def test_parser_handles_split_utf8_crlf_multiline_data_and_comments():
    raw = ': keep-alive\r\ndata: {"type":"status",\r\ndata: "text":"Načítám…"}\r\n\r\n' + sse(ANSWER).decode()
    data = raw.encode()
    parser, events = SseParser(), []
    for i in range(len(data)):
        events += parser.push(data[i:i + 1])
    events += parser.finish()
    assert [e["type"] for e in events] == ["status", "answer"]
    assert events[0]["text"] == "Načítám…"


def test_parser_reports_invalid_json_as_an_error_event():
    parser = SseParser()
    events = parser.push(b"data: {broken\n\n")
    assert events == [{"type": "_invalid"}]


def test_chat_collects_events_text_timing_and_the_local_audit():
    def handler(request: httpx.Request):
        if request.url.path == "/agent/chat":
            assert request.headers["Authorization"] == "Bearer fixture-user-a"
            return httpx.Response(200, content=sse(META, {"type": "status", "text": "…"}, ANSWER, DONE))
        if request.url.path == "/agent/eval/runs/r1":
            return httpx.Response(200, json=AUDIT)
        return httpx.Response(404)

    result = client_for(handler).chat({"requestId": "r1", "question": "Kolik mám?"}, "fixture-user-a")
    assert result.terminal == "done"
    assert result.text == ANSWER["text"]
    assert result.outcome == "fallback" and result.persisted is True
    assert result.ttft_ms is not None and result.wall_ms >= result.ttft_ms
    assert result.audit == AUDIT
    assert result.tokens == {"in": 10, "out": 5}
    assert result.failure is None


def test_eof_without_done_is_a_recorded_failure_not_a_hang():
    def handler(request: httpx.Request):
        if request.url.path == "/agent/chat":
            return httpx.Response(200, content=sse(META, {"type": "status", "text": "Pracuji"}))
        return httpx.Response(404)

    result = client_for(handler).chat({"requestId": "r1", "question": "x"}, "fixture-user-a")
    assert result.terminal == "eof"
    assert result.failure == "stream ended without done"
    assert result.text is None


def test_http_401_before_the_stream_is_a_failure_with_its_status():
    result = client_for(lambda request: httpx.Response(401, json={"error": "Přihlas se prosím znovu."})).chat({"requestId": "r1", "question": "x"}, None)
    assert result.terminal == "http_error"
    assert result.http_status == 401
    assert result.failure == "http 401"


def test_an_open_stream_that_never_finishes_ends_at_the_client_deadline():
    class Endless(httpx.SyncByteStream):
        def __iter__(self):
            yield sse(META)
            while True:
                time.sleep(0.05)
                yield b": still here\n\n"

    def handler(request: httpx.Request):
        return httpx.Response(200, stream=Endless()) if request.url.path == "/agent/chat" else httpx.Response(404)

    started = time.monotonic()
    result = client_for(handler, total_timeout=0.4).chat({"requestId": "r1", "question": "x"}, "fixture-user-a")
    assert time.monotonic() - started < 3
    assert result.terminal == "timeout"
    assert result.failure == "client deadline"


def test_an_error_event_is_terminal_with_its_code():
    def handler(request: httpx.Request):
        if request.url.path == "/agent/chat":
            return httpx.Response(200, content=sse(META, {"type": "error", "code": "quota", "text": "Dnešních 20 dotazů je vyčerpáno."}, {**DONE, "outcome": "error"}))
        return httpx.Response(404)

    result = client_for(handler).chat({"requestId": "r1", "question": "x"}, "fixture-user-a")
    assert result.terminal == "done"
    assert result.error_code == "quota"
    assert result.text is None


def test_tool_posts_request_id_and_args_and_returns_the_tool_result():
    seen = {}

    def handler(request: httpx.Request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "facts": [{"id": "quote:SYNA:price", "value": 150}], "data": {}, "meta": {}})

    result = client_for(handler).tool("get_quote", {"ticker": "SYNA"}, "fixture-user-a")
    assert result["ok"] is True
    assert seen["args"] == {"ticker": "SYNA"} and len(seen["requestId"]) == 36


def test_tool_http_failure_is_returned_not_raised():
    result = client_for(lambda request: httpx.Response(404, json={"error": "Nenalezeno."})).tool("get_quote", {"ticker": "SYNA"}, "fixture-user-a")
    assert result == {"ok": False, "error": {"code": "http_404", "message": "Nenalezeno."}}
