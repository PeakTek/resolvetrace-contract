"""Typed error classes raised by the ResolveTrace SDK.

Names match the TypeScript SDK (with Python's PascalCase convention for
classes). Each error extends ``ResolveTraceError`` so callers can catch the
family with a single ``except`` clause.
"""

from __future__ import annotations


class ResolveTraceError(Exception):
    """Base class for every error the SDK raises."""

    #: Stable, machine-readable identifier. Mirrors the TS SDK's ``code`` field.
    code: str = "resolvetrace_error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        self.message = message

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"[{self.code}] {self.message}"


class ConfigError(ResolveTraceError):
    """Invalid or missing SDK configuration.

    Raised at construction time when ``api_key``/``endpoint`` are malformed or
    when any forbidden keyword argument is supplied.
    """

    code = "config_error"


class TransportError(ResolveTraceError):
    """HTTP or network-layer failure outside the normal retry envelope.

    Raised when the event queue cannot drain within the SDK's retry budget or
    when a non-retryable server response is received.
    """

    code = "transport_error"

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds


class BudgetExceededError(ResolveTraceError):
    """Raised when the SDK trips a hard envelope limit.

    Examples: a single event whose post-scrub payload exceeds the max-single-
    event cap, or an API-key string longer than 4 KiB.
    """

    code = "budget_exceeded"
