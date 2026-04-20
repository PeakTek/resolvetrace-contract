"""Validation for ``ResolveTraceClient`` constructor options.

Implements the dumb-client contract: only ``api_key`` + ``endpoint`` are
accepted at construction time. A short allowlist of strictly-local hooks
(``on_error``, ``before_send``, ``debug``, ``transport``) is permitted; they
must never affect the wire payload.

Anything else — tenant identity, environment, region, auth strategy, feature
flags — is rejected with a typed ``ConfigError``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlparse

from .errors import ConfigError

#: Hard cap on the API-key string length. Mirrors the ingest-side
#: ``maxApiKeyLength`` — rejecting oversized keys at construction prevents
#: pre-auth CPU abuse.
MAX_API_KEY_BYTES = 4 * 1024

#: Forbidden kwargs. Any of these — even as an empty string — yields a
#: ``ConfigError``. Names cover both camelCase (to reject keys copy-pasted
#: from TS examples) and snake_case.
FORBIDDEN_KWARGS: frozenset[str] = frozenset(
    {
        # Tenancy — lives in the API-key claim.
        "tenant_id",
        "tenantId",
        "tenant_slug",
        "tenantSlug",
        "org",
        "account",
        # Environment — lives in the API-key claim.
        "environment",
        "env",
        # Region / residency — handled server-side.
        "region",
        "data_center",
        "dataCenter",
        "residency",
        # Auth strategy — fixed Bearer header.
        "auth_strategy",
        "authStrategy",
        # Feature flags that change wire format.
        "feature_flags",
        "featureFlags",
        "use_v2_events",
        "useV2Events",
        "new_batching",
        "newBatching",
        # URL-construction DSL.
        "host",
        "port",
        "path",
        "protocol",
        "scheme",
        # Multi-endpoint fan-out.
        "endpoints",
        "failover",
    }
)


#: Non-wire-affecting local hooks that may be passed alongside
#: ``api_key`` / ``endpoint`` without violating the dumb-client rule.
PERMITTED_LOCAL_KWARGS: frozenset[str] = frozenset(
    {"on_error", "before_send", "before_send_timeout_ms", "debug", "transport"}
)


@dataclass(frozen=True)
class ClientOptions:
    """Validated SDK configuration.

    Instances are produced via :func:`validate_options`. Fields map 1:1 to
    constructor arguments. Only ``api_key``/``endpoint`` travel to the wire;
    the rest are local to this process.
    """

    api_key: str
    endpoint: str
    on_error: Callable[[Exception], None] | None = None
    before_send: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
    before_send_timeout_ms: float = 4.0
    debug: bool = False
    transport: Any = field(default=None, repr=False)


def validate_options(
    *,
    api_key: Any,
    endpoint: Any,
    **local_kwargs: Any,
) -> ClientOptions:
    """Validate the constructor kwargs and return a ``ClientOptions``.

    Raises
    ------
    ConfigError
        On any invalid or forbidden argument.
    """
    _assert_non_empty_string(api_key, field_name="api_key")
    _assert_api_key_length(api_key)

    _assert_non_empty_string(endpoint, field_name="endpoint")
    _assert_valid_endpoint_url(endpoint)

    unknown: list[str] = []
    forbidden: list[str] = []
    for key in local_kwargs:
        if key in FORBIDDEN_KWARGS:
            forbidden.append(key)
        elif key not in PERMITTED_LOCAL_KWARGS:
            unknown.append(key)

    if forbidden:
        names = ", ".join(sorted(forbidden))
        raise ConfigError(
            f"The following constructor arguments are not allowed: {names}. "
            "Tenant, environment, region, and auth-strategy metadata live in "
            "the API key and are resolved server-side. Change only the "
            "endpoint when you migrate between deployments."
        )

    if unknown:
        names = ", ".join(sorted(unknown))
        raise ConfigError(
            f"Unknown constructor argument(s): {names}. "
            f"Accepted: api_key, endpoint, {', '.join(sorted(PERMITTED_LOCAL_KWARGS))}."
        )

    before_send_timeout_ms = local_kwargs.get("before_send_timeout_ms", 4.0)
    if (
        not isinstance(before_send_timeout_ms, (int, float))
        or before_send_timeout_ms <= 0
        or before_send_timeout_ms > 4.0
    ):
        raise ConfigError(
            "before_send_timeout_ms must be a positive number <= 4.0 "
            "(the ADR-0001 per-event scrub budget). Customer hooks may tighten, "
            "never loosen."
        )

    debug = local_kwargs.get("debug", False)
    if not isinstance(debug, bool):
        raise ConfigError("debug must be a boolean")

    return ClientOptions(
        api_key=api_key,
        endpoint=endpoint.rstrip("/"),
        on_error=local_kwargs.get("on_error"),
        before_send=local_kwargs.get("before_send"),
        before_send_timeout_ms=float(before_send_timeout_ms),
        debug=debug,
        transport=local_kwargs.get("transport"),
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _assert_non_empty_string(value: Any, *, field_name: str) -> None:
    if not isinstance(value, str):
        raise ConfigError(f"{field_name} must be a string")
    if len(value) == 0 or value.isspace():
        raise ConfigError(f"{field_name} must not be empty")


def _assert_api_key_length(api_key: str) -> None:
    if len(api_key.encode("utf-8")) > MAX_API_KEY_BYTES:
        raise ConfigError(
            f"api_key exceeds the maximum length of {MAX_API_KEY_BYTES} bytes"
        )


def _assert_valid_endpoint_url(endpoint: str) -> None:
    try:
        parsed = urlparse(endpoint)
    except (ValueError, TypeError) as exc:
        raise ConfigError(f"endpoint is not a valid URL: {exc!s}") from exc

    if parsed.scheme not in ("http", "https"):
        raise ConfigError(
            "endpoint must use https:// (http:// is allowed only for localhost dev)"
        )

    if not parsed.hostname:
        raise ConfigError("endpoint must include a hostname")

    if parsed.scheme == "http":
        host = parsed.hostname.lower()
        is_localhost = host in ("localhost", "127.0.0.1", "::1") or host.endswith(
            ".localhost"
        )
        if not is_localhost:
            raise ConfigError(
                "endpoint must use https:// outside of localhost development"
            )
