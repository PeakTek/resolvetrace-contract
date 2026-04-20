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

from .errors import TransportError

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
        """Drain the queue to the server in one or more HTTP batches."""
        if self._closed:
            return
        async with self._flush_lock:
            while self._queue:
                batch, batch_bytes = self._take_batch()
                if not batch:
                    break
                await self._send_batch(batch, batch_bytes)
                self.metrics.queue_depth = len(self._queue)
                self.metrics.queue_bytes = sum(item["bytes"] for item in self._queue)
                if self._paused and self._under_resume_band():
                    self._paused = False

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
