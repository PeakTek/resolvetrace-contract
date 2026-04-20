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
| `masking-parity`     | The TypeScript SDK and Python SDK produce identical redactions for the same PII input.                                          |
| `key-opacity`        | The SDK sends arbitrary-shaped API keys verbatim as `Authorization: Bearer <key>` without parsing or decoding.                  |
| `endpoint-parity`    | Optional: when multiple endpoints are supplied, all of them return structurally identical response shapes for the same request. |

## Prerequisites

- Node.js 20+
- Python 3.10+ (required only by the `masking-parity` case)
- `@peaktek/resolvetrace-sdk` (installed transitively from `sdk/typescript` via the workspace reference in `package.json`)
- `resolvetrace` (installed via `pip install -e sdk/python` — see below)

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

The TypeScript side calls the TypeScript SDK directly (via the
`@peaktek/resolvetrace-sdk` package link). We inject a `beforeSend` hook
that captures the post-scrub envelope and returns `null` to drop the event
so nothing hits the network.

The Python side is invoked as a subprocess:

```
python3 python-client/run_masking.py
```

- stdin: JSON of the form `{"attributes": {...}}`
- stdout: JSON of the form
  `{"applied": ["regex:email", ...], "attributes": {...}}`
- non-zero exit on error (details on stderr)

Both outputs are compared byte-identically after attribute-key sorting. A
discrepancy fails the case and surfaces the divergent `applied` lists and
attribute payloads in the report details.

## How `endpoint-parity` works

If `--additional-endpoint <url>` (or `CONFORMANCE_ADDITIONAL_ENDPOINTS`)
supplies one or more additional ingest URLs, the case probes `/v1/events`
against every endpoint with the same request body, then compares:

- HTTP status across probes
- Sorted set of response body keys

If any mismatch, the case fails with a diff. When no additional endpoint
is configured the case is skipped (status `skip`, reason
"`no --additional-endpoint values supplied; case is optional`").

## Writing against a Docker-compose OSS deployment

The default CI configuration runs this suite against a local docker-compose
stack that boots the OSS server skeleton (see
`.github/workflows/conformance.yml`). Point the harness at
`http://localhost:8080` and pass whatever API key the compose file
configures.

## License

Apache-2.0 — see the top-level `LICENSE`.
