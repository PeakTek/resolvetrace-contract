"""Tests for :mod:`resolvetrace.identity`."""

from __future__ import annotations

import threading

from resolvetrace.identity import IdentityState


def test_identity_starts_empty() -> None:
    state = IdentityState()
    snap = state.snapshot()
    assert snap.user_id is None
    assert snap.traits is None


def test_set_then_clear() -> None:
    state = IdentityState()
    state.set("u_42", {"plan": "pro"})
    snap = state.snapshot()
    assert snap.user_id == "u_42"
    assert snap.traits == {"plan": "pro"}

    state.set(None)
    cleared = state.snapshot()
    assert cleared.user_id is None
    assert cleared.traits is None


def test_traits_are_copied_on_set() -> None:
    state = IdentityState()
    traits = {"plan": "pro"}
    state.set("u", traits)
    traits["plan"] = "free"  # mutate the original

    snap = state.snapshot()
    assert snap.traits == {"plan": "pro"}  # internal copy is preserved


def test_clear_alias() -> None:
    state = IdentityState()
    state.set("u", {"a": 1})
    state.clear()
    assert state.snapshot().user_id is None


def test_concurrent_writers_are_safe() -> None:
    state = IdentityState()
    barrier = threading.Barrier(8)

    def worker(i: int) -> None:
        barrier.wait()
        for _ in range(50):
            state.set(f"u_{i}", {"i": i})
            _ = state.snapshot()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    snap = state.snapshot()
    # Whichever writer landed last wins; the invariant is that snapshot is
    # internally consistent.
    assert snap.user_id is not None
    assert snap.traits is not None
    assert int(snap.user_id.split("_")[1]) == snap.traits["i"]
