"""Envelope construction.

Builds the on-the-wire shape defined by ``schemas/events.json``. The caller
hands in an ``EventInput`` mapping; this module stamps identity (ULID, SDK
name/version, capture time) and the scrubber report, then returns a dict that
serializes to camelCase JSON matching the schema.

Python attributes are snake_case; the returned ``dict`` uses the schema's
camelCase keys so ``json.dumps(envelope)`` is byte-identical to what the TS
SDK emits for the same logical input.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, TypedDict

from .errors import BudgetExceededError
from .models import ScrubberReport
from .ulid import generate_ulid


#: Dot-or-slash event-type pattern from the schema. Open vocabulary with a
#: reserved canonical core: a value is valid iff it is one of the 14 canonical
#: literals OR a name that does not begin with a reserved canonical namespace
#: prefix (view. action. error. perf. ux. support.).
_EVENT_TYPE_PATTERN = re.compile(
    r"^(?:(?:view\.start|view\.end|action\.click|action\.submit"
    r"|action\.navigation|error\.js|error\.api|error\.resource"
    r"|perf\.api_latency|perf\.long_task|ux\.dead_click|ux\.rage_click"
    r"|ux\.repeated_submit|support\.report_submitted)"
    r"|(?!(?:view|action|error|perf|ux|support)\.)[a-zA-Z0-9_.\-:/]+)$"
)

#: Current major of the shared event schema. Producers stamp this on every
#: envelope (``schemaVersion``). Mirrors the TS SDK's ``SCHEMA_VERSION``.
SCHEMA_VERSION = 1

#: Max single-event payload after scrubbing. Tracked at transport-queue time.
MAX_SINGLE_EVENT_BYTES = 256 * 1024

#: Max single-string-field length before ``[...truncated]`` suffix applies.
MAX_SINGLE_STRING_BYTES = 64 * 1024


class EventInput(TypedDict, total=False):
    """Loose input shape accepted by :func:`build_envelope`.

    Matches the TS SDK's ``EventInput`` type. Only ``type`` is required;
    everything else is optional and filled in by the envelope builder.
    """

    type: str
    sessionId: str
    session_id: str
    attributes: dict[str, Any]
    capturedAt: str
    captured_at: str
    context: dict[str, Any]
    severity: str
    durationMs: int
    duration_ms: int
    httpStatus: int
    http_status: int


@dataclass
class EventEnvelope:
    """Fully-stamped envelope ready for transport.

    Exposes both the wire-ready ``payload`` dict (camelCase keys) and the
    snake_case attributes used inside the SDK.
    """

    event_id: str
    type: str
    captured_at: str
    scrubber: ScrubberReport
    sdk: dict[str, str]
    schema_version: int = SCHEMA_VERSION
    session_id: str | None = None
    context: dict[str, Any] | None = None
    severity: str | None = None
    duration_ms: int | None = None
    http_status: int | None = None
    attributes: dict[str, Any] | None = None
    actor: dict[str, Any] | None = None
    payload: dict[str, Any] = field(default_factory=dict)


def build_envelope(
    event: EventInput | dict[str, Any],
    *,
    sdk_name: str,
    sdk_version: str,
    sdk_runtime: str,
    scrubber: ScrubberReport,
    now: datetime | None = None,
) -> EventEnvelope:
    """Construct an :class:`EventEnvelope` from a user-supplied event dict.

    The input dict may provide keys in snake_case or camelCase; the wire
    output is always camelCase.
    """
    if not isinstance(event, dict):
        raise BudgetExceededError("event must be a mapping")

    event_type = event.get("type")
    if not isinstance(event_type, str) or not event_type:
        raise BudgetExceededError("event.type is required and must be a non-empty string")
    if len(event_type) > 128 or not _EVENT_TYPE_PATTERN.match(event_type):
        raise BudgetExceededError(
            "event.type must match ^[a-zA-Z0-9_.\\-:/]+$ and be <= 128 characters"
        )

    session_id = event.get("sessionId") or event.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        # Internal invariant: the client always populates sessionId via the
        # session manager before calling build_envelope. A missing value at
        # this point indicates a programming error in the SDK itself.
        raise BudgetExceededError(
            "envelope.sessionId is required (the session manager must "
            "populate it before envelope construction)"
        )
    captured_at = event.get("capturedAt") or event.get("captured_at") or _iso_now(now)
    attributes = event.get("attributes")
    actor = event.get("actor")
    context = event.get("context")
    severity = event.get("severity")
    duration_ms = event.get("durationMs") or event.get("duration_ms")
    http_status = event.get("httpStatus") or event.get("http_status")

    envelope = EventEnvelope(
        event_id=generate_ulid(now=now),
        type=event_type,
        captured_at=captured_at,
        scrubber=scrubber,
        sdk={"name": sdk_name, "version": sdk_version, "runtime": sdk_runtime},
        schema_version=SCHEMA_VERSION,
        session_id=session_id,
        context=context if isinstance(context, dict) else None,
        severity=severity if isinstance(severity, str) else None,
        duration_ms=duration_ms if isinstance(duration_ms, int) else None,
        http_status=http_status if isinstance(http_status, int) else None,
        attributes=attributes if isinstance(attributes, dict) else None,
        actor=actor if isinstance(actor, dict) else None,
    )

    envelope.payload = _to_wire(envelope)
    return envelope


def _iso_now(now: datetime | None) -> str:
    ts = now if now is not None else datetime.now(tz=timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    # Use milliseconds precision to match the TS SDK's ``toISOString()``.
    return ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


def _to_wire(envelope: EventEnvelope) -> dict[str, Any]:
    scrubber = envelope.scrubber.model_dump(by_alias=True, exclude_none=True)
    wire: dict[str, Any] = {
        "schemaVersion": envelope.schema_version,
        "eventId": envelope.event_id,
        "type": envelope.type,
        "capturedAt": envelope.captured_at,
        "scrubber": scrubber,
        "sdk": {k: v for k, v in envelope.sdk.items() if v is not None},
    }
    if envelope.session_id is not None:
        wire["sessionId"] = envelope.session_id
    if envelope.context is not None:
        wire["context"] = envelope.context
    if envelope.severity is not None:
        wire["severity"] = envelope.severity
    if envelope.duration_ms is not None:
        wire["durationMs"] = envelope.duration_ms
    if envelope.http_status is not None:
        wire["httpStatus"] = envelope.http_status
    if envelope.attributes is not None:
        wire["attributes"] = envelope.attributes
    if envelope.actor is not None:
        wire["actor"] = envelope.actor
    return wire


__all__ = [
    "EventEnvelope",
    "EventInput",
    "MAX_SINGLE_EVENT_BYTES",
    "MAX_SINGLE_STRING_BYTES",
    "build_envelope",
]
