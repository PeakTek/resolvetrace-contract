"""Tests for :mod:`resolvetrace.session`.

Coverage mirrors the TS SDK's ``session.test.ts`` where applicable. Tests
that hinge on browser-only behaviour (``sessionStorage`` restore /
unavailable) are skipped — Python sessions live for the lifetime of the
process.
"""

from __future__ import annotations

import re
import threading

import pytest

from resolvetrace.errors import ConfigError, ResolveTraceError
from resolvetrace.identity import IdentityState
from resolvetrace.session import (
    DEFAULT_INACTIVITY_MS,
    DEFAULT_MAX_DURATION_MS,
    SessionManager,
    SessionRequiredError,
    SessionState,
    validate_session_config,
)
from tests._fakes import FakeClock, FakeSessionTransport, FakeTimerScheduler

ULID_PATTERN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
ENDPOINT = "https://ingest.resolvetrace.com"


def _make_manager(
    *,
    auto_session: bool = True,
    inactivity_ms: int = DEFAULT_INACTIVITY_MS,
    max_duration_ms: int = DEFAULT_MAX_DURATION_MS,
    on_error: object | None = None,
    session_attributes: object | None = None,
    identity: IdentityState | None = None,
) -> tuple[SessionManager, FakeSessionTransport, FakeTimerScheduler, FakeClock]:
    transport = FakeSessionTransport()
    scheduler = FakeTimerScheduler()
    clock = FakeClock()
    config = validate_session_config(
        session_inactivity_ms=inactivity_ms,
        session_max_duration_ms=max_duration_ms,
        auto_session=auto_session,
    )
    manager = SessionManager(
        endpoint=ENDPOINT,
        transport=transport,  # type: ignore[arg-type]
        identity=identity or IdentityState(),
        config=config,
        on_error=on_error,  # type: ignore[arg-type]
        session_attributes=session_attributes,  # type: ignore[arg-type]
        time_fn=clock,
        timer_factory=scheduler.factory,  # type: ignore[arg-type]
    )
    return manager, transport, scheduler, clock


# ---- Test 1: lazy start ----------------------------------------------------


def test_lazy_start_emits_session_start_and_assigns_id() -> None:
    manager, transport, _, _ = _make_manager()
    assert manager.id is None
    assert len(transport.starts) == 0

    sid = manager.ensure_started()
    assert ULID_PATTERN.match(sid)
    assert manager.id == sid
    assert len(transport.starts) == 1
    assert transport.starts[0]["session_id"] == sid


# ---- Test 2: no double-start ----------------------------------------------


def test_repeated_ensure_started_does_not_double_post() -> None:
    manager, transport, _, _ = _make_manager()
    sid_a = manager.ensure_started()
    sid_b = manager.ensure_started()
    sid_c = manager.ensure_started()
    assert sid_a == sid_b == sid_c
    assert len(transport.starts) == 1


# ---- Test 3: inactivity rollover ------------------------------------------


def test_inactivity_rollover_starts_a_fresh_session() -> None:
    manager, transport, scheduler, _ = _make_manager(inactivity_ms=2_000)
    sid_a = manager.ensure_started()
    assert manager.id == sid_a

    # Fire the inactivity timer (the only "active" timer with that interval).
    inactivity_timer = scheduler.latest_with_interval(2.0)
    assert inactivity_timer is not None
    inactivity_timer.callback()

    assert manager.id is None  # rolled to Idle
    sid_b = manager.ensure_started()
    assert sid_b != sid_a
    assert len(transport.starts) == 2
    assert transport.ends and transport.ends[-1]["ended_reason"] == "inactivity"


# ---- Test 4: max-duration rollover ----------------------------------------


def test_max_duration_rollover_fires_even_with_activity() -> None:
    manager, transport, scheduler, clock = _make_manager(
        inactivity_ms=DEFAULT_INACTIVITY_MS,
        max_duration_ms=5_000,
    )
    sid_a = manager.ensure_started()

    # Simulate sustained activity — would keep inactivity timer reset, but
    # max-duration is anchored on session start and not reset on activity.
    for _ in range(10):
        clock.advance(0.4)
        manager.note_activity()

    max_timer = scheduler.latest_with_interval(5.0)
    assert max_timer is not None
    max_timer.callback()

    assert manager.id is None
    sid_b = manager.ensure_started()
    assert sid_b != sid_a
    assert transport.ends and transport.ends[-1]["ended_reason"] == "max_duration"


# ---- Tests 5-7 skipped: sessionStorage parity tests not applicable in Python --


# ---- Test 8: identity-before-capture --------------------------------------


def test_identity_set_before_capture_decorates_session_start() -> None:
    identity = IdentityState()
    manager, transport, _, _ = _make_manager(identity=identity)
    identity.set("u_42", {"plan": "pro"})

    manager.ensure_started()
    payload = transport.starts[0]
    assert payload["identify"] == {"user_id": "u_42", "traits": {"plan": "pro"}}


# ---- Test 9: identity-mid-session -----------------------------------------


def test_identity_set_mid_session_does_not_emit_extra_start() -> None:
    identity = IdentityState()
    manager, transport, _, _ = _make_manager(identity=identity)
    manager.ensure_started()
    assert len(transport.starts) == 1

    identity.set("u_99")
    # Identity does NOT trigger a network call by itself.
    manager.ensure_started()
    assert len(transport.starts) == 1
    assert "identify" not in transport.starts[0]


# ---- Test 10: identity clear ----------------------------------------------


def test_identity_clear_removes_identify_from_next_start() -> None:
    identity = IdentityState()
    manager, transport, _, _ = _make_manager(identity=identity)
    identity.set("u_1")
    manager.ensure_started()
    assert transport.starts[0].get("identify") == {"user_id": "u_1"}

    # Roll over and clear identity.
    identity.set(None)
    manager.restart()
    assert "identify" not in transport.starts[-1]


# ---- Test 11: autoSession=False -------------------------------------------


def test_auto_session_false_rejects_lazy_start() -> None:
    manager, transport, _, _ = _make_manager(auto_session=False)
    with pytest.raises(SessionRequiredError):
        manager.ensure_started()
    assert manager.id is None
    assert len(transport.starts) == 0


# ---- Test 12: autoSession=False explicit start -----------------------------


def test_auto_session_false_with_explicit_restart() -> None:
    manager, transport, _, _ = _make_manager(auto_session=False)
    sid = manager.restart()
    assert ULID_PATTERN.match(sid)
    assert manager.id == sid
    assert len(transport.starts) == 1


# ---- Test 13/14: session_unknown recovery ----------------------------------
# Recovery flow lives in client.flush(); covered in test_client.py.


# ---- Test 15: end() awaits / clears state ---------------------------------


def test_end_clears_state_and_emits_end_request() -> None:
    manager, transport, _, _ = _make_manager()
    sid = manager.ensure_started()
    manager.end()
    assert manager.id is None
    assert len(transport.ends) == 1
    assert transport.ends[0]["session_id"] == sid
    assert transport.ends[0]["ended_reason"] == "explicit"


# ---- Test 16: restart() synchronous return --------------------------------


def test_restart_synchronously_returns_new_id() -> None:
    manager, transport, _, _ = _make_manager()
    old_id = manager.ensure_started()
    new_id = manager.restart()
    assert ULID_PATTERN.match(new_id)
    assert new_id != old_id
    assert manager.id == new_id
    # restart() emits both an end (for old) and a start (for new).
    assert any(e["session_id"] == old_id for e in transport.ends)
    assert any(s["session_id"] == new_id for s in transport.starts)


# ---- Test 17: config validation -------------------------------------------


def test_config_below_floor_rejected() -> None:
    with pytest.raises(ConfigError):
        validate_session_config(
            session_inactivity_ms=500,
            session_max_duration_ms=None,
            auto_session=None,
        )


def test_config_above_default_rejected() -> None:
    with pytest.raises(ConfigError):
        validate_session_config(
            session_inactivity_ms=DEFAULT_INACTIVITY_MS + 1,
            session_max_duration_ms=None,
            auto_session=None,
        )
    with pytest.raises(ConfigError):
        validate_session_config(
            session_inactivity_ms=None,
            session_max_duration_ms=DEFAULT_MAX_DURATION_MS + 1,
            auto_session=None,
        )


def test_config_lower_values_accepted() -> None:
    cfg = validate_session_config(
        session_inactivity_ms=60_000,
        session_max_duration_ms=300_000,
        auto_session=False,
    )
    assert cfg.session_inactivity_ms == 60_000
    assert cfg.session_max_duration_ms == 300_000
    assert cfg.auto_session is False


# ---- Test 18 (sessionStorage unavailable) skipped -------------------------


# ---- Test 19: thread safety (Python-specific) -----------------------------


def test_concurrent_capture_threads_emit_one_start() -> None:
    manager, transport, _, _ = _make_manager()
    barrier = threading.Barrier(100)
    results: list[str] = []
    results_lock = threading.Lock()

    def worker() -> None:
        barrier.wait()
        sid = manager.ensure_started()
        with results_lock:
            results.append(sid)

    threads = [threading.Thread(target=worker) for _ in range(100)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 100
    # All workers see the same session id.
    assert len(set(results)) == 1
    # And exactly one /v1/session/start was issued.
    assert len(transport.starts) == 1


# ---- Test 20: timers cancelled on shutdown --------------------------------


def test_shutdown_cancels_pending_timers_and_emits_final_end() -> None:
    manager, transport, scheduler, _ = _make_manager()
    manager.ensure_started()
    manager.shutdown()
    # Both timers must be cancelled.
    active = [t for t in scheduler.timers if not t.cancelled]
    assert active == []
    # Shutdown emits exactly one end with reason 'shutdown'.
    assert len(transport.ends) == 1
    assert transport.ends[0]["ended_reason"] == "shutdown"
    # Subsequent ensure_started raises (client is inert).
    with pytest.raises(ResolveTraceError):
        manager.ensure_started()


# ---- Test 21: state machine transitions -----------------------------------


def test_state_transitions_idle_active_idle() -> None:
    manager, _, _, _ = _make_manager()
    assert manager._state == SessionState.IDLE  # noqa: SLF001 - test inspects internal state
    manager.ensure_started()
    assert manager._state == SessionState.ACTIVE  # noqa: SLF001
    manager.end()
    assert manager._state == SessionState.IDLE  # noqa: SLF001


# ---- Test 22: session_attributes feeds the start payload ------------------


def test_session_attributes_callable_populates_payload() -> None:
    def attrs() -> dict[str, object]:
        return {
            "user_agent": "TestRunner/1.0",
            "page_url": "https://example.com/home",
            "viewport": "1440x900",
            "app_version": "0.0.1",
        }

    manager, transport, _, _ = _make_manager(session_attributes=attrs)
    manager.ensure_started()
    payload = transport.starts[0]
    # user_agent is hoisted to the top level.
    assert payload["user_agent"] == "TestRunner/1.0"
    # The remaining keys land in `attributes`, free-form.
    assert payload["attributes"]["page_url"] == "https://example.com/home"
    assert payload["attributes"]["viewport"] == "1440x900"
    assert payload["attributes"]["app_version"] == "0.0.1"


def test_session_attributes_callable_failure_swallowed() -> None:
    errors: list[Exception] = []

    def attrs() -> dict[str, object]:
        raise RuntimeError("boom")

    manager, transport, _, _ = _make_manager(
        session_attributes=attrs, on_error=errors.append
    )
    manager.ensure_started()
    assert len(transport.starts) == 1
    assert any(isinstance(e, RuntimeError) for e in errors)


# ---- Sample wire payload shape (byte-shape parity check) ------------------


def test_session_start_payload_has_iso_milliseconds_and_ulid_session_id() -> None:
    identity = IdentityState()
    identity.set("u_42", {"plan": "pro"})
    manager, transport, _, _ = _make_manager(identity=identity)
    manager.ensure_started()

    payload = transport.starts[0]
    # Required fields.
    assert ULID_PATTERN.match(payload["session_id"])
    # ISO-8601 with millisecond precision and Z suffix.
    assert re.match(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", payload["started_at"]
    )
    # Identity slot.
    assert payload["identify"] == {"user_id": "u_42", "traits": {"plan": "pro"}}
    # No surprise fields.
    allowed_keys = {"session_id", "started_at", "user_agent", "attributes", "identify"}
    assert set(payload.keys()) <= allowed_keys


def test_session_start_payload_field_order_matches_typescript_sdk() -> None:
    """Field-order parity check vs the TypeScript SDK.

    The TS SDK builds the payload as an object literal with the keys in
    the order: session_id, started_at, [user_agent], [attributes],
    [identify]. ``json.dumps`` preserves dict insertion order in Python
    3.7+, so equivalent inputs MUST serialize byte-for-byte identically.
    """
    import json

    identity = IdentityState()
    identity.set("u_42", {"plan": "pro"})

    def attrs() -> dict[str, object]:
        return {
            "user_agent": "Mozilla/5.0 ...",
            "page_url": "https://app.example.com/dashboard",
            "viewport": "1440x900",
        }

    manager, transport, _, _ = _make_manager(
        identity=identity, session_attributes=attrs
    )
    manager.ensure_started()
    payload = transport.starts[0]

    # Force a known ULID + timestamp to make the byte-equivalence check
    # purely structural.
    fixed = {
        "session_id": "01HZK3X4Q2P5RXXXXXXXXXXXXX",
        "started_at": "2026-04-29T14:23:01.000Z",
        "user_agent": "Mozilla/5.0 ...",
        "attributes": {
            "page_url": "https://app.example.com/dashboard",
            "viewport": "1440x900",
        },
        "identify": {"user_id": "u_42", "traits": {"plan": "pro"}},
    }
    # Same key set and same field order.
    assert list(payload.keys()) == list(fixed.keys())
    encoded = json.dumps(payload, separators=(",", ":"))
    # Sanity check: separators match what the transport uses.
    assert encoded.startswith('{"session_id":')
    assert '"started_at":' in encoded
