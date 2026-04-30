"""Lightweight fakes used by the session-manager test suite.

Avoid pulling in ``freezegun`` / ``time-machine``: dependency injection of
``time_fn`` and ``timer_factory`` into :class:`SessionManager` is enough for
deterministic tests.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any


class FakeClock:
    """Monotonic clock under test control. ``advance(seconds)`` moves it forward."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


class FakeTimer:
    """Inert ``Timer`` placeholder. ``cancel`` is a no-op."""

    def __init__(self, interval: float, callback: Callable[[], None]) -> None:
        self.interval = interval
        self.callback = callback
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


class FakeTimerScheduler:
    """Records every timer creation; tests inspect and fire on demand."""

    def __init__(self) -> None:
        self.timers: list[FakeTimer] = []

    def factory(self, interval: float, callback: Callable[[], None]) -> FakeTimer:
        timer = FakeTimer(interval, callback)
        self.timers.append(timer)
        return timer

    def fire_last(self) -> None:
        """Fire the most recently scheduled timer (simulates a timeout)."""
        active = [t for t in self.timers if not t.cancelled]
        if not active:
            raise AssertionError("no active timers to fire")
        active[-1].callback()

    def latest_with_interval(self, interval: float) -> FakeTimer | None:
        for timer in reversed(self.timers):
            if timer.interval == interval and not timer.cancelled:
                return timer
        return None


class FakeSessionTransport:
    """Captures session lifecycle calls without performing any I/O."""

    def __init__(self) -> None:
        self.starts: list[dict[str, Any]] = []
        self.ends: list[dict[str, Any]] = []

    def submit_session_start(self, payload: dict[str, Any]) -> None:
        self.starts.append(dict(payload))

    def submit_session_end(
        self, payload: dict[str, Any], *, timeout_ms: float | None = None
    ) -> None:
        del timeout_ms
        self.ends.append(dict(payload))


def run_async(coro: Awaitable[Any]) -> Any:
    """Run a coroutine to completion, working around event-loop reuse in tests."""
    return asyncio.get_event_loop().run_until_complete(coro)  # pragma: no cover
