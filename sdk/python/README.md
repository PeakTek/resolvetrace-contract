# resolvetrace

Official Python SDK for [ResolveTrace](https://resolvetrace.com). Captures
events and session telemetry from server-side Python applications and ships
them to the ResolveTrace ingest API.

- **Simple**: two-argument constructor. Your integration code never changes
  when you migrate between self-hosted and managed deployments.
- **Privacy-first**: deterministic PII redaction runs inside the SDK before
  data leaves the process.
- **Small surface**: 100% type-hinted, Apache-2.0 licensed, Python 3.10+.

## Install

```bash
pip install resolvetrace
```

## Quickstart

```python
import asyncio
from resolvetrace import create_client


async def main() -> None:
    client = create_client(
        api_key="rt_live_eyJ...",
        endpoint="https://ingest.resolvetrace.com",
    )

    # Capture an arbitrary event.
    client.capture({
        "type": "app.started",
        "attributes": {"region": "ca-central-1", "version": "4.2.0"},
    })

    # Convenience wrapper for named events.
    client.track("checkout_completed", {"cartValue": 42.50})

    # Drain the queue before the process exits.
    await client.flush()
    await client.shutdown()


asyncio.run(main())
```

`capture()` returns the event's ULID synchronously, so you can correlate
log lines with ingest records immediately.

## Options

The constructor accepts exactly two wire-affecting arguments:

| Argument   | Type  | Required | Notes                                     |
| ---------- | ----- | -------- | ----------------------------------------- |
| `api_key`  | `str` | yes      | Opaque bearer token. Max 4 KiB.           |
| `endpoint` | `str` | yes      | Fully-qualified ingest URL (`https://…`). |

A short set of strictly-local hooks is also accepted. None of these affect
what bytes travel on the wire:

| Keyword                   | Default     | Notes                                                                   |
| ------------------------- | ----------- | ----------------------------------------------------------------------- |
| `on_error(exc)`           | `None`      | Called on every internal error so you can forward to your app's logger. |
| `before_send(event)`      | `None`      | User-owned redaction hook. Runs *after* the SDK's built-in scrubber.    |
| `before_send_timeout_ms`  | `4.0`       | Upper bound on the hook above; customer code may tighten, never loosen. |
| `debug`                   | `False`     | Toggles SDK-internal debug logging (no `Authorization` values logged).  |
| `transport`               | `None`      | Inject a pre-built transport for tests only.                            |
| `session_inactivity_ms`   | `1_800_000` | Idle timeout (ms) before the SDK rolls a new session. May be lowered.   |
| `session_max_duration_ms` | `43_200_000`| Hard cap (ms) on a single session's lifetime. May be lowered.           |
| `auto_session`            | `True`      | When `False`, the SDK never auto-starts a session — you call `client.session.restart()` yourself before the first `capture()`. |
| `session_attributes`      | `None`      | Callable returning a dict of free-form session metadata. Invoked once per session start. |

Any other keyword argument is rejected with a typed `ConfigError`. In
particular the following are **not** accepted: `tenant_id`, `environment`,
`region`, `auth_strategy`, `feature_flags`, or any URL-construction keys.
Tenant identity and environment live inside the signed API key and are
resolved server-side.

## Public API

The SDK exposes the same surface across every supported language. Python
uses `snake_case` for the `get_diagnostics()` method name per PEP 8; the
method's **return shape** is keyed `camelCase` so the serialized output
matches the TypeScript SDK byte-for-byte.

| Method                          | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `capture(event) -> str`         | Enqueue one event. Returns its ULID event id synchronously.            |
| `track(name, attrs=None)`       | Convenience wrapper around `capture` for named events.                 |
| `async flush()`                 | Drain the queue immediately. Safe to call repeatedly.                  |
| `async shutdown()`              | Final flush + release of timers/tasks. Client is inert after this.     |
| `get_diagnostics()`             | Snapshot of internal counters (queue depth, drops, last error, …).     |
| `client.session.id`             | Currently-active session ULID, or `None` if no session is open.        |
| `client.session.end()`          | Explicitly end the current session and emit `POST /v1/session/end`.    |
| `client.session.restart()`      | Synchronously rotate to a new session ULID. Returns the new id.        |
| `client.identify(user_id, traits=None)` | Decorate the next session-start with the given identity. Pass `None` to clear. |

## Sessions

Every event carries a `session_id`. By default the SDK manages session
lifecycle for you:

- The first `capture()` call after `create_client(...)` lazy-starts a
  session. A ULID is generated client-side and `POST /v1/session/start` is
  fired in the background.
- The session rolls over automatically after 30 minutes without a
  `capture()` call (inactivity), or after 12 hours regardless of activity
  (max duration). Both timeouts are configurable downward — they cannot be
  raised above the defaults.
- `client.session.end()` ends the current session synchronously; the next
  `capture()` will lazy-start a fresh one.
- `client.session.restart()` rotates immediately to a new session.

Set `auto_session=False` if you want full control. In that mode the SDK
never auto-starts; you must call `client.session.restart()` yourself before
the first `capture()`. Capturing without an active session emits a typed
`session_required` error via `on_error` and drops the event.

`client.identify(user_id, traits)` records the active identity in memory.
The next `POST /v1/session/start` body includes an `identify` block with
the user id and any traits you pass. `identify(None)` clears it. This
never issues a network call by itself — identity surfaces with the next
session start.

If `POST /v1/events` returns HTTP 409 with `{"error": "session_unknown"}`,
the SDK reissues `POST /v1/session/start` for the same id and retries the
batch once. A second 409 surfaces a `session_recovery_failed` error via
`on_error`; the offending batch is dropped and the session id is kept.

## Privacy & redaction

Before any event leaves this process, the SDK runs a deterministic scrubber
that redacts well-known PII patterns (email, US SSN, Canadian SIN with
Luhn, E.164 phone numbers with country code, Luhn-validated credit cards)
plus any attribute paths you pass via `mask_selectors`. Redactions are
recorded on the envelope in the `scrubber` field so downstream consumers
can audit what the SDK did.

The scrubber runs under a hard per-event budget. If the budget trips,
unprocessed string values are replaced with `[REDACTED_OVERFLOW]` before
the event is dispatched — no unredacted field ever leaves the SDK under
the overflow path.

## FAQ

### Do I need to configure a region / tenant / environment?

No. All of those live inside the signed API key. When you move from
self-hosted to SaaS, you change the `endpoint` string and nothing else.

### Is the SDK thread-safe / async-safe?

`capture()` and `track()` are non-blocking and safe to call from any
synchronous context. `flush()` and `shutdown()` are `async` and should be
awaited from your application's event loop (typical frameworks — FastAPI,
Starlette, AIOHTTP — run one). A blocking wrapper can be added in a
follow-up release if there's demand.

### Why is `get_diagnostics()` snake_case when the TypeScript SDK uses
camelCase?

Python convention is snake_case for methods; JavaScript is camelCase. This
is the only accepted naming deviation between the two SDKs. The *return
shape* of `get_diagnostics()` uses `camelCase` keys so the JSON you emit
downstream is byte-identical across languages.

### How do I retry after a network outage?

You don't — the SDK does. Failures automatically back off with exponential
full-jitter (up to 5 retries per batch) and honour any `Retry-After`
header the server sends, clamped to 60 seconds.

### What happens when the queue fills up?

The SDK drops *newest* events first (tail-drop) and resumes accepting
traffic once the queue falls back below 90% of its caps. Dropped events
are recorded in `get_diagnostics()['eventsDropped']['backpressure']`.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
