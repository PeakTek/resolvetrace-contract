"""Tests for ``resolvetrace.config``."""

from __future__ import annotations

import pytest

from resolvetrace.config import (
    FORBIDDEN_KWARGS,
    MAX_API_KEY_BYTES,
    validate_options,
)
from resolvetrace.errors import ConfigError


def test_accepts_api_key_and_endpoint() -> None:
    opts = validate_options(
        api_key="rt_live_abc",
        endpoint="https://ingest.resolvetrace.com",
    )
    assert opts.api_key == "rt_live_abc"
    assert opts.endpoint == "https://ingest.resolvetrace.com"


def test_strips_trailing_slash_from_endpoint() -> None:
    opts = validate_options(
        api_key="rt_live_abc",
        endpoint="https://ingest.resolvetrace.com/",
    )
    assert opts.endpoint == "https://ingest.resolvetrace.com"


def test_rejects_empty_api_key() -> None:
    with pytest.raises(ConfigError):
        validate_options(api_key="", endpoint="https://ingest.resolvetrace.com")


def test_rejects_oversized_api_key() -> None:
    big_key = "x" * (MAX_API_KEY_BYTES + 1)
    with pytest.raises(ConfigError, match="maximum length"):
        validate_options(api_key=big_key, endpoint="https://ingest.resolvetrace.com")


@pytest.mark.parametrize("bad", ["", "   ", "not-a-url", "ftp://example.com"])
def test_rejects_invalid_endpoints(bad: str) -> None:
    with pytest.raises(ConfigError):
        validate_options(api_key="rt_live_abc", endpoint=bad)


def test_http_allowed_for_localhost() -> None:
    for host in ("http://localhost:8000", "http://127.0.0.1:9000", "http://foo.localhost"):
        opts = validate_options(api_key="rt_live_abc", endpoint=host)
        assert opts.endpoint.startswith("http://")


def test_http_rejected_for_public_host() -> None:
    with pytest.raises(ConfigError, match="https"):
        validate_options(api_key="rt_live_abc", endpoint="http://example.com")


@pytest.mark.parametrize(
    "forbidden_kwarg",
    ["tenant_id", "tenantId", "environment", "region", "auth_strategy", "feature_flags"],
)
def test_rejects_forbidden_kwargs(forbidden_kwarg: str) -> None:
    assert forbidden_kwarg in FORBIDDEN_KWARGS
    with pytest.raises(ConfigError):
        validate_options(
            api_key="rt_live_abc",
            endpoint="https://ingest.resolvetrace.com",
            **{forbidden_kwarg: "anything"},
        )


def test_rejects_unknown_kwargs() -> None:
    with pytest.raises(ConfigError, match="Unknown"):
        validate_options(
            api_key="rt_live_abc",
            endpoint="https://ingest.resolvetrace.com",
            wibble=True,
        )


def test_accepts_local_hooks() -> None:
    def on_error(exc: Exception) -> None:
        return None

    opts = validate_options(
        api_key="rt_live_abc",
        endpoint="https://ingest.resolvetrace.com",
        on_error=on_error,
        debug=True,
        before_send_timeout_ms=2.0,
    )
    assert opts.on_error is on_error
    assert opts.debug is True
    assert opts.before_send_timeout_ms == 2.0


def test_before_send_timeout_cannot_exceed_budget() -> None:
    with pytest.raises(ConfigError):
        validate_options(
            api_key="rt_live_abc",
            endpoint="https://ingest.resolvetrace.com",
            before_send_timeout_ms=10.0,
        )


def test_debug_must_be_bool() -> None:
    with pytest.raises(ConfigError, match="boolean"):
        validate_options(
            api_key="rt_live_abc",
            endpoint="https://ingest.resolvetrace.com",
            debug="yes",
        )
