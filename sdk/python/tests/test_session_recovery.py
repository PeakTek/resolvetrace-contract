"""End-to-end tests for the session-unknown recovery path.

When ``POST /v1/events`` returns HTTP 409 with body
``{"error": "session_unknown"}``, the SDK must:

1. Re-issue ``POST /v1/session/start`` for the active session ID.
2. Retry the events batch exactly once.
3. On a second 409, surface ``session_recovery_failed`` via ``on_error`` and
   drop the batch (do NOT roll over the session).
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from resolvetrace import (
    ResolveTraceClient,
    SessionRecoveryFailedError,
    SessionUnknownError,
)
from resolvetrace.transport import HttpTransport


def _client(transport: HttpTransport) -> ResolveTraceClient:
    return ResolveTraceClient(
        api_key="rt_live_test",
        endpoint="https://ingest.resolvetrace.com",
        transport=transport,
    )


@pytest.fixture
def transport_factory():
    def _factory(
        client: httpx.AsyncClient | None = None,
    ) -> HttpTransport:
        return HttpTransport(
            endpoint="https://ingest.resolvetrace.com",
            api_key="rt_live_test",
            sdk_name="resolvetrace-py",
            sdk_version="0.1.0",
            http_client=client,
        )

    return _factory


async def test_session_unknown_surfaces_typed_error_from_transport(
    transport_factory, httpx_mock
) -> None:
    """Transport must raise SessionUnknownError on 409+session_unknown body."""
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=409,
        json={
            "error": "session_unknown",
            "session_id": "01HZK3X4Q2P5RHARSESNHGMDPV",
            "message": "Unknown session for this tenant.",
        },
    )
    async with httpx.AsyncClient() as client:
        transport = transport_factory(client=client)
        # Manually enqueue an envelope; the session manager isn't involved.
        transport.enqueue(
            {
                "eventId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "sessionId": "01HZK3X4Q2P5RHARSESNHGMDPV",
                "type": "test.evt",
                "capturedAt": "2026-04-29T14:00:00.000Z",
                "scrubber": {
                    "version": "sdk@0.1.0",
                    "rulesDigest": "sha256:" + "a" * 64,
                    "applied": [],
                    "budgetExceeded": False,
                },
                "sdk": {"name": "resolvetrace-py", "version": "0.1.0"},
            }
        )
        with pytest.raises(SessionUnknownError) as info:
            await transport.flush()
        assert info.value.session_id == "01HZK3X4Q2P5RHARSESNHGMDPV"


async def test_409_other_error_raises_transport_error(
    transport_factory, httpx_mock
) -> None:
    from resolvetrace.errors import TransportError

    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=409,
        json={"error": "duplicate_idempotency_key"},
    )
    async with httpx.AsyncClient() as client:
        transport = transport_factory(client=client)
        transport.enqueue(
            {
                "eventId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "sessionId": "01HZK3X4Q2P5RHARSESNHGMDPV",
                "type": "test.evt",
                "capturedAt": "2026-04-29T14:00:00.000Z",
                "scrubber": {
                    "version": "sdk@0.1.0",
                    "rulesDigest": "sha256:" + "a" * 64,
                    "applied": [],
                    "budgetExceeded": False,
                },
                "sdk": {"name": "resolvetrace-py", "version": "0.1.0"},
            }
        )
        with pytest.raises(TransportError):
            await transport.flush()


async def test_client_recovery_happy_path(transport_factory, httpx_mock) -> None:
    """First events POST returns 409; second succeeds after re-start."""
    # Initial events POST -> 409 session_unknown
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=409,
        json={"error": "session_unknown"},
    )
    # Recovery: session/start (idempotent) -> 202
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/session/start",
        status_code=202,
        json={},
    )
    # Retry events POST -> 202
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=202,
        json={"accepted": 1, "duplicates": 0, "receivedAt": "2026-04-29T14:00:00.000Z"},
    )

    async with httpx.AsyncClient() as http_client:
        transport = transport_factory(client=http_client)
        client = _client(transport)
        client.capture({"type": "demo.evt"})
        await client.flush()

        # Three POSTs total: events (409), session/start (recovery), events (202).
        requests = httpx_mock.get_requests()
        urls = [r.url.path for r in requests]
        assert urls.count("/v1/events") == 2
        assert urls.count("/v1/session/start") >= 1


async def test_client_recovery_double_failure_drops_and_callbacks(
    transport_factory, httpx_mock
) -> None:
    errors: list[Exception] = []

    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=409,
        json={"error": "session_unknown"},
    )
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/session/start",
        status_code=202,
        json={},
    )
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=409,
        json={"error": "session_unknown"},
    )

    async with httpx.AsyncClient() as http_client:
        transport = transport_factory(client=http_client)
        client = ResolveTraceClient(
            api_key="rt_live_test",
            endpoint="https://ingest.resolvetrace.com",
            transport=transport,
            on_error=errors.append,
        )
        sid_before = client.session.id  # may be None until capture
        client.capture({"type": "demo.evt"})
        await client.flush()
        sid_after = client.session.id

    # session_recovery_failed must have been emitted.
    assert any(isinstance(e, SessionRecoveryFailedError) for e in errors)
    # And the session must NOT have rolled over.
    assert sid_before is None or sid_before == sid_after
    assert sid_after is not None  # capture lazy-started a session


async def test_client_session_id_propagates_into_event_envelope(
    transport_factory, httpx_mock
) -> None:
    # session/start is submitted fire-and-forget on a background thread; we
    # may or may not see the request land before the test ends. Mark it
    # optional via assert_all_responses_were_requested=False below.
    httpx_mock.add_response(
        method="POST",
        url="https://ingest.resolvetrace.com/v1/events",
        status_code=202,
        json={"accepted": 1, "duplicates": 0, "receivedAt": "2026-04-29T14:00:00.000Z"},
    )

    async with httpx.AsyncClient() as http_client:
        transport = transport_factory(client=http_client)
        client = _client(transport)
        event_id = client.capture({"type": "checkout.completed"})
        sid = client.session.id
        assert event_id
        assert sid is not None

        await client.flush()

        events_request = next(
            r for r in httpx_mock.get_requests() if r.url.path == "/v1/events"
        )
        body: dict[str, Any] = httpx_mock_get_json(events_request)
        envelope = body["events"][0]
        assert envelope["sessionId"] == sid


def httpx_mock_get_json(request: httpx.Request) -> dict[str, Any]:
    import json

    return json.loads(request.content.decode("utf-8"))
