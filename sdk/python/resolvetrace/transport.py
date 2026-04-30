"""Async HTTP transport for the events ingest path.

Implements the batching + retry + backpressure behavior mandated by the SDK
envelope (ADR-0001). All outbound requests go through a single
``httpx.AsyncClient``; the queue is in-memory with tail-drop hysteresis.

Batching targets
----------------
- ``max_batch_events`` = 100 envelopes
- ``max_batch_bytes`` = 512 KiB (uncompressed JSON)
- ``max_flush_interval_ms`` = 5_000 ms
- ``min_flush_interval_ms`` = 250 ms

Retry
-----
- Retry on HTTP 429, 500, 502, 503, 504, and network errors.
- Exponential full-jitter backoff: ``wait = random uniform in [0, min(baseMs * 2**n, 30_000)]``
  with ``baseMs = 1000``. Up to 5 attempts total.
- Honour ``Retry-After`` when present (clamped to 60 s).

Queue
-----
- 5 000 events / 20 MiB ceiling (server-side SDK defaults). Tail-drop when
  either cap is hit; resume accepting when both fall to <= 90% of the caps.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypedDict

import httpx

from .errors import SessionUnknownError, TransportError

log = logging.getLogger("resolvetrace.transport")


# ---------------------------------------------------------------------------
# Envelope defaults (ADR-0001)
# ---------------------------------------------------------------------------


MAX_BATCH_EVENTS = 100
MAX_BATCH_BYTES = 512 * 1024
MAX_FLUSH_INTERVAL_MS = 5_000
MIN_FLUSH_INTERVAL_MS = 250

MAX_RETRIES = 5
RETRY_BASE_MS = 1_000
RETRY_MAX_WAIT_MS = 30_000
RETRY_AFTER_MAX_SECONDS = 60

RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

MAX_QUEUE_EVENTS = 5_000
MAX_QUEUE_BYTES = 20 * 1024 * 1024

#: Hysteresis band — resume accepting when both caps fall to this fraction.
RESUME_FRACTION = 0.9


class _QueuedEnvelope(TypedDict):
    payload: dict[str, Any]
    bytes: int


@dataclass
class TransportMetrics:
    queue_depth: int = 0
    queue_bytes: int = 0
    events_accepted: int = 0
    events_dropped_backpressure: int = 0
    events_dropped_payload_too_large: int = 0
    max_429_retries_exhausted: int = 0
    last_error_code: str | None = None
    last_error_at: str | None = None


@dataclass
class HttpTransport:
    """Batching HTTP transport.

    The ``transport`` parameter in :class:`ClientOptions` may supply a
    pre-built instance (useful for tests). In normal use the client builds
    this transport itself.
    """

    endpoint: str
    api_key: str
    sdk_name: str
    sdk_version: str
    http_client: httpx.AsyncClient | None = None
    metrics: TransportMetrics = field(default_factory=TransportMetrics)

    _queue: list[_QueuedEnvelope] = field(default_factory=list)
    _paused: bool = False
    _flush_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _closed: bool = False

    #: Injectable for tests. Returns seconds to wait. Default uses
    #: ``random.uniform`` per ADR-0001's full-jitter recipe.
    sleep: Callable[[float], Awaitable[None]] = field(default=asyncio.sleep, repr=False)
    random_uniform: Callable[[float, float], float] = field(
        default=random.uniform, repr=False
    )

    def __post_init__(self) -> None:
        if self.http_client is None:
            self.http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=10.0),
                headers={"User-Agent": f"{self.sdk_name}/{self.sdk_version}"},
            )

    # ---- enqueue / flush ---------------------------------------------------

    def enqueue(self, envelope_payload: dict[str, Any]) -> bool:
        """Append an envelope to the queue. Returns ``True`` when accepted."""
        if self._closed:
            return False

        encoded = json.dumps(envelope_payload, separators=(",", ":")).encode("utf-8")
        byte_size = len(encoded)

        if byte_size > MAX_BATCH_BYTES:
            self.metrics.events_dropped_payload_too_large += 1
            return False

        if self._paused or self._over_caps():
            self._paused = True
            if self._paused and self._under_resume_band():
                self._paused = False
            else:
                self.metrics.events_dropped_backpressure += 1
                return False

        self._queue.append({"payload": envelope_payload, "bytes": byte_size})
        self.metrics.queue_depth = len(self._queue)
        self.metrics.queue_bytes += byte_size
        self.metrics.events_accepted += 1
        return True

    async def flush(self) -> None:
        """Drain the queue to the server in one or more HTTP batches.

        If a batch is rejected with HTTP 409 ``session_unknown``, the batch
        is re-queued at the head and :class:`SessionUnknownError` is
        re-raised so the caller (the client's recovery path) can re-issue
        ``/v1/session/start`` and call ``flush()`` again to retry.
        """
        if self._closed:
            return
        async with self._flush_lock:
            while self._queue:
                batch, batch_bytes = self._take_batch()
                if not batch:
                    break
                try:
                    await self._send_batch(batch, batch_bytes)
                except SessionUnknownError:
                    # Push the batch back so the recovery path can retry it.
                    rehydrated: list[_QueuedEnvelope] = [
                        {
                            "payload": p,
                            "bytes": len(
                                json.dumps(p, separators=(",", ":")).encode("utf-8")
                            ),
                        }
                        for p in batch
                    ]
                    self._queue = rehydrated + self._queue
                    self.metrics.queue_depth = len(self._queue)
                    self.metrics.queue_bytes = sum(
                        item["bytes"] for item in self._queue
                    )
                    raise
                self.metrics.queue_depth = len(self._queue)
                self.metrics.queue_bytes = sum(item["bytes"] for item in self._queue)
                if self._paused and self._under_resume_band():
                    self._paused = False

    def _drop_head_batch(self) -> None:
        """Drop one batch worth of envelopes from the head of the queue.

        Used by the client's session-unknown recovery path when both the
        original send and the recovery retry hit 409 — the batch is not
        retriable any further, so we remove it and let subsequent flushes
        proceed with the rest of the queue.
        """
        # Remove up to MAX_BATCH_EVENTS / MAX_BATCH_BYTES worth of items.
        dropped = 0
        dropped_bytes = 0
        while (
            self._queue
            and dropped < MAX_BATCH_EVENTS
            and dropped_bytes + self._queue[0]["bytes"] <= MAX_BATCH_BYTES
        ):
            head = self._queue.pop(0)
            dropped += 1
            dropped_bytes += head["bytes"]
        self.metrics.queue_depth = len(self._queue)
        self.metrics.queue_bytes = sum(item["bytes"] for item in self._queue)

    async def shutdown(self) -> None:
        """Flush and release the HTTP client."""
        if self._closed:
            return
        try:
            await self.flush()
        finally:
            self._closed = True
            if self.http_client is not None:
                await self.http_client.aclose()

    # ---- internal ----------------------------------------------------------

    def _over_caps(self) -> bool:
        return (
            len(self._queue) >= MAX_QUEUE_EVENTS
            or sum(item["bytes"] for item in self._queue) >= MAX_QUEUE_BYTES
        )

    def _under_resume_band(self) -> bool:
        depth = len(self._queue)
        byte_count = sum(item["bytes"] for item in self._queue)
        return (
            depth <= MAX_QUEUE_EVENTS * RESUME_FRACTION
            and byte_count <= MAX_QUEUE_BYTES * RESUME_FRACTION
        )

    def _take_batch(self) -> tuple[list[dict[str, Any]], int]:
        batch: list[dict[str, Any]] = []
        batch_bytes = 0
        while (
            self._queue
            and len(batch) < MAX_BATCH_EVENTS
            and batch_bytes + self._queue[0]["bytes"] <= MAX_BATCH_BYTES
        ):
            item = self._queue.pop(0)
            batch.append(item["payload"])
            batch_bytes += item["bytes"]
        return batch, batch_bytes

    async def _send_batch(self, batch: list[dict[str, Any]], batch_bytes: int) -> None:
        assert self.http_client is not None  # for mypy
        url = f"{self.endpoint}/v1/events"
        body = {"events": batch}
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        }

        attempt = 0
        while True:
            try:
                response = await self.http_client.post(url, json=body, headers=headers)
            except (httpx.NetworkError, httpx.TimeoutException) as exc:
                if attempt >= MAX_RETRIES:
                    self._record_error("network_error")
                    raise TransportError(
                        f"network error after {MAX_RETRIES} retries: {exc!s}"
                    ) from exc
                await self._backoff(attempt, retry_after=None)
                attempt += 1
                continue

            if response.status_code < 300:
                return

            if response.status_code == 409:
                # Server rejected the batch because (tenant_id, session_id)
                # could not be resolved. Surface a typed error so the
                # caller can re-issue session/start and retry exactly once.
                self._record_error("http_409")
                error_body: dict[str, Any] = {}
                try:
                    parsed = response.json()
                    if isinstance(parsed, dict):
                        error_body = parsed
                except Exception:  # pragma: no cover - defensive
                    error_body = {}
                if error_body.get("error") == "session_unknown":
                    raw_unresolved = error_body.get("unresolved_session_ids")
                    unresolved_ids: list[str] | None = None
                    if isinstance(raw_unresolved, list):
                        unresolved_ids = [
                            s for s in raw_unresolved if isinstance(s, str)
                        ]
                    raw_session_id = error_body.get("session_id")
                    raw_message = error_body.get("message")
                    raise SessionUnknownError(
                        raw_message
                        if isinstance(raw_message, str)
                        else "ingest rejected batch with session_unknown",
                        session_id=raw_session_id
                        if isinstance(raw_session_id, str)
                        else None,
                        unresolved_session_ids=unresolved_ids,
                    )
                # Other 409 — treat as non-retryable.
                raise TransportError(
                    f"ingest returned non-retryable status {response.status_code}",
                    status_code=response.status_code,
                )

            if response.status_code in RETRYABLE_STATUS:
                if attempt >= MAX_RETRIES:
                    if response.status_code == 429:
                        self.metrics.max_429_retries_exhausted += 1
                    self._record_error(f"http_{response.status_code}")
                    raise TransportError(
                        f"ingest returned {response.status_code} after {MAX_RETRIES} retries",
                        status_code=response.status_code,
                    )
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                await self._backoff(attempt, retry_after=retry_after)
                attempt += 1
                continue

            # Non-retryable response (4xx other than 429). Drop the batch and
            # surface the error so the caller can observe it.
            self._record_error(f"http_{response.status_code}")
            raise TransportError(
                f"ingest returned non-retryable status {response.status_code}",
                status_code=response.status_code,
            )

    async def _backoff(self, attempt: int, *, retry_after: float | None) -> None:
        if retry_after is not None:
            wait_s = min(max(retry_after, 0.0), float(RETRY_AFTER_MAX_SECONDS))
        else:
            cap_ms = min(RETRY_BASE_MS * (2 ** attempt), RETRY_MAX_WAIT_MS)
            # Full-jitter per ADR-0001: uniform in [0, cap_ms].
            wait_s = self.random_uniform(0.0, cap_ms) / 1000.0
        await self.sleep(wait_s)

    # ---- session lifecycle endpoints --------------------------------------

    async def post_session_start(self, payload: dict[str, Any]) -> None:
        """POST a session-start request.

        Idempotent on the server (upsert keyed by ``(tenant_id, session_id)``).
        Retries on 5xx/network errors; 4xx other than 429 surfaces as
        :class:`TransportError`.
        """
        await self._post_session("/v1/session/start", payload)

    async def post_session_end(self, payload: dict[str, Any]) -> None:
        """POST a session-end request. Same retry policy as ``post_session_start``."""
        await self._post_session("/v1/session/end", payload)

    def submit_session_start(self, payload: dict[str, Any]) -> None:
        """Schedule ``post_session_start`` on the running event loop without awaiting.

        Used by :class:`SessionManager` from sync code paths. If no loop is
        running (e.g. before the first ``flush()``), we record the payload
        for the next event-loop tick via a thread-bridged fallback.
        """
        self._fire_and_forget(self.post_session_start(payload))

    def submit_session_end(
        self, payload: dict[str, Any], *, timeout_ms: float | None = None
    ) -> None:
        """Schedule ``post_session_end`` on the running event loop.

        ``timeout_ms`` is recorded but not enforced here; callers that want
        a hard deadline ``await`` ``post_session_end`` directly.
        """
        del timeout_ms  # advisory only — full implementation pending
        self._fire_and_forget(self.post_session_end(payload))

    def _fire_and_forget(self, coro: Awaitable[None]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            task: asyncio.Task[None] = loop.create_task(coro)  # type: ignore[arg-type]
            task.add_done_callback(self._swallow_task_exceptions)
            return
        # No running loop — drive the coroutine in a fresh loop on a thread.
        # Best-effort; the SDK is async-first and the caller is expected to
        # be inside an event loop in production.
        import threading as _threading

        def _run() -> None:
            asyncio.run(coro)  # type: ignore[arg-type]

        _threading.Thread(target=_run, daemon=True).start()

    def _swallow_task_exceptions(self, task: asyncio.Task[Any]) -> None:
        try:
            exc = task.exception()
        except (asyncio.CancelledError, asyncio.InvalidStateError):
            return
        if exc is not None:
            log.debug("background session task raised: %s", exc)

    async def _post_session(self, path: str, payload: dict[str, Any]) -> None:
        assert self.http_client is not None
        url = f"{self.endpoint}{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        }
        attempt = 0
        while True:
            try:
                response = await self.http_client.post(
                    url, json=payload, headers=headers
                )
            except (httpx.NetworkError, httpx.TimeoutException) as exc:
                if attempt >= MAX_RETRIES:
                    self._record_error("network_error")
                    raise TransportError(
                        f"network error after {MAX_RETRIES} retries: {exc!s}"
                    ) from exc
                await self._backoff(attempt, retry_after=None)
                attempt += 1
                continue

            if response.status_code < 300:
                return

            if response.status_code in RETRYABLE_STATUS:
                if attempt >= MAX_RETRIES:
                    self._record_error(f"http_{response.status_code}")
                    raise TransportError(
                        f"ingest returned {response.status_code} after {MAX_RETRIES} retries",
                        status_code=response.status_code,
                    )
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                await self._backoff(attempt, retry_after=retry_after)
                attempt += 1
                continue

            self._record_error(f"http_{response.status_code}")
            raise TransportError(
                f"ingest returned non-retryable status {response.status_code}",
                status_code=response.status_code,
            )

    def _record_error(self, code: str) -> None:
        self.metrics.last_error_code = code
        # ISO-8601 UTC timestamp matching the TS SDK's formatting.
        from datetime import datetime, timezone

        self.metrics.last_error_at = (
            datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.")
            + f"{datetime.now(tz=timezone.utc).microsecond // 1000:03d}Z"
        )


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


__all__ = [
    "HttpTransport",
    "MAX_BATCH_BYTES",
    "MAX_BATCH_EVENTS",
    "MAX_FLUSH_INTERVAL_MS",
    "MAX_QUEUE_BYTES",
    "MAX_QUEUE_EVENTS",
    "MAX_RETRIES",
    "MIN_FLUSH_INTERVAL_MS",
    "RETRY_AFTER_MAX_SECONDS",
    "RETRY_BASE_MS",
    "RETRY_MAX_WAIT_MS",
    "RETRYABLE_STATUS",
    "TransportMetrics",
]
