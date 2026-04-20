"""Tests for ``resolvetrace.transport``.

Uses ``pytest-httpx`` to mock all outbound HTTP so the suite runs with no
network access. Asserts batching, retries on 429/5xx, and ``Retry-After``
honouring.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from resolvetrace.errors import TransportError
from resolvetrace.transport import (
    MAX_BATCH_BYTES,
    MAX_BATCH_EVENTS,
    MAX_RETRIES,
    RETRY_AFTER_MAX_SECONDS,
    HttpTransport,
)


def _dummy_payload(n: int = 1) -> dict[str, Any]:
    return {
        "eventId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "type": f"test.event.{n}",
        "capturedAt": "2026-04-20T12:00:00.000Z",
        "scrubber": {
            "version": "sdk@0.1.0",
            "rulesDigest": "sha256:" + "a" * 64,
            "applied": [],
            "budgetExceeded": False,
        },
        "sdk": {"name": "resolvetrace-py", "version": "0.1.0"},
    }


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def transport_factory(sleeps: list[float]):
    """Build a transport whose sleep + RNG are captured for assertions."""

    async def _sleep(seconds: float) -> None:
        sleeps.append(seconds)

    def _uniform(_a: float, b: float) -> float:
        return b  # deterministic: always pick the ceiling

    def _factory(
        *,
        api_key: str = "rt_live_abc",
        endpoint: str = "https://ingest.resolvetrace.com",
        client: httpx.AsyncClient | None = None,
    ) -> HttpTransport:
        return HttpTransport(
            endpoint=endpoint,
            api_key=api_key,
            sdk_name="resolvetrace-py",
            sdk_version="0.1.0",
            http_client=client,
            sleep=_sleep,
            random_uniform=_uniform,
        )

    return _factory


async def test_enqueue_respects_bytes_cap(transport_factory) -> None:
    t = transport_factory()
    huge_payload = _dummy_payload()
    huge_payload["attributes"] = {"x": "y" * (MAX_BATCH_BYTES + 1)}
    accepted = t.enqueue(huge_payload)
    assert accepted is False
    assert t.metrics.events_dropped_payload_too_large == 1


async def test_flush_posts_to_events_endpoint(transport_factory, httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=202,
        json={"accepted": 1, "duplicates": 0, "receivedAt": "2026-04-20T12:00:00.000Z"},
    )
    async with httpx.AsyncClient() as client:
        t = transport_factory(client=client)
        assert t.enqueue(_dummy_payload())
        await t.flush()
    request = httpx_mock.get_request()
    assert request is not None
    assert request.headers["authorization"] == "Bearer rt_live_abc"
    assert request.headers["cache-control"] == "no-store"


async def test_flush_retries_on_429_and_honours_retry_after(
    transport_factory, httpx_mock, sleeps: list[float]
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=429,
        headers={"Retry-After": "3"},
        json={"error": "rate_limit_exceeded", "retryAfterSeconds": 3, "class": "events", "scope": "tenant"},
    )
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=202,
        json={"accepted": 1, "duplicates": 0, "receivedAt": "2026-04-20T12:00:00.000Z"},
    )
    async with httpx.AsyncClient() as client:
        t = transport_factory(client=client)
        t.enqueue(_dummy_payload())
        await t.flush()

    assert sleeps == [3.0]  # Retry-After honoured exactly.


async def test_retry_after_clamped_to_60_seconds(
    transport_factory, httpx_mock, sleeps: list[float]
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=503,
        headers={"Retry-After": "99999"},
        json={},
    )
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=202,
        json={"accepted": 1, "duplicates": 0, "receivedAt": "2026-04-20T12:00:00.000Z"},
    )
    async with httpx.AsyncClient() as client:
        t = transport_factory(client=client)
        t.enqueue(_dummy_payload())
        await t.flush()
    assert sleeps == [float(RETRY_AFTER_MAX_SECONDS)]


async def test_retry_exhaustion_raises_transport_error(
    transport_factory, httpx_mock
) -> None:
    for _ in range(MAX_RETRIES + 1):
        httpx_mock.add_response(
            method="POST",
            url="https://ingest.resolvetrace.com/v1/events",
            status_code=500,
            json={},
        )
    async with httpx.AsyncClient() as client:
        t = transport_factory(client=client)
        t.enqueue(_dummy_payload())
        with pytest.raises(TransportError):
            await t.flush()


async def test_non_retryable_status_surfaces_error(
    transport_factory, httpx_mock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=400,
        json={"error": "bad_request"},
    )
    async with httpx.AsyncClient() as client:
        t = transport_factory(client=client)
        t.enqueue(_dummy_payload())
        with pytest.raises(TransportError) as info:
            await t.flush()
        assert info.value.status_code == 400


async def test_batch_size_limits_honoured(
    transport_factory, httpx_mock
) -> None:
    """Enqueueing >100 events splits into multiple batches."""
    event_count = MAX_BATCH_EVENTS + 25

    for _ in range(2):
        httpx_mock.add_response(
            method="POST",
            url="https://ingest.resolvetrace.com/v1/events",
            status_code=202,
            json={"accepted": 0, "duplicates": 0, "receivedAt": "2026-04-20T12:00:00.000Z"},
        )

    async with httpx.AsyncClient() as client:
        t = transport_factory(client=client)
        for i in range(event_count):
            payload = _dummy_payload(i)
            assert t.enqueue(payload)
        await t.flush()

    requests = httpx_mock.get_requests()
    assert len(requests) == 2
