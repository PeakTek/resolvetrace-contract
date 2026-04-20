# @peaktek/resolvetrace-sdk

Official TypeScript SDK for [ResolveTrace](https://resolvetrace.com). Works in
Node 18+ and modern browsers with zero runtime dependencies.

## Install

```bash
npm install @peaktek/resolvetrace-sdk
```

## Quickstart

```ts
import { createClient } from '@peaktek/resolvetrace-sdk';

const rt = createClient({
  apiKey: process.env.RESOLVETRACE_API_KEY!,
  endpoint: 'https://ingest.resolvetrace.com',
});

rt.track('page_view', { path: '/home' });
```

That's it — the SDK batches events in memory and flushes automatically on an
interval, on batch-size thresholds, and on `shutdown()`. Calls to `capture` /
`track` return immediately and do not block your app.

## Options

The constructor accepts **exactly** these options. Passing anything else
(for example `tenantId`, `environment`, or `region`) will throw a
`ConfigError` — routing and identity are encoded in the API key itself.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` (required) | `string` | — | Opaque bearer token issued by ResolveTrace. |
| `endpoint` (required) | `string` | — | Fully-qualified URL (`https://` required outside of localhost). |
| `onError` | `(err: Error) => void` | — | Called when the SDK hits a transport error. Never throws. |
| `beforeSend` | `(env) => env \| null` | — | Pre-send hook. Runs **after** the built-in scrubber; cannot re-expand redactions. Return `null` to drop. |
| `beforeSendTimeoutMs` | `number` | `4` | Max ms spent inside `beforeSend`. May be lowered; clamped at `4`. |
| `debug` | `boolean` | `false` | Log SDK internals to the console (API key is redacted). |
| `maskSelectors` | `string[]` | `[]` | CSS selectors whose matched elements the scrubber should mask. |
| `transport` | `typeof fetch` | `globalThis.fetch` | Injectable fetch, for tests. |

## API

### `createClient(options)` / `new ResolveTraceClient(options)`

Both forms are supported — the factory is idiomatic; the class is exported so
you can type it as a dependency in your own code.

### `client.capture(event)`

Queues an event. Returns the ULID assigned to it synchronously, so you can
correlate the send with your app logs.

```ts
const id = rt.capture({
  type: 'app.signup.completed',
  attributes: { plan: 'pro', source: 'marketing-site' },
});
```

### `client.track(name, attrs?)`

Convenience wrapper over `capture` for the common case.

### `client.flush(opts?)`

Forces an immediate send of everything currently queued. Returns a summary
with `{ completed, sent, dropped }`. Safe to call repeatedly.

### `client.shutdown(opts?)`

Final flush + timer release. Typically called on page unload (browser) or
process shutdown (server). Subsequent `capture` calls are dropped.

### `client.getDiagnostics()`

Returns a snapshot of internal counters — useful for surfacing SDK health in
your own observability dashboard.

## FAQ

**Does the SDK persist events to disk in the browser?**
No. Events held in the in-memory queue are dropped if the tab closes before a
flush completes; this is intentional so the SDK never writes user data to
`localStorage`, cookies, or IndexedDB.

**What happens when the network is down?**
The SDK retries with exponential backoff (full jitter, up to 30 s per attempt,
5 attempts total), and honors `Retry-After` on 429 / 503. Events that outlive
the retry envelope are dropped; the drop is reflected in `getDiagnostics()`.

**Can I turn off the built-in scrubber?**
No. The SDK ships with a deterministic Stage-1 scrubber (email, SSN, SIN,
E.164 phone, Luhn-validated credit-card, `<input type="password">`, and
`data-private` / `data-rt-mask` attributes). You can **extend** masking via
`maskSelectors`, but you cannot disable the baseline rules.

**How do I run it in React Native / edge runtimes?**
Pass a fetch-compatible `transport` override. The SDK depends only on
`fetch`, `URL`, and `crypto.getRandomValues`.

**Why can't I pass `tenantId` / `environment` / `region`?**
Every piece of identity and routing metadata is encoded in your API key
server-side. This keeps the SDK stable across deployment shapes — switching
from self-host to SaaS is a one-line endpoint change, nothing more.

## License

Apache-2.0. See `LICENSE`.
