"""Tests for the envelope builder and its conformance with ``schemas/events.json``."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from resolvetrace.envelope import build_envelope
from resolvetrace.models import EventEnvelope, ScrubberReport
from resolvetrace.scrubber import rules_digest

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "schemas" / "events.json"
)

ULID_PATTERN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


@pytest.fixture(scope="module")
def schema() -> dict:
    with SCHEMA_PATH.open(encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture
def scrubber_report() -> ScrubberReport:
    return ScrubberReport(
        version="sdk@0.1.0",
        rulesDigest=rules_digest(),
        applied=["regex:email"],
        budgetExceeded=False,
        durationMs=0.42,
    )


_TEST_SESSION_ID = "01HZK3X4Q2P5RHARSESNHGMDPV"


def test_build_envelope_uses_camel_case_keys(scrubber_report: ScrubberReport) -> None:
    envelope = build_envelope(
        {
            "type": "app.started",
            "sessionId": _TEST_SESSION_ID,
            "attributes": {"userAnonId": "abc"},
        },
        sdk_name="resolvetrace-py",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
    )
    payload = envelope.payload
    assert "eventId" in payload
    assert "capturedAt" in payload
    assert "scrubber" in payload
    assert "sdk" in payload
    assert payload["type"] == "app.started"
    # snake_case forms must not leak onto the wire.
    assert "event_id" not in payload
    assert "captured_at" not in payload


def test_envelope_event_id_matches_ulid_pattern(scrubber_report: ScrubberReport) -> None:
    envelope = build_envelope(
        {"type": "dom.click", "sessionId": _TEST_SESSION_ID},
        sdk_name="resolvetrace-py",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
    )
    assert ULID_PATTERN.match(envelope.payload["eventId"])


def test_envelope_session_id_supports_camel_and_snake_input(
    scrubber_report: ScrubberReport,
) -> None:
    camel = build_envelope(
        {"type": "e", "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        sdk_name="n",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
    )
    snake = build_envelope(
        {"type": "e", "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        sdk_name="n",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
    )
    assert camel.payload["sessionId"] == snake.payload["sessionId"]


def test_envelope_scrubber_fields_present(scrubber_report: ScrubberReport) -> None:
    envelope = build_envelope(
        {"type": "anything", "sessionId": _TEST_SESSION_ID},
        sdk_name="n",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
    )
    scrubber = envelope.payload["scrubber"]
    assert scrubber["version"] == "sdk@0.1.0"
    assert scrubber["rulesDigest"].startswith("sha256:")
    assert scrubber["budgetExceeded"] is False
    assert "applied" in scrubber


def test_envelope_rejects_bad_type(scrubber_report: ScrubberReport) -> None:
    from resolvetrace.errors import BudgetExceededError

    with pytest.raises(BudgetExceededError):
        build_envelope(
            {"type": "contains spaces", "sessionId": _TEST_SESSION_ID},
            sdk_name="n",
            sdk_version="0.1.0",
            sdk_runtime="python",
            scrubber=scrubber_report,
        )


def test_envelope_requires_session_id(scrubber_report: ScrubberReport) -> None:
    from resolvetrace.errors import BudgetExceededError

    with pytest.raises(BudgetExceededError):
        build_envelope(
            {"type": "needs.session"},
            sdk_name="n",
            sdk_version="0.1.0",
            sdk_runtime="python",
            scrubber=scrubber_report,
        )


def test_envelope_validates_against_pydantic_schema_model(
    scrubber_report: ScrubberReport,
) -> None:
    envelope = build_envelope(
        {"type": "app.started", "sessionId": _TEST_SESSION_ID, "attributes": {"a": 1}},
        sdk_name="resolvetrace-py",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
    )
    # Parsing the wire payload through the strict Pydantic model confirms
    # the envelope shape matches the contract schema.
    model = EventEnvelope.model_validate(envelope.payload)
    assert model.event_id == envelope.payload["eventId"]
    assert model.sdk.name == "resolvetrace-py"


def test_envelope_captured_at_iso8601_with_milliseconds(
    scrubber_report: ScrubberReport,
) -> None:
    now = datetime(2026, 4, 20, 12, 0, 0, 123456, tzinfo=timezone.utc)
    envelope = build_envelope(
        {"type": "x", "sessionId": _TEST_SESSION_ID},
        sdk_name="n",
        sdk_version="0.1.0",
        sdk_runtime="python",
        scrubber=scrubber_report,
        now=now,
    )
    # TS SDK emits ISO 8601 with millisecond precision; we match.
    assert envelope.payload["capturedAt"] == "2026-04-20T12:00:00.123Z"


def test_schema_event_envelope_required_fields(schema: dict) -> None:
    """Quick sanity check that our schema file has the expected structure."""
    definitions = schema["definitions"]
    required = set(definitions["EventEnvelope"]["required"])
    assert required == {"eventId", "type", "capturedAt", "scrubber", "sdk"}
