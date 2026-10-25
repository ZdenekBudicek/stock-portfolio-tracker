"""HTTP client of the agent runner: SSE chat with a hard client deadline, direct tools and the local eval audit.

Every way a request can end is recorded in `ChatResult.terminal`; nothing waits forever and no
failure is dropped. The audit route exists only in the loopback eval runner, never in production.
"""

from __future__ import annotations

import codecs
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

CLIENT_DEADLINE_S = 50.0  # the UI aborts at 50 s; the server's own limit is 45 s


class SseParser:
    """Incremental SSE parser: UTF-8 split across chunks, CRLF, multi-line data, comments."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._data: list[str] = []

    def push(self, chunk: bytes) -> list[dict]:
        self._buffer += self._decoder.decode(chunk)
        return self._drain()

    def finish(self) -> list[dict]:
        self._buffer += self._decoder.decode(b"", final=True)
        if self._buffer and not self._buffer.endswith("\n"):
            self._buffer += "\n"
        events = self._drain()
        return events + self._dispatch()

    def _drain(self) -> list[dict]:
        events: list[dict] = []
        while True:
            cut = self._buffer.find("\n")
            if cut < 0:
                return events
            line, self._buffer = self._buffer[:cut].rstrip("\r"), self._buffer[cut + 1:]
            if line == "":
                events += self._dispatch()
            elif line.startswith(":"):
                continue
            elif line.startswith("data:"):
                self._data.append(line[5:].removeprefix(" "))

    def _dispatch(self) -> list[dict]:
        if not self._data:
            return []
        raw, self._data = "\n".join(self._data), []
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            return [{"type": "_invalid"}]
        return [event] if isinstance(event, dict) and isinstance(event.get("type"), str) else [{"type": "_invalid"}]


@dataclass
class ChatResult:
    events: list[dict]
    text: str | None
    links: list[dict]
    terminal: str  # done | eof | http_error | timeout | transport_error | invalid
    http_status: int | None
    outcome: str | None
    error_code: str | None
    persisted: bool | None
    ttft_ms: float | None  # first server event after sending
    wall_ms: float
    tokens: dict = field(default_factory=lambda: {"in": None, "out": None})
    audit: dict | None = None
    failure: str | None = None
    remaining_today: int | None = None
    request_id: str | None = None


class AgentClient:
    def __init__(self, base: str, *, transport: httpx.BaseTransport | None = None, total_timeout: float = CLIENT_DEADLINE_S) -> None:
        self.base = base.rstrip("/")
        self.total_timeout = total_timeout
        # Read timeout below the total deadline, so a silent socket ends too.
        self._http = httpx.Client(transport=transport, timeout=httpx.Timeout(10.0, read=min(15.0, total_timeout)), follow_redirects=False)

    def close(self) -> None:
        self._http.close()

    @staticmethod
    def _headers(token: str | None) -> dict:
        return {"Authorization": f"Bearer {token}"} if token else {}

    def chat(self, request: dict, token: str | None) -> ChatResult:
        started = time.monotonic()
        deadline = started + self.total_timeout
        events: list[dict] = []
        first: float | None = None
        terminal, status, failure = "eof", None, None
        try:
            with self._http.stream("POST", f"{self.base}/agent/chat", headers=self._headers(token), json=request) as response:
                status = response.status_code
                if status != 200:
                    response.read()
                    terminal, failure = "http_error", f"http {status}"
                else:
                    parser = SseParser()
                    for chunk in response.iter_bytes():
                        if first is None:
                            first = time.monotonic()
                        events += parser.push(chunk)
                        if any(e["type"] == "done" for e in events):
                            terminal = "done"
                            break
                        if time.monotonic() > deadline:
                            terminal, failure = "timeout", "client deadline"
                            break
                    else:
                        events += parser.finish()
                        terminal = "done" if any(e["type"] == "done" for e in events) else "eof"
        except httpx.TimeoutException:
            terminal, failure = "timeout", "client deadline"
        except httpx.HTTPError as error:
            terminal, failure = "transport_error", type(error).__name__
        if terminal == "eof":
            failure = "stream ended without done"
        if any(e["type"] == "_invalid" for e in events):
            terminal, failure = "invalid", "invalid event"
        wall = (time.monotonic() - started) * 1000
        answer = next((e for e in events if e["type"] == "answer"), None)
        error = next((e for e in events if e["type"] == "error"), None)
        done = next((e for e in events if e["type"] == "done"), None)
        meta = next((e for e in events if e["type"] == "meta"), None)
        audit = self.audit(request.get("requestId", ""), token) if terminal == "done" else None
        metrics = (audit or {}).get("metrics") or {}
        return ChatResult(
            events=events, text=answer.get("text") if answer else None, links=answer.get("links", []) if answer else [],
            terminal=terminal, http_status=status, outcome=done.get("outcome") if done else None,
            error_code=error.get("code") if error else None, persisted=done.get("persisted") if done else None,
            ttft_ms=(first - started) * 1000 if first else None, wall_ms=wall,
            tokens={"in": metrics.get("tokensIn"), "out": metrics.get("tokensOut")}, audit=audit, failure=failure,
            remaining_today=meta.get("remainingToday") if meta else None, request_id=request.get("requestId"),
        )

    def audit(self, request_id: str, token: str | None) -> dict | None:
        """The loopback runner's evidence of a run (facts, calculations, metrics); None where it does not exist."""
        try:
            response = self.audit_response(request_id, token)
        except httpx.HTTPError:
            return None
        return response.json() if response.status_code == 200 else None

    def audit_response(self, request_id: str, token: str | None) -> httpx.Response:
        return self._http.get(f"{self.base}/agent/eval/runs/{request_id}", headers=self._headers(token))

    def tools(self, token: str | None) -> list[dict]:
        response = self._http.get(f"{self.base}/agent/tools", headers=self._headers(token))
        response.raise_for_status()
        return response.json().get("tools", [])

    def tool(self, name: str, args: dict, token: str | None) -> dict:
        try:
            response = self._http.post(f"{self.base}/agent/tools/{name}", headers=self._headers(token),
                                       json={"requestId": str(uuid.uuid4()), "args": args})
        except httpx.HTTPError as error:
            return {"ok": False, "error": {"code": "transport", "message": type(error).__name__}}
        if response.status_code != 200:
            try:
                message = response.json().get("error", "")
            except ValueError:
                message = ""
            return {"ok": False, "error": {"code": f"http_{response.status_code}", "message": str(message)[:200]}}
        return response.json()

    def threads(self, token: str | None) -> httpx.Response:
        return self._http.get(f"{self.base}/agent/threads", headers=self._headers(token))

    def thread(self, thread_id: str, token: str | None, method: str = "GET") -> httpx.Response:
        return self._http.request(method, f"{self.base}/agent/threads/{thread_id}", headers=self._headers(token))
