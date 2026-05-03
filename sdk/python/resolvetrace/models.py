"""Pydantic v2 models mirroring the JSON Schemas in ``schemas/``.

These are hand-authored for v0.1.0. A later wave replaces them with output
from ``datamodel-code-generator`` — see ``scripts/regenerate_models.py``. The
hand-authored shape is kept close to the generator's output so the swap is a
drop-in: snake_case Python attributes with camelCase wire aliases, no custom
``__init__`` bodies, and ``ConfigDict`` settings that match what the generator
emits by default.

Runtime validation on the hot path is opt-in — callers pay for it when they
call ``EventEnvelope.model_validate`` or when tests explicitly validate.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Shared base
# ---------------------------------------------------------------------------


class _Wire(BaseModel):
    """Base model: snake_case attributes, camelCase wire keys.

    All SDK wire models extend this. ``populate_by_name=True`` lets callers
    construct instances with either the Python attribute name or the wire
    alias, while serialization always emits the alias.
    """

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=False,
    )


# ---------------------------------------------------------------------------
# Events (schemas/events.json)
# ---------------------------------------------------------------------------


class ScrubberReport(_Wire):
    """Client-side scrubber application report attached to every envelope."""

    version: str = Field(..., min_length=1, max_length=64)
    rules_digest: str = Field(..., alias="rulesDigest", pattern=r"^sha256:[a-f0-9]{64}$")
    applied: list[str] = Field(default_factory=list, max_length=64)
    budget_exceeded: bool = Field(..., alias="budgetExceeded")
    duration_ms: float | None = Field(default=None, alias="durationMs", ge=0)


class SdkIdentity(_Wire):
    """SDK identity stamped on every envelope."""

    name: str = Field(..., min_length=1, max_length=64)
    version: str = Field(..., min_length=1, max_length=32)
    runtime: str | None = Field(default=None, min_length=1, max_length=64)


class EventEnvelopeModel(_Wire):
    """Pydantic model for the ingest event envelope.

    Re-exported as ``EventEnvelope`` from the Pydantic side; the client API
    hands callers a plain dataclass-backed representation via
    ``envelope.EventEnvelope`` and uses this model only when strict validation
    is required (tests, debug mode).
    """

    event_id: str = Field(..., alias="eventId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    session_id: str | None = Field(
        default=None, alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$"
    )
    type: str = Field(..., min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.\-:/]+$")
    captured_at: str = Field(..., alias="capturedAt")
    attributes: dict[str, Any] | None = None
    scrubber: ScrubberReport
    clock_skew_detected: bool | None = Field(default=None, alias="clockSkewDetected")
    sdk: SdkIdentity


class EventBatchRequest(_Wire):
    """Request body for ``POST /v1/events``."""

    events: list[EventEnvelopeModel] = Field(..., min_length=1, max_length=100)


class EventBatchAcceptedResponse(_Wire):
    """202 Accepted response body for ``POST /v1/events``."""

    accepted: int = Field(..., ge=0)
    duplicates: int = Field(..., ge=0)
    received_at: str = Field(..., alias="receivedAt")


# ---------------------------------------------------------------------------
# Replay chunk upload (schemas/replay.json)
# ---------------------------------------------------------------------------


class ReplaySignedUrlRequest(_Wire):
    """Request body for ``POST /v1/replay/signed-url``."""

    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    sequence: int = Field(..., ge=0)
    approx_bytes: int = Field(..., alias="approxBytes", ge=1, le=3_145_728)
    content_type: Literal["application/vnd.resolvetrace.replay+rrweb"] = Field(
        ..., alias="contentType"
    )


class ReplaySignedUrlResponse(_Wire):
    """201 response body for ``POST /v1/replay/signed-url``."""

    upload_url: str = Field(..., alias="uploadUrl")
    key: str = Field(..., min_length=1, max_length=512)
    expires_at: str = Field(..., alias="expiresAt")
    max_bytes: int = Field(..., alias="maxBytes", ge=1, le=3_145_728)
    required_headers: dict[str, str] = Field(..., alias="requiredHeaders")


class ReplayManifestRequest(_Wire):
    """Request body for ``POST /v1/replay/complete``."""

    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    sequence: int = Field(..., ge=0)
    key: str = Field(..., min_length=1, max_length=512)
    bytes_: int = Field(..., alias="bytes", ge=1, le=3_145_728)
    sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
    client_uploaded_at: str = Field(..., alias="clientUploadedAt")
    scrubber: ScrubberReport


class ReplayManifestResponse(_Wire):
    """200 response body for ``POST /v1/replay/complete``."""

    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    sequence: int = Field(..., ge=0)
    accepted_at: str = Field(..., alias="acceptedAt")
    durable: bool


# ---------------------------------------------------------------------------
# Session lifecycle (schemas/session.json)
# ---------------------------------------------------------------------------


ReleaseChannel = Literal["production", "staging", "development", "canary"]

SessionEndReason = Literal[
    "closed",
    "visibility_hidden",
    "beforeunload",
    "timeout",
    "shutdown",
    "error",
]


class SessionViewport(_Wire):
    width: int = Field(..., ge=0, le=20_000)
    height: int = Field(..., ge=0, le=20_000)
    device_pixel_ratio: float | None = Field(
        default=None, alias="devicePixelRatio", ge=0, le=16
    )


class SessionClient(_Wire):
    user_agent: str | None = Field(
        default=None, alias="userAgent", min_length=1, max_length=512
    )
    locale: str | None = Field(default=None, min_length=2, max_length=35)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    viewport: SessionViewport | None = None


class SessionStartRequest(_Wire):
    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    started_at: str = Field(..., alias="startedAt")
    app_version: str | None = Field(
        default=None, alias="appVersion", min_length=1, max_length=64
    )
    release_channel: ReleaseChannel | None = Field(default=None, alias="releaseChannel")
    client: SessionClient | None = None
    user_anon_id: str | None = Field(
        default=None, alias="userAnonId", min_length=1, max_length=128
    )


class SessionStartResponse(_Wire):
    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    accepted_at: str = Field(..., alias="acceptedAt")


class SessionEndRequest(_Wire):
    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    ended_at: str = Field(..., alias="endedAt")
    reason: SessionEndReason
    event_count: int | None = Field(default=None, alias="eventCount", ge=0)
    replay_chunk_count: int | None = Field(default=None, alias="replayChunkCount", ge=0)


class SessionEndResponse(_Wire):
    session_id: str = Field(..., alias="sessionId", pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$")
    accepted_at: str = Field(..., alias="acceptedAt")


# ---------------------------------------------------------------------------
# Session lifecycle wire payload types (TypedDict aliases for SDK callers
# that want a structural type without pulling Pydantic into their type
# annotations). Keys are camelCase to match the on-the-wire shape defined by
# ``schemas/session.json`` (and the TypeScript SDK's request bodies).
# ---------------------------------------------------------------------------


class SessionStartIdentify(TypedDict, total=False):
    userId: str
    traits: dict[str, Any]


class SessionStartClient(TypedDict, total=False):
    """Nested ``client`` block on ``SessionStartPayload``."""

    userAgent: str


class SessionStartPayload(TypedDict, total=False):
    """Wire shape submitted to ``POST /v1/session/start``.

    Field naming matches the TypeScript SDK so both runtimes produce
    byte-identical request bodies for equivalent inputs.
    """

    sessionId: str
    startedAt: str
    appVersion: str
    releaseChannel: str
    client: SessionStartClient
    userAnonId: str
    attributes: dict[str, Any]
    identify: SessionStartIdentify


class SessionEndPayload(TypedDict, total=False):
    """Wire shape submitted to ``POST /v1/session/end``.

    ``reason`` carries one of the values defined by
    :data:`SessionEndReason`.
    """

    sessionId: str
    endedAt: str
    reason: str


# ---------------------------------------------------------------------------
# API responses (schemas/api-responses.json)
# ---------------------------------------------------------------------------


class ErrorResponse(_Wire):
    error: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    message: str | None = Field(default=None, min_length=1, max_length=512)
    request_id: str | None = Field(
        default=None, alias="requestId", min_length=1, max_length=128
    )
    details: dict[str, Any] | None = None


class RateLimitErrorResponse(_Wire):
    error: Literal["rate_limit_exceeded", "service_unavailable_shed"]
    retry_after_seconds: int = Field(..., alias="retryAfterSeconds", ge=0, le=3600)
    class_: Literal["events", "replay_signed_url", "replay_complete", "session"] = Field(
        ..., alias="class"
    )
    dimension: Literal["requests", "events", "bytes"] | None = None
    scope: Literal["tenant", "global"]
    request_id: str | None = Field(default=None, alias="requestId")


# ---------------------------------------------------------------------------
# Diagnostics (ADR-0007 frozen shape)
# ---------------------------------------------------------------------------


class EventsDroppedCounters(TypedDict):
    """Drop counters, keyed by reason. Wire keys camelCase to match TS."""

    backpressure: int
    scrubOverflow: int
    payloadTooLarge: int


class LastErrorInfo(TypedDict):
    code: str
    at: str  # ISO-8601


class Diagnostics(TypedDict, total=False):
    """Return shape of ``ResolveTraceClient.get_diagnostics``.

    Keys are camelCase on the wire for identical serialized output vs. the
    TypeScript SDK's ``getDiagnostics`` (ADR-0007). The Python method name is
    snake_case per PEP 8; the *shape* is identical.
    """

    queueDepth: int
    queueBytes: int
    eventsAccepted: int
    eventsDropped: EventsDroppedCounters
    lastError: LastErrorInfo | None
    scrubOverflowCount: int
    max429RetriesExhaustedCount: int


# Public alias so callers can reference ``EventEnvelope`` without touching the
# full Pydantic-model name. The client returns a richer representation via
# ``envelope.EventEnvelope``; this alias covers the validation path.
EventEnvelope = EventEnvelopeModel


__all__ = [
    "Diagnostics",
    "ErrorResponse",
    "EventBatchAcceptedResponse",
    "EventBatchRequest",
    "EventEnvelope",
    "EventEnvelopeModel",
    "EventsDroppedCounters",
    "LastErrorInfo",
    "RateLimitErrorResponse",
    "ReleaseChannel",
    "ReplayManifestRequest",
    "ReplayManifestResponse",
    "ReplaySignedUrlRequest",
    "ReplaySignedUrlResponse",
    "ScrubberReport",
    "SdkIdentity",
    "SessionClient",
    "SessionEndPayload",
    "SessionEndReason",
    "SessionEndRequest",
    "SessionEndResponse",
    "SessionStartClient",
    "SessionStartIdentify",
    "SessionStartPayload",
    "SessionStartRequest",
    "SessionStartResponse",
    "SessionViewport",
]
