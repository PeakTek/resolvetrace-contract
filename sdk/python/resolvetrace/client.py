"""``ResolveTraceClient`` — the public SDK entrypoint.

Public API mirrors the TypeScript SDK. Names align where PEP 8 permits;
``get_diagnostics`` is the only accepted snake_case/camelCase deviation from
literal-byte-parity (documented in the README). The *return shape* is keyed
camelCase so the serialized output of both SDKs is identical.

Constructor accepts only ``api_key`` + ``endpoint`` (plus a short list of
non-wire-affecting local hooks). Any other keyword argument is rejected at
construction time with a typed :class:`~.errors.ConfigError`.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .config import ClientOptions, validate_options
from .envelope import EventInput, build_envelope
from .errors import (
    ResolveTraceError,
    SessionRecoveryFailedError,
    SessionUnknownError,
)
from .identity import IdentityState
from .models import Diagnostics, EventsDroppedCounters, LastErrorInfo
from .scrubber import Scrubber
from .session import (
    SessionConfig,
    SessionManager,
    SessionRequiredError,
    _iso_now,
    validate_session_config,
)
from .transport import HttpTransport

log = logging.getLogger("resolvetrace.client")

#: SDK identity stamped on every envelope. ``name`` matches the PyPI package
#: so ingest-side analytics can separate TS vs. Python SDK traffic.
SDK_NAME = "resolvetrace-py"
SDK_VERSION = "0.1.0"
SDK_RUNTIME = "python"


class ResolveTraceClient:
    """Client for the ResolveTrace ingest API.

    Instantiate with :func:`create_client` or directly::

        client = ResolveTraceClient(
            api_key="rt_live_...",
            endpoint="https://ingest.resolvetrace.com",
        )

    Parameters
    ----------
    api_key:
        Opaque bearer token. The SDK never parses or decodes this string;
        it is sent verbatim in ``Authorization: Bearer <api_key>``.
    endpoint:
        Fully-qualified ingest URL. Changing this value is the *only* thing
        a user changes when migrating between deployments.

    Additional keyword arguments are rejected unless they appear in the
    permitted local-hook set (see ``config.PERMITTED_LOCAL_KWARGS``).
    """

    def __init__(self, *, api_key: str, endpoint: str, **local_kwargs: Any) -> None:
        options = validate_options(api_key=api_key, endpoint=endpoint, **local_kwargs)
        self._options: ClientOptions = options
        self._scrubber = Scrubber(sdk_version=SDK_VERSION)
        if options.transport is not None:
            self._transport = options.transport
        else:
            self._transport = HttpTransport(
                endpoint=options.endpoint,
                api_key=options.api_key,
                sdk_name=SDK_NAME,
                sdk_version=SDK_VERSION,
            )
        self._identity = IdentityState()
        session_config: SessionConfig = validate_session_config(
            session_inactivity_ms=options.session_inactivity_ms,
            session_max_duration_ms=options.session_max_duration_ms,
            auto_session=options.auto_session,
        )
        self._session = SessionManager(
            endpoint=options.endpoint,
            transport=self._transport,
            identity=self._identity,
            config=session_config,
            on_error=options.on_error,
            session_attributes=options.session_attributes,
        )

    # ---- public API --------------------------------------------------------

    def capture(self, event: EventInput | dict[str, Any]) -> str:
        """Enqueue a single event for transport. Returns its ULID event id."""
        try:
            try:
                session_id = self._session.ensure_started()
            except SessionRequiredError as exc:
                # auto_session=False mode without an explicit start. Drop
                # the event and surface via on_error.
                self._report_error(exc)
                return ""

            scrubbed_attrs, scrubber_report = self._scrubber.scrub(event.get("attributes"))
            event_with_scrubbed = dict(event)
            if scrubbed_attrs is not None:
                event_with_scrubbed["attributes"] = scrubbed_attrs
            event_with_scrubbed.setdefault("sessionId", session_id)

            # Decorate with the active identity, if any. Mirrors the TS SDK.
            snapshot = self._identity.snapshot()
            if snapshot.user_id is not None and "actor" not in event_with_scrubbed:
                actor: dict[str, Any] = {"userId": snapshot.user_id}
                if snapshot.traits is not None:
                    actor["traits"] = dict(snapshot.traits)
                event_with_scrubbed["actor"] = actor

            if self._options.before_send is not None:
                maybe = self._invoke_before_send(event_with_scrubbed)
                if maybe is None:
                    return ""
                event_with_scrubbed = maybe
                # before_send may have stripped sessionId — re-stamp.
                event_with_scrubbed.setdefault("sessionId", session_id)

            envelope = build_envelope(
                event_with_scrubbed,
                sdk_name=SDK_NAME,
                sdk_version=SDK_VERSION,
                sdk_runtime=SDK_RUNTIME,
                scrubber=scrubber_report,
            )
            self._transport.enqueue(envelope.payload)
            self._session.note_activity()
            return envelope.event_id
        except Exception as exc:
            self._report_error(exc)
            if isinstance(exc, ResolveTraceError):
                raise
            # Wrap unexpected errors so callers always see a typed exception.
            raise ResolveTraceError(str(exc)) from exc

    def track(self, name: str, attrs: dict[str, Any] | None = None) -> str:
        """Convenience wrapper over ``capture`` for named events."""
        if not isinstance(name, str) or not name:
            raise ResolveTraceError("track(name) requires a non-empty string")
        event: dict[str, Any] = {"type": name}
        if attrs is not None:
            event["attributes"] = dict(attrs)
        return self.capture(event)

    @property
    def session(self) -> SessionManager:
        """Public handle on the session manager.

        Use ``client.session.id`` for the current session ID,
        ``client.session.end()`` / ``client.session.restart()`` for explicit
        lifecycle control.
        """
        return self._session

    def identify(
        self, user_id: str | None, traits: dict[str, Any] | None = None
    ) -> None:
        """Set or clear the active identity.

        Calling ``identify(user_id, traits)`` decorates subsequent session
        starts with an ``identify: { userId, traits? }`` block and stamps an
        ``actor: { userId, traits? }`` block on every captured event.
        ``identify(None)`` clears identity. No network call is issued
        directly; identity surfaces with the next ``/v1/session/start`` and
        on each subsequent ``capture`` until cleared.
        """
        self._identity.set(user_id, traits)

    async def flush(self) -> None:
        """Force the transport to drain the queue.

        Safe to call repeatedly; returns once the queue is empty or the
        backend returns a non-retryable error. If the server rejects a
        batch with HTTP 409 ``session_unknown``, the SDK re-issues
        ``POST /v1/session/start`` for the active session ID and retries
        once. A second 409 surfaces a ``session_recovery_failed`` callback
        and the offending batch is dropped.
        """
        try:
            await self._transport.flush()
        except SessionUnknownError as exc:
            session_id = self._session.get_id()
            if session_id is None:
                self._report_error(exc)
                return
            try:
                # Re-issue start synchronously through the transport, then
                # retry the flush once. The transport is idempotent on the
                # session/start path.
                post_start = getattr(self._transport, "post_session_start", None)
                if post_start is not None:
                    started_at = getattr(self._session, "_started_at_iso", None) or _iso_now()
                    await post_start(
                        self._session.build_start_payload(session_id, started_at)
                    )
                await self._transport.flush()
            except SessionUnknownError as exc2:
                recovery = SessionRecoveryFailedError(
                    "events batch rejected with session_unknown after a "
                    "single recovery attempt; batch dropped",
                    session_id=exc2.session_id or session_id,
                )
                self._report_error(recovery)
                # Drop the batch from the head of the queue. We do NOT roll
                # over the session — this is a server-side reconciliation
                # issue, not a client-state issue.
                drop_head = getattr(self._transport, "_drop_head_batch", None)
                if callable(drop_head):
                    drop_head()

    async def shutdown(self) -> None:
        """Final flush + release of resources. The client is inert after this."""
        try:
            await self.flush()
        except Exception as exc:
            self._report_error(exc)
        self._session.shutdown()
        await self._transport.shutdown()

    def get_diagnostics(self) -> Diagnostics:
        """Return a snapshot of internal counters.

        Wire-key shape matches the TypeScript SDK's ``getDiagnostics()`` so
        downstream consumers that serialize the result across languages see
        identical JSON.
        """
        metrics = getattr(self._transport, "metrics", None)
        if metrics is None:
            empty: Diagnostics = {
                "queueDepth": 0,
                "queueBytes": 0,
                "eventsAccepted": 0,
                "eventsDropped": EventsDroppedCounters(
                    backpressure=0, scrubOverflow=0, payloadTooLarge=0
                ),
                "lastError": None,
                "scrubOverflowCount": 0,
                "max429RetriesExhaustedCount": 0,
            }
            return empty

        last_error: LastErrorInfo | None = None
        if metrics.last_error_code and metrics.last_error_at:
            last_error = {
                "code": metrics.last_error_code,
                "at": metrics.last_error_at,
            }

        diagnostics: Diagnostics = {
            "queueDepth": metrics.queue_depth,
            "queueBytes": metrics.queue_bytes,
            "eventsAccepted": metrics.events_accepted,
            "eventsDropped": EventsDroppedCounters(
                backpressure=metrics.events_dropped_backpressure,
                scrubOverflow=self._scrubber.scrub_overflow_count,
                payloadTooLarge=metrics.events_dropped_payload_too_large,
            ),
            "lastError": last_error,
            "scrubOverflowCount": self._scrubber.scrub_overflow_count,
            "max429RetriesExhaustedCount": metrics.max_429_retries_exhausted,
        }
        return diagnostics

    # ---- internal ----------------------------------------------------------

    def _invoke_before_send(
        self, event: dict[str, Any]
    ) -> dict[str, Any] | None:
        assert self._options.before_send is not None
        try:
            result = self._options.before_send(event)
        except Exception as exc:  # customer hook failures must not crash SDK
            self._report_error(exc)
            return event
        if result is None:
            return None
        if not isinstance(result, dict):
            raise ResolveTraceError(
                "before_send must return a dict or None; got "
                f"{type(result).__name__}"
            )
        return result

    def _report_error(self, exc: Exception) -> None:
        if self._options.on_error is not None:
            try:
                self._options.on_error(exc)
            except Exception as cb_exc:  # pragma: no cover - defensive
                log.debug("on_error callback raised: %s", cb_exc)
        if self._options.debug:
            log.debug("SDK error: %s", exc)


def create_client(
    *, api_key: str, endpoint: str, **local_kwargs: Any
) -> ResolveTraceClient:
    """Factory that mirrors the TS SDK's ``createClient(options)``.

    Using snake_case at module level matches PEP 8; the behaviour and
    accepted options are identical to the class constructor.
    """
    return ResolveTraceClient(api_key=api_key, endpoint=endpoint, **local_kwargs)


# Re-expose ``asyncio`` for callers who wire ``flush``/``shutdown`` without
# pulling it in separately. Harmless but keeps example code short.
__all__ = [
    "ResolveTraceClient",
    "SDK_NAME",
    "SDK_VERSION",
    "SDK_RUNTIME",
    "create_client",
    "asyncio",
]
