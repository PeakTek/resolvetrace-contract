"""Tests for ``resolvetrace.ulid``."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from resolvetrace.ulid import (
    ULID_ALPHABET,
    ULID_LENGTH,
    _encode_base32,
    generate_ulid,
)

ULID_PATTERN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def test_generate_ulid_matches_schema_pattern() -> None:
    value = generate_ulid()
    assert ULID_PATTERN.match(value)
    assert len(value) == ULID_LENGTH


def test_generate_ulid_alphabet_excludes_iluo() -> None:
    for forbidden in ("I", "L", "O", "U"):
        assert forbidden not in ULID_ALPHABET


def test_generate_ulid_uses_secrets_token_bytes() -> None:
    """Confirm the random component is sourced from ``secrets.token_bytes``."""
    fixed = bytes(range(10))
    with patch("resolvetrace.ulid.secrets.token_bytes", return_value=fixed) as mock:
        generate_ulid()
    mock.assert_called_once_with(10)


def test_generate_ulid_timestamp_component_sorts_chronologically() -> None:
    earlier = datetime(2024, 1, 1, tzinfo=timezone.utc)
    later = datetime(2026, 1, 1, tzinfo=timezone.utc)
    left = generate_ulid(now=earlier)
    right = generate_ulid(now=later)
    # ULIDs produced in chronological order sort lexicographically.
    assert left < right


def test_generate_ulid_accepts_naive_datetime_as_utc() -> None:
    naive = datetime(2025, 6, 1, 12, 0, 0)
    aware = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    assert generate_ulid(now=naive)[:10] == generate_ulid(now=aware)[:10]


def test_encode_base32_zero() -> None:
    assert _encode_base32(0, 10) == "0000000000"


def test_encode_base32_raises_when_overflow() -> None:
    with pytest.raises(ValueError):
        _encode_base32(1 << 60, 10)
