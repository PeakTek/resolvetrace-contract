"""Per-client identity state.

Holds the in-memory ``(user_id, traits)`` pair set by ``client.identify(...)``.
Kept separate from session lifecycle so identity changes never roll over a
session.

The wire-format mapping in the current contract surfaces identity at session
start time via the ``userAnonId`` field on ``/v1/session/start``. Free-form
``traits`` are not carried on the wire today (the event envelope schema is
``additionalProperties: false`` and has no slot for them); they remain
available via :meth:`IdentityState.snapshot` for in-process use, e.g. by a
custom ``before_send`` hook that wants to inject them into ``attributes``.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class IdentitySnapshot:
    """Immutable read of the current identity, returned by :meth:`IdentityState.snapshot`."""

    user_id: str | None
    traits: dict[str, Any] | None


class IdentityState:
    """Thread-safe identity holder.

    The instance is shared between the session manager (which reads it when
    building ``/v1/session/start`` bodies) and the client (which reads it
    when constructing event envelopes).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._user_id: str | None = None
        self._traits: dict[str, Any] | None = None

    def set(self, user_id: str | None, traits: dict[str, Any] | None = None) -> None:
        """Set or clear the active identity.

        Passing ``user_id=None`` clears identity (subsequent reads return
        ``None``). ``traits`` is stored as a shallow copy.
        """
        with self._lock:
            self._user_id = user_id
            if user_id is None:
                self._traits = None
            else:
                self._traits = dict(traits) if traits else None

    def clear(self) -> None:
        """Equivalent to ``set(None)``."""
        self.set(None)

    def snapshot(self) -> IdentitySnapshot:
        """Return a stable copy of the current identity."""
        with self._lock:
            traits_copy = dict(self._traits) if self._traits is not None else None
            return IdentitySnapshot(user_id=self._user_id, traits=traits_copy)

    @property
    def user_id(self) -> str | None:
        with self._lock:
            return self._user_id


__all__ = ["IdentityState", "IdentitySnapshot"]
