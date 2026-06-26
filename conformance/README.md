# ResolveTrace conformance harness

Black-box test suite that verifies a ResolveTrace deployment implements the
public contract. Run this against any target that claims to speak the
ResolveTrace ingest API — your self-hosted OSS server, a staging
environment, or a managed endpoint — and get a pass/fail audit report
covering connectivity, schema conformance, idempotency, rate-limit shape,
replay upload, cross-language SDK parity, and API-key opacity.

The suite is intentionally deployment-agnostic. It takes an endpoint URL
and an opaque API key, then drives the same HTTP surface the SDKs use.

## What it checks

| Case                 | Summary                                                                                                                         |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `connectivity`       | `POST /v1/events` with a minimal valid envelope returns 2xx.                                                                    |
| `schema`             | Every `valid-*.json` fixture from `schemas/fixtures/` is accepted; every `invalid-*.json` fixture is rejected with HTTP 400.    |
| `idempotency`        | Re-sending the same `eventId` inside the dedup window is accepted both times.                                                   |
| `rate-limit`         | A bounded burst trips a 429 with the contract body shape + `Retry-After` / `X-RateLimit-*` headers.                             |
| `replay`             | `POST /v1/replay/signed-url` issues a URL, the PUT upload succeeds, and `POST /v1/replay/complete` accepts the manifest.        |
| `masking-parity`     | TS SDK scrubber applies the expected rules per PII sample (always), replay masking defaults ship identically and cannot be weakened (always); the cross-language TS↔Python check is policy-gated (see below). |
| `key-opacity`        | The SDK sends arbitrary-shaped API keys verbatim as `Authorization: Bearer <key>` without parsing or decoding.                  |
| `endpoint-parity`    | **Zero-change migration gate (D-D23).** A static layer proves the SDK emits a byte-identical request (modulo base URL) for every supported endpoint shape with the same payload + same opaque key; a live layer (when a second endpoint is configured) asserts acceptance + response-shape parity across them. See "Zero-change migration gate" below. |

## Prerequisites

- Node.js 20+
- `@peaktek/resolvetrace-sdk` (installed transitively from `sdk/typescript` via the workspace reference in `package.json`)
- Python 3.10+ **only** if you opt into the cross-language masking check
  (`CONFORMANCE_RUN_PYTHON_PARITY=1`); the Python SDK is otherwise frozen and
  that layer is skipped by default (see "How `masking-parity` works").

## Installation

From the root of the contract repo:

```bash
# Root TypeScript deps (schemas + OpenAPI tooling)
npm install

# Build the TypeScript SDK (produces sdk/typescript/dist/, which the
# harness imports via its `@peaktek/resolvetrace-sdk` file dependency).
cd sdk/typescript
npm install
npm run build

# Install the Python SDK in editable mode (required by masking-parity).
cd ../python
python3 -m pip install -e .

# Conformance harness workspace
cd ../../conformance
npm install
```

## Running

```bash
cd conformance
npx tsx src/index.ts \
  --endpoint https://ingest.resolvetrace.local \
  --api-key rt_live_XXXX
```

Environment variables are honoured when flags are omitted:

- `CONFORMANCE_ENDPOINT`
- `CONFORMANCE_API_KEY`
- `CONFORMANCE_ADDITIONAL_ENDPOINTS` (comma-separated list)
- `CONFORMANCE_PYTHON_CLIENT_PATH` (defaults to `./python-client`)
- `CONFORMANCE_PYTHON_BIN` (defaults to `python3`)
- `CONFORMANCE_RUN_PYTHON_PARITY` (`1` / `true`) — opt into the cross-language masking check (off by default; see below)
- `CONFORMANCE_REPORT_ONLY` / `CONFORMANCE_SKIP_NETWORK` (`1` / `true`)
- `CONFORMANCE_FORMAT` (`pretty` | `tap`)

The runner exits:

- `0` — all cases passed (or `--report-only` was set).
- `1` — at least one case failed.
- `2` — configuration or internal harness error.

### Useful flags

```bash
# Collect every result without failing the process.
npx tsx src/index.ts --report-only --endpoint ... --api-key ...

# Emit TAP instead of the human-readable summary.
npx tsx src/index.ts --format tap --endpoint ... --api-key ...

# Endpoint-swap parity against two additional endpoints.
npx tsx src/index.ts \
  --endpoint https://ingest.a.example \
  --additional-endpoint https://ingest.b.example \
  --additional-endpoint https://ingest.c.example \
  --api-key rt_live_XXXX
```

## How `masking-parity` works

The case runs three layers, all SDK-local (the server is never in the loop):

1. **TS scrubber correctness** (`masking-parity.ts.*`, always runs). For each
   sample in `src/fixtures/pii-samples.json` the TypeScript SDK is driven via a
   `beforeSend` hook that captures the post-scrub envelope and returns `null`
   (so nothing hits the network). We assert the applied rule set equals the
   sample's `expectedApplied`. This is the clean-runner masking coverage.

2. **Cross-language TS↔Python parity** (`masking-parity.cross-language.python`,
   **deferred by default**). Historically this ran the Python SDK as a
   subprocess (`python3 python-client/run_masking.py`; stdin
   `{"attributes": {...}}`, stdout `{"applied": [...], "attributes": {...}}`)
   and compared its redactions byte-for-byte with the TS SDK. The Python SDK is
   currently **frozen under the JS/TS-only policy** until the JS/TS surface is
   feature-complete, and on a clean runner it fails to import at all (its
   event-`type` validator uses a negative lookahead that pydantic-core's Rust
   `regex` engine rejects; PEP-668 distros additionally block `pip install -e`).
   So this layer emits a single, visible `skip` carrying that policy marker —
   coverage is not silently dropped (layers 1 and 3 still run), and the Python
   leg is not "fixed" to hide the freeze. Set `CONFORMANCE_RUN_PYTHON_PARITY=1`
   to force-run it where a working Python env exists.

3. **Replay masking policy** (`masking-parity.replay-policy`, always runs,
   TS-only — replay has no Python SDK). Asserts the shipped replay masking
   defaults (`maskAllInputs` forced `true`, `maskTextSelector` `'*'`, the
   default `blockSelector`) and the "masking is never weakened" invariant: host
   config may only *broaden* masking, never disable it. This is the replay-path
   analogue of the zero-change migration promise — replay redaction is
   identical-or-stronger across every deployment shape.

## Zero-change migration gate (`endpoint-parity`)

This case is the audit-surface form of the **zero-change migration** promise
(baseline **D-D23**): an OSS self-hoster can migrate to SaaS — or move between
any two supported endpoint shapes — with **zero code change**, because the SDK
carries no environment branches. The only things that differ between
deployments are (a) the base URL and (b) the opaque API key; tenant resolution
is entirely server-side (ADR-0008).

The supported endpoint shapes are enumerated in `ENDPOINT_SHAPES` in
`src/cases/endpoint-parity.ts`:

| Shape id                | Base URL                              | ADR-8 model | Status   |
|-------------------------|---------------------------------------|-------------|----------|
| `oss-self-hosted`       | `https://resolvetrace.local`          | A           | exercised |
| `saas-shared`           | `https://ingest.resolvetrace.com`     | B/C         | exercised |
| `saas-tenant-subdomain` | `https://ingest.acme.resolvetrace.com`| B/C         | **deferred** (documented row; see below) |

The case has two layers:

1. **Static gate** (`endpoint-parity.zero-change-static`, always runs,
   network-free). For each of several event types, it constructs the real SDK
   against **every** shape in the table with the **same** payload + the **same**
   opaque key, intercepts the outbound request sequence
   (`/v1/session/start` → `/v1/events` → `/v1/session/end`), and asserts the
   requests are byte-identical — method, path, headers (including the
   `Authorization: Bearer <key>` value) and body — once per-request volatile
   fields (ULIDs, timestamps, the scrubber's `durationMs`) are blanked. The
   only permitted difference is the base URL. A deployment that asked the SDK to
   reshape the path, rewrite the auth scheme, or inject a tenant field into the
   body would fail here.

   **What this proves:** the SDK is genuinely environment-agnostic — the same
   client code, the same payloads and the same opaque key produce the same wire
   requests for OSS, SaaS-shared and the (deferred) SaaS tenant-subdomain shape.
   That is the precondition for migrating with zero code change.

2. **Live cross-endpoint parity** (`endpoint-parity.live-cross-endpoint`). When
   one or more `--additional-endpoint <url>` (or
   `CONFORMANCE_ADDITIONAL_ENDPOINTS`) live endpoints are supplied, it drives a
   battery of real requests — events of several types, `/v1/session/start`, and
   `/v1/replay/signed-url` — at the primary endpoint and at each additional
   endpoint, then asserts **acceptance parity** (same success/failure verdict)
   and **response-shape parity** (same status + same sorted body-key set). When
   no second live endpoint is configured it records an explicit **`DEFERRED`**
   skip (not a silent pass) naming exactly what to wire up.

**Deferred endpoint shape (not a silent gap).** Model B/C per-tenant subdomain
(`ingest.acme.resolvetrace.com`) is a documented row in `ENDPOINT_SHAPES`. The
static gate already exercises it (the SDK treats it identically to any other
base URL — only the host label differs), but it is **not yet exercised
end-to-end against a live tenant-subdomain deployment**. To close that, stand up
a tenant-subdomain ingest and pass it via `--additional-endpoint`; the live
layer will pick it up with no code change to this case.

## Writing against a Docker-compose OSS deployment

The default CI configuration runs this suite against a local docker-compose
stack that boots the OSS server skeleton (see
`.github/workflows/conformance.yml`). Point the harness at
`http://localhost:8080` and pass whatever API key the compose file
configures.

## License

Apache-2.0 — see the top-level `LICENSE`.
