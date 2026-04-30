"""ResolveTrace Python SDK.

Public API entrypoints. The SDK follows a dumb-client contract: the only
wire-affecting configuration is ``api_key`` + ``endpoint``.

Typical usage::

    import asyncio
    from resolvetrace import create_client

    async def main() -> None:
        client = create_client(
            api_key="rt_live_...",
            endpoint="https://ingest.resolvetrace.com",
        )
        client.capture({"type": "app.started", "attributes": {"region": "ca"}})
        client.track("checkout_completed", {"cartValue": 42})
        await client.flush()
        await client.shutdown()

    asyncio.run(main())
"""

from __future__ import annotations

from .client import ResolveTraceClient, create_client
from .config import ClientOptions
from .envelope import EventEnvelope, EventInput
from .errors import (
    BudgetExceededError,
    ConfigError,
    ResolveTraceError,
    SessionRecoveryFailedError,
    SessionUnknownError,
    TransportError,
)
from .identity import IdentityState, IdentitySnapshot
from .models import (
    Diagnostics,
    EventBatchAcceptedResponse,
    EventBatchRequest,
    ReplaySignedUrlRequest,
    ScrubberReport,
    SdkIdentity,
    SessionEndPayload,
    SessionStartPayload,
    SessionStartRequest,
)
from .session import (
    DEFAULT_INACTIVITY_MS,
    DEFAULT_MAX_DURATION_MS,
    SessionManager,
    SessionRequiredError,
    SessionState,
)

__version__ = "0.1.0"

__all__ = [
    # Core client
    "ResolveTraceClient",
    "create_client",
    # Types & models
    "ClientOptions",
    "Diagnostics",
    "EventEnvelope",
    "EventInput",
    "EventBatchRequest",
    "EventBatchAcceptedResponse",
    "ReplaySignedUrlRequest",
    "ScrubberReport",
    "SdkIdentity",
    "SessionEndPayload",
    "SessionStartPayload",
    "SessionStartRequest",
    # Session manager + identity
    "DEFAULT_INACTIVITY_MS",
    "DEFAULT_MAX_DURATION_MS",
    "IdentityState",
    "IdentitySnapshot",
    "SessionManager",
    "SessionState",
    # Errors
    "ResolveTraceError",
    "ConfigError",
    "TransportError",
    "BudgetExceededError",
    "SessionRecoveryFailedError",
    "SessionRequiredError",
    "SessionUnknownError",
    # Version
    "__version__",
]
