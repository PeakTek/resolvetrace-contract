"""Session lifecycle manager for the Python SDK.

Owns the state machine that produces ``session_id`` for every event:

* ``Idle`` — no active session ID.
* ``Active`` — session ID held; inactivity and max-duration timers running.
* ``Ending`` — session-end in flight; new captures rejected (callers fall
  back to ``ensure_started`` which transitions ``Idle -> Active``).

Triggers
--------

* **Lazy start.** First ``ensure_started()`` call from ``Idle`` generates a
  ULID, transitions to ``Active``, schedules timers, and submits
  ``POST /v1/session/start`` to the transport in the background.
* **Inactivity rollover.** If no ``note_activity()`` call lands within
  ``session_inactivity_ms``, the timer fires, ``Active -> Ending -> Idle``,
  and ``POST /v1/session/end`` is sent with reason ``timeout``.
* **Max-duration rollover.** Same as inactivity but anchored on the
  ``started_at`` clock; reason ``timeout`` (the schema's available
  end-reason vocabulary collapses both timeouts to ``timeout``).
* **Explicit ``end()``.** Awaits the end POST up to ``timeout_ms``.
* **Explicit ``restart()``.** Synchronously rotates to a new ULID; old
  session is ended in the background.

The Python SDK does not persist sessions across processes; a new process
starts a new session, which mirrors how server-side SDKs are normally run.

All public methods are thread-safe — ``capture()`` may be called from any
thread, so the manager guards state with an internal ``threading.Lock``.
"""

from __future__ import annotations

import logging
import threading
import time as _time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable

from .errors import ConfigError, ResolveTraceError
from .identity import IdentityState
from .ulid import generate_ulid

log = logging.getLogger("resolvetrace.session")

#: Default inactivity rollover (30 minutes).
DEFAULT_INACTIVITY_MS = 30 * 60 * 1000

#: Default max-session lifetime (12 hours).
DEFAULT_MAX_DURATION_MS = 12 * 60 * 60 * 1000

#: Floor for any user-provided rollover value.
MIN_TIMEOUT_MS = 1_000


class SessionState(str, Enum):
    """Lifecycle state of a :class:`SessionManager`."""

    IDLE = "idle"
    ACTIVE = "active"
    ENDING = "ending"


# ---------------------------------------------------------------------------
# Transport protocol
# ---------------------------------------------------------------------------


class SessionTransportProtocol:
    """Minimal transport surface the manager depends on.

    Concrete transports may be the real :class:`HttpTransport` or a test
    double. The manager calls ``submit_session_start`` and
    ``submit_session_end`` in a fire-and-forget fashion; the implementation
    decides whether to dispatch on a worker thread or queue inline.
    """

    def submit_session_start(self, payload: dict[str, Any]) -> None:  # pragma: no cover - protocol
        raise NotImplementedError

    def submit_session_end(
        self, payload: dict[str, Any], *, timeout_ms: float | None = None
    ) -> None:  # pragma: no cover - protocol
        raise NotImplementedError


class _Timer:
    """Wrapper around ``threading.Timer`` that exposes a ``cancel()`` only."""

    __slots__ = ("_timer",)

    def __init__(self, interval: float, callback: Callable[[], None]) -> None:
        self._timer = threading.Timer(interval, callback)
        self._timer.daemon = True
        self._timer.start()

    def cancel(self) -> None:
        self._timer.cancel()


TimerFactory = Callable[[float, Callable[[], None]], "_Timer"]


def _default_timer_factory(interval_s: float, callback: Callable[[], None]) -> _Timer:
    return _Timer(interval_s, callback)


# ---------------------------------------------------------------------------
# SessionManager
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionConfig:
    """Validated session-related configuration carried into :class:`SessionManager`."""

    session_inactivity_ms: int = DEFAULT_INACTIVITY_MS
    session_max_duration_ms: int = DEFAULT_MAX_DURATION_MS
    auto_session: bool = True


def validate_session_config(
    *,
    session_inactivity_ms: int | None,
    session_max_duration_ms: int | None,
    auto_session: bool | None,
) -> SessionConfig:
    """Validate and resolve session config kwargs into a :class:`SessionConfig`.

    The user MAY tighten the rollover windows; raising them above the
    defaults is rejected at construction time to keep operational behaviour
    bounded across the fleet.
    """
    inactivity = (
        DEFAULT_INACTIVITY_MS if session_inactivity_ms is None else session_inactivity_ms
    )
    max_dur = (
        DEFAULT_MAX_DURATION_MS
        if session_max_duration_ms is None
        else session_max_duration_ms
    )
    auto = True if auto_session is None else auto_session

    if not isinstance(inactivity, int) or isinstance(inactivity, bool):
        raise ConfigError("session_inactivity_ms must be an integer number of milliseconds")
    if not isinstance(max_dur, int) or isinstance(max_dur, bool):
        raise ConfigError("session_max_duration_ms must be an integer number of milliseconds")
    if not isinstance(auto, bool):
        raise ConfigError("auto_session must be a boolean")

    if inactivity < MIN_TIMEOUT_MS:
        raise ConfigError(
            f"session_inactivity_ms must be >= {MIN_TIMEOUT_MS} ms"
        )
    if inactivity > DEFAULT_INACTIVITY_MS:
        raise ConfigError(
            f"session_inactivity_ms may only be reduced below the default "
            f"{DEFAULT_INACTIVITY_MS} ms; raising is not permitted"
        )
    if max_dur < MIN_TIMEOUT_MS:
        raise ConfigError(
            f"session_max_duration_ms must be >= {MIN_TIMEOUT_MS} ms"
        )
    if max_dur > DEFAULT_MAX_DURATION_MS:
        raise ConfigError(
            f"session_max_duration_ms may only be reduced below the default "
            f"{DEFAULT_MAX_DURATION_MS} ms; raising is not permitted"
        )

    return SessionConfig(
        session_inactivity_ms=inactivity,
        session_max_duration_ms=max_dur,
        auto_session=auto,
    )


class SessionRequiredError(ResolveTraceError):
    """Raised when a capture occurs in ``auto_session=False`` mode without an active session."""

    code = "session_required"


class SessionManager:
    """Owns session ID + timers + identity coordination.

    The transport hook is intentionally a thin protocol so tests can pass a
    fake without dragging the HTTP stack in. ``time_fn`` is the monotonic
    clock used for max-duration accounting; tests inject a deterministic
    ticker. ``timer_factory`` exists so tests can replace the threading
    timer with an inline scheduler.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        transport: SessionTransportProtocol,
        identity: IdentityState,
        config: SessionConfig,
        on_error: Callable[[Exception], None] | None = None,
        session_attributes: Callable[[], dict[str, Any]] | None = None,
        time_fn: Callable[[], float] = _time.monotonic,
        timer_factory: TimerFactory = _default_timer_factory,
    ) -> None:
        self._endpoint = endpoint
        self._transport = transport
        self._identity = identity
        self._config = config
        self._on_error = on_error
        self._session_attributes = session_attributes
        self._time_fn = time_fn
        self._timer_factory = timer_factory

        self._lock = threading.RLock()
        self._state: SessionState = SessionState.IDLE
        self._session_id: str | None = None
        self._started_at_iso: str | None = None
        self._started_monotonic: float | None = None
        self._last_activity_monotonic: float | None = None

        self._inactivity_timer: _Timer | None = None
        self._max_duration_timer: _Timer | None = None

        self._closed = False

    # ---- public surface ---------------------------------------------------

    def get_id(self) -> str | None:
        """Return the active session ID, or ``None`` when idle."""
        with self._lock:
            return self._session_id

    @property
    def id(self) -> str | None:
        """Read-only accessor mirroring ``client.session.id``."""
        return self.get_id()

    def ensure_started(self) -> str:
        """Return the active session ID, lazy-starting one if needed.

        In ``auto_session=False`` mode this never auto-starts: the caller
        must invoke :meth:`restart` first. Calling ``ensure_started`` while
        idle in that mode raises :class:`SessionRequiredError`.
        """
        with self._lock:
            if self._closed:
                raise ResolveTraceError("client has been shut down")
            if self._state == SessionState.ACTIVE and self._session_id is not None:
                return self._session_id
            if not self._config.auto_session:
                raise SessionRequiredError(
                    "no active session — call client.session.restart() first "
                    "(auto_session=False)"
                )
            return self._start_locked(send_start=True)

    def issue_start(self) -> str:
        """Re-issue ``POST /v1/session/start`` for the current session ID.

        Used by the client's 409 ``session_unknown`` recovery path. Returns
        the existing session ID (or starts one when idle).
        """
        with self._lock:
            if self._state == SessionState.ACTIVE and self._session_id is not None:
                self._submit_start(self._session_id, self._started_at_iso)
                return self._session_id
            return self._start_locked(send_start=True)

    def restart(self) -> str:
        """Synchronously rotate to a new session ID.

        Doubles as a manual start in ``auto_session=False`` mode. The old
        session, if any, is ended in the background with reason ``closed``.
        """
        with self._lock:
            if self._closed:
                raise ResolveTraceError("client has been shut down")
            old_id = self._session_id
            old_started_iso = self._started_at_iso
            self._cancel_timers_locked()
            if old_id is not None:
                self._submit_end(old_id, reason="explicit")
            self._reset_locked()
            return self._start_locked(send_start=True, prior_started_iso=None)
        # Note: prior_started_iso ignored — restart is a fresh session.

    def end(self, timeout_ms: float | None = None) -> None:
        """End the active session and send ``POST /v1/session/end``.

        ``timeout_ms`` is forwarded to the transport. When idle this is a
        no-op.
        """
        with self._lock:
            if self._state != SessionState.ACTIVE or self._session_id is None:
                return
            old_id = self._session_id
            self._state = SessionState.ENDING
            self._cancel_timers_locked()
            self._reset_locked()
        # Outside the lock so a slow transport can't deadlock new captures.
        self._submit_end(old_id, reason="explicit", timeout_ms=timeout_ms)

    def shutdown(self) -> None:
        """Cancel timers and emit a final ``session/end`` with reason ``shutdown``.

        Called from ``client.shutdown()``. After this the manager is inert;
        further ``ensure_started`` calls raise.
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
            old_id = self._session_id
            self._cancel_timers_locked()
            self._reset_locked()
        if old_id is not None:
            self._submit_end(old_id, reason="shutdown")

    def note_activity(self) -> None:
        """Record that an event was captured.

        Resets the inactivity timer; does NOT touch the max-duration timer.
        Cheap — designed to be called on every ``capture()``.
        """
        with self._lock:
            if self._state != SessionState.ACTIVE:
                return
            self._last_activity_monotonic = self._time_fn()
            self._reschedule_inactivity_timer_locked()

    # ---- identity convenience --------------------------------------------

    def set_identity(
        self, user_id: str | None, traits: dict[str, Any] | None = None
    ) -> None:
        """Set or clear identity (mirrors :class:`IdentityState`)."""
        self._identity.set(user_id, traits)

    def clear_identity(self) -> None:
        self._identity.clear()

    # ---- internals --------------------------------------------------------

    def _start_locked(
        self,
        *,
        send_start: bool,
        prior_started_iso: str | None = None,
    ) -> str:
        new_id = generate_ulid()
        started_iso = prior_started_iso or _iso_now()
        self._session_id = new_id
        self._started_at_iso = started_iso
        self._started_monotonic = self._time_fn()
        self._last_activity_monotonic = self._started_monotonic
        self._state = SessionState.ACTIVE
        self._schedule_timers_locked()
        if send_start:
            self._submit_start(new_id, started_iso)
        return new_id

    def _reset_locked(self) -> None:
        self._session_id = None
        self._started_at_iso = None
        self._started_monotonic = None
        self._last_activity_monotonic = None
        self._state = SessionState.IDLE

    def _cancel_timers_locked(self) -> None:
        if self._inactivity_timer is not None:
            self._inactivity_timer.cancel()
            self._inactivity_timer = None
        if self._max_duration_timer is not None:
            self._max_duration_timer.cancel()
            self._max_duration_timer = None

    def _schedule_timers_locked(self) -> None:
        self._cancel_timers_locked()
        inactivity_s = self._config.session_inactivity_ms / 1000.0
        max_s = self._config.session_max_duration_ms / 1000.0
        self._inactivity_timer = self._timer_factory(
            inactivity_s, self._on_inactivity_fired
        )
        self._max_duration_timer = self._timer_factory(
            max_s, self._on_max_duration_fired
        )

    def _reschedule_inactivity_timer_locked(self) -> None:
        if self._inactivity_timer is not None:
            self._inactivity_timer.cancel()
        inactivity_s = self._config.session_inactivity_ms / 1000.0
        self._inactivity_timer = self._timer_factory(
            inactivity_s, self._on_inactivity_fired
        )

    def _on_inactivity_fired(self) -> None:
        self._rollover(reason="inactivity")

    def _on_max_duration_fired(self) -> None:
        self._rollover(reason="max_duration")

    def _rollover(self, *, reason: str) -> None:
        with self._lock:
            if self._state != SessionState.ACTIVE or self._session_id is None:
                return
            if self._closed:
                return
            old_id = self._session_id
            self._cancel_timers_locked()
            self._reset_locked()
        # Fire-and-forget end; next capture lazy-starts a fresh session.
        self._submit_end(old_id, reason=reason)

    # ---- wire helpers -----------------------------------------------------

    def _submit_start(self, session_id: str, started_at: str | None) -> None:
        payload = self.build_start_payload(session_id, started_at or _iso_now())
        try:
            self._transport.submit_session_start(payload)
        except Exception as exc:  # transport must not crash the caller
            self._report_error(exc)

    def _submit_end(
        self,
        session_id: str,
        *,
        reason: str,
        timeout_ms: float | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "session_id": session_id,
            "ended_at": _iso_now(),
            "ended_reason": reason,
        }
        try:
            self._transport.submit_session_end(payload, timeout_ms=timeout_ms)
        except Exception as exc:
            self._report_error(exc)

    def build_start_payload(self, session_id: str, started_at: str) -> dict[str, Any]:
        """Construct the wire body for ``POST /v1/session/start``.

        Field order is fixed to match the TypeScript SDK's object-literal
        order so ``json.dumps`` produces byte-identical bytes for equivalent
        inputs in both runtimes.
        """
        payload: dict[str, Any] = {
            "session_id": session_id,
            "started_at": started_at,
        }
        # Session attributes — host-supplied free-form metadata.
        attrs = self._collect_session_attributes() or {}
        # The TS SDK pulls user_agent off the navigator inside the payload
        # builder; in Python we lift it out of attrs so callers can populate
        # it via session_attributes.
        ua = attrs.pop("user_agent", None) or attrs.pop("userAgent", None)
        if isinstance(ua, str) and ua:
            payload["user_agent"] = ua[:512]
        if attrs:
            payload["attributes"] = attrs

        # Identity — included only when set before the first capture.
        snapshot = self._identity.snapshot()
        if snapshot.user_id is not None:
            identify_block: dict[str, Any] = {"user_id": snapshot.user_id}
            if snapshot.traits is not None:
                identify_block["traits"] = dict(snapshot.traits)
            payload["identify"] = identify_block
        return payload

    def _collect_session_attributes(self) -> dict[str, Any]:
        if self._session_attributes is None:
            return {}
        try:
            result = self._session_attributes()
        except Exception as exc:
            self._report_error(exc)
            return {}
        if not isinstance(result, dict):
            return {}
        return result

    def _report_error(self, exc: Exception) -> None:
        if self._on_error is not None:
            try:
                self._on_error(exc)
            except Exception:  # pragma: no cover - defensive
                log.debug("on_error callback raised while handling: %s", exc)


def _iso_now() -> str:
    """Format the current UTC time as ``YYYY-MM-DDTHH:MM:SS.sssZ``."""
    ts = datetime.now(tz=timezone.utc)
    return ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


__all__ = [
    "DEFAULT_INACTIVITY_MS",
    "DEFAULT_MAX_DURATION_MS",
    "MIN_TIMEOUT_MS",
    "SessionConfig",
    "SessionManager",
    "SessionRequiredError",
    "SessionState",
    "SessionTransportProtocol",
    "validate_session_config",
]
