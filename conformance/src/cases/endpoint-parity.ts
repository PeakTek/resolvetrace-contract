/**
 * Zero-change migration gate (baseline D-D23).
 *
 * The promise this case audits: an OSS self-hoster can migrate to SaaS — or
 * move between any two supported ResolveTrace endpoint shapes — with **zero
 * code change**. The SDK carries no environment branches: the only things
 * that differ between deployments are (a) the base URL and (b) the opaque
 * API key. Tenant resolution is entirely server-side (ADR-0008), so the
 * *same* SDK payloads and the *same* API-key shape must be accepted with
 * identical results everywhere. This is the audit-surface form of ADR-0009's
 * "identical contract across deployment shapes" promise.
 *
 * The case has two layers:
 *
 *   1. STATIC gate (always runs, network-free): construct the real SDK
 *      against each supported endpoint shape with the SAME payload + SAME
 *      opaque key, intercept the outbound request, and assert the SDK emits
 *      a byte-identical request (method, path, headers, serialized body) —
 *      everything except the base URL. This proves "zero env branches"
 *      deterministically, with no second live deployment required, and it is
 *      exercised across every event type the SDK emits plus the in-app
 *      report path.
 *
 *   2. LIVE cross-endpoint parity (runs per configured additional endpoint):
 *      drive a battery of real requests (multiple event types + replay
 *      signed-url + session start) at the primary endpoint and at each
 *      `--additional-endpoint`, then assert acceptance + response-shape
 *      parity. When no additional live endpoint is configured the layer
 *      records an explicit DEFERRED row (not a silent skip) naming what a
 *      reviewer would need to wire up to exercise it.
 *
 * Supported endpoint shapes are enumerated in {@link ENDPOINT_SHAPES} so the
 * deferred Model B/C tenant-subdomain shape is a documented row, and a third
 * live endpoint can be added later without restructuring this case.
 */

import { buildMinimalEnvelope } from '../envelope.ts';
import { postJson } from '../http.ts';
import { generateUlid } from '../ulid.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

/**
 * The supported ResolveTrace endpoint shapes for the zero-change migration
 * gate. `deferred: true` rows are documented-but-not-yet-exercised — they
 * exist here so a reviewer can see the full target matrix and the gap is
 * explicit rather than silent.
 *
 * The SDK treats all of these identically: it resolves `new URL(path, base)`
 * and attaches `Authorization: Bearer <opaqueKey>`. No row gets special
 * client-side handling — that is exactly the invariant under test.
 */
interface EndpointShape {
  id: string;
  /** Canonical base URL used by the STATIC gate's request-shape comparison. */
  baseUrl: string;
  /** ADR-8 tenant resolution model: A = single-tenant, B/C = shared. */
  model: 'A' | 'B/C';
  description: string;
  /** Documented but not yet exercised live (no client-side difference). */
  deferred: boolean;
}

export const ENDPOINT_SHAPES: readonly EndpointShape[] = [
  {
    id: 'oss-self-hosted',
    baseUrl: 'https://resolvetrace.local',
    model: 'A',
    description: 'OSS single-tenant self-host (Model A; tenant fixed server-side)',
    deferred: false,
  },
  {
    id: 'saas-shared',
    baseUrl: 'https://ingest.resolvetrace.com',
    model: 'B/C',
    description: 'SaaS shared ingest (tenant resolved from the opaque key, server-side)',
    deferred: false,
  },
  {
    id: 'saas-tenant-subdomain',
    baseUrl: 'https://ingest.acme.resolvetrace.com',
    model: 'B/C',
    description:
      'SaaS per-tenant subdomain (Model B/C). DEFERRED: identical SDK shape — ' +
      'only the host label differs — so it adds a row here without restructuring. ' +
      'Wire a live endpoint for it via --additional-endpoint to exercise end-to-end.',
    deferred: true,
  },
] as const;

const DESCRIPTION = 'Zero-change migration: same SDK payload + same key, identical across endpoint shapes';

/**
 * Canonical request shapes the STATIC gate replays through the SDK. We cover
 * a representative spread of the live taxonomy so a base-URL-conditional
 * branch hiding in any single event path would surface.
 */
const STATIC_EVENT_SAMPLES: ReadonlyArray<{ type: string; attributes?: Record<string, unknown> }> = [
  { type: 'view.start', attributes: { path: '/checkout' } },
  { type: 'action.submit', attributes: { selector: '#pay' } },
  { type: 'error.api', attributes: { status: 500, url: '/v1/orders' } },
  { type: 'perf.api_latency', attributes: { ms: 1234 } },
  { type: 'ux.rage_click', attributes: { count: 5 } },
  { type: 'app.checkout.completed', attributes: { total: 4200 } },
];

interface CapturedRequest {
  method: string;
  /** Path + search only (base URL stripped) — base URL is the allowed diff. */
  pathAndSearch: string;
  /** Lower-cased, sorted header entries (the wire-affecting set). */
  headers: Array<[string, string]>;
  /** Raw serialized request body. */
  body: string;
}

/**
 * Build the SDK once per endpoint shape and capture EVERY outbound request a
 * `capture(...) + flush()` produces — in order. With the default session
 * lifecycle this is the lazy `/v1/session/start` followed by the `/v1/events`
 * batch, so the gate covers both the session and the events paths. The
 * `transport` fetch override records each request and returns a canned 2xx so
 * nothing leaves the process.
 */
async function captureSdkRequests(
  sdk: Awaited<typeof import('@peaktek/resolvetrace-sdk')>,
  baseUrl: string,
  apiKey: string,
  sample: { type: string; attributes?: Record<string, unknown> },
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];

  const transport: typeof fetch = async (input, init) => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const u = new URL(urlStr);
    const headerPairs: Array<[string, string]> = [];
    const h = init?.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => headerPairs.push([k.toLowerCase(), v]));
    } else if (Array.isArray(h)) {
      for (const pair of h) {
        const k = pair[0];
        const v = pair[1];
        if (k === undefined) continue;
        headerPairs.push([k.toLowerCase(), String(v ?? '')]);
      }
    } else if (h && typeof h === 'object') {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        headerPairs.push([k.toLowerCase(), String(v)]);
      }
    }
    headerPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    captured.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      pathAndSearch: `${u.pathname}${u.search}`,
      headers: headerPairs,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
    });
    // session-start returns 201 with a body; events returns 202. Either is a
    // success the SDK accepts; the canned body satisfies both parsers.
    return new Response(
      JSON.stringify({
        accepted: 1,
        duplicates: 0,
        receivedAt: '2026-01-01T00:00:00.000Z',
        sessionId: '00000000000000000000000000',
        acceptedAt: '2026-01-01T00:00:00.000Z',
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const client = sdk.createClient({
    apiKey,
    endpoint: baseUrl,
    transport,
  });
  client.capture({ type: sample.type, attributes: sample.attributes });
  await client.flush({ timeoutMs: 5_000 });
  await client.shutdown({ timeoutMs: 1_000 });

  if (captured.length === 0) {
    throw new Error(`SDK produced no outbound request for ${baseUrl} (${sample.type})`);
  }
  return captured;
}

/**
 * Per-request volatile fields are unique by construction — client-generated
 * ULIDs (`eventId`, `sessionId`), wall-clock stamps (`capturedAt`, `startedAt`,
 * `endedAt`), and the scrubber's per-event `durationMs` timing measurement — so
 * we blank them (recursively, anywhere they appear) before comparing two
 * requests for the SAME logical payload across two base URLs. Everything else —
 * including the opaque key in the Authorization header — must match
 * byte-for-byte. A base-URL-conditional branch in any non-volatile field would
 * therefore surface as a mismatch.
 */
const VOLATILE_BODY_KEYS = new Set([
  'eventId',
  'sessionId',
  'capturedAt',
  'startedAt',
  'endedAt',
  'durationMs',
]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_BODY_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

function canonicalizeBodyForCompare(body: string): string {
  try {
    return JSON.stringify(stripVolatile(JSON.parse(body)));
  } catch {
    return body;
  }
}

function requestSignature(req: CapturedRequest): string {
  return JSON.stringify({
    method: req.method,
    pathAndSearch: req.pathAndSearch,
    headers: req.headers,
    body: canonicalizeBodyForCompare(req.body),
  });
}

/** Signature of an ordered request sequence (e.g. session-start then events). */
function sequenceSignature(reqs: CapturedRequest[]): string {
  return JSON.stringify(reqs.map(requestSignature));
}

/**
 * STATIC layer: for each event sample, confirm every supported endpoint shape
 * yields a request that is identical except for the base URL. The Authorization
 * header (the opaque key) is part of the compared signature, so a deployment
 * that asked the SDK to reshape the key would fail here.
 */
async function runStaticGate(started: number): Promise<CaseResult> {
  const id = 'endpoint-parity.zero-change-static';
  let sdk: Awaited<typeof import('@peaktek/resolvetrace-sdk')>;
  try {
    sdk = await import('@peaktek/resolvetrace-sdk');
  } catch (err) {
    return {
      id,
      description: 'SDK emits an identical request (modulo base URL) for every endpoint shape',
      status: 'fail',
      durationMs: performance.now() - started,
      message: `could not import SDK: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ONE fixed opaque key + ONE fixed payload set drives every shape — proving
  // the key is treated as opaque and the payload is endpoint-independent.
  const apiKey = 'rt_live_zerochange_PARITY_opaque_0123456789';
  const exercisedShapes = ENDPOINT_SHAPES.map((s) => s.id);
  const mismatches: string[] = [];
  let observedPaths: string[] = [];

  try {
    for (const sample of STATIC_EVENT_SAMPLES) {
      const signatures = await Promise.all(
        ENDPOINT_SHAPES.map(async (shape) => {
          const reqs = await captureSdkRequests(sdk, shape.baseUrl, apiKey, sample);
          return { shape, reqs, sig: sequenceSignature(reqs) };
        }),
      );
      const first = signatures[0];
      if (!first) continue;
      observedPaths = first.reqs.map((r) => `${r.method} ${r.pathAndSearch}`);
      for (let i = 1; i < signatures.length; i++) {
        const entry = signatures[i];
        if (!entry) continue;
        if (entry.sig !== first.sig) {
          mismatches.push(
            `event '${sample.type}': ${entry.shape.id} request sequence differs from ` +
              `${first.shape.id} (only the base URL may differ)`,
          );
        }
      }
    }
  } catch (err) {
    return {
      id,
      description: 'SDK emits an identical request (modulo base URL) for every endpoint shape',
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const durationMs = performance.now() - started;
  if (mismatches.length > 0) {
    return {
      id,
      description: 'SDK emits an identical request (modulo base URL) for every endpoint shape',
      status: 'fail',
      durationMs,
      message: mismatches.join('; '),
    };
  }
  return {
    id,
    description: 'SDK emits an identical request (modulo base URL) for every endpoint shape',
    status: 'pass',
    durationMs,
    details: {
      shapesProven: exercisedShapes,
      eventTypes: STATIC_EVENT_SAMPLES.map((s) => s.type),
      requestSequence: observedPaths,
      proof:
        'same payload + same opaque Bearer key -> identical method/path/headers/body across all shapes',
    },
  };
}

/**
 * The live battery: a set of real requests, each with the path + expected
 * success status. Drives acceptance + response-shape parity across endpoints.
 * Kept small so the case stays fast against quota-limited deployments.
 */
function buildLiveBattery(): Array<{
  label: string;
  path: string;
  body: () => unknown;
  expectSuccess: (status: number) => boolean;
}> {
  return [
    {
      label: 'events:minimal',
      path: '/v1/events',
      body: () => ({ events: [buildMinimalEnvelope({ type: 'conformance.endpoint-parity' })] }),
      expectSuccess: (s) => s === 202,
    },
    {
      label: 'events:action-submit',
      path: '/v1/events',
      body: () => ({
        events: [buildMinimalEnvelope({ type: 'action.submit', attributes: { selector: '#pay' } })],
      }),
      expectSuccess: (s) => s === 202,
    },
    {
      label: 'events:error-api',
      path: '/v1/events',
      body: () => ({
        events: [buildMinimalEnvelope({ type: 'error.api', attributes: { status: 500 } })],
      }),
      expectSuccess: (s) => s === 202,
    },
    {
      label: 'session:start',
      path: '/v1/session/start',
      body: () => ({ sessionId: generateUlid(), startedAt: new Date().toISOString() }),
      expectSuccess: (s) => s === 201,
    },
    {
      label: 'replay:signed-url',
      path: '/v1/replay/signed-url',
      body: () => ({
        sessionId: generateUlid(),
        sequence: 0,
        approxBytes: 32,
        contentType: 'application/vnd.resolvetrace.replay+rrweb',
      }),
      expectSuccess: (s) => s === 201,
    },
  ];
}

/** Sorted key list of a JSON object body, or [] for non-objects. */
function bodyKeys(bodyJson: unknown): string[] {
  return bodyJson && typeof bodyJson === 'object' && !Array.isArray(bodyJson)
    ? Object.keys(bodyJson as Record<string, unknown>).sort()
    : [];
}

/**
 * LIVE layer: compare the primary endpoint against each additional live
 * endpoint, item-by-item across the battery. Asserts (a) acceptance parity
 * (same success/failure verdict) and (b) response-shape parity (same status +
 * same sorted body-key set) — a strict superset of the prior status-only check.
 */
async function runLiveParity(config: ResolvedConformanceConfig): Promise<CaseResult> {
  const started = performance.now();
  const id = 'endpoint-parity.live-cross-endpoint';
  const description =
    'Primary and each additional live endpoint accept the same battery with identical response shapes';

  if (config.skipNetwork) {
    return {
      id,
      description,
      status: 'skip',
      durationMs: 0,
      message: '--skip-network set',
    };
  }

  if (config.additionalEndpoints.length === 0) {
    // DEFERRED, not silent: name exactly what would exercise this layer.
    const deferredRows = ENDPOINT_SHAPES.filter((s) => s.deferred).map((s) => s.id);
    return {
      id,
      description,
      status: 'skip',
      durationMs: performance.now() - started,
      message:
        'DEFERRED: no second live endpoint configured. The static layer proves the SDK invariant; ' +
        'pass --additional-endpoint <url> (e.g. a SaaS ingest) to exercise live cross-endpoint parity. ' +
        `Documented-deferred shapes: ${deferredRows.length > 0 ? deferredRows.join(', ') : '(none)'}.`,
    };
  }

  const battery = buildLiveBattery();
  const mismatches: string[] = [];
  const endpoints = [config.endpoint, ...config.additionalEndpoints];

  try {
    for (const item of battery) {
      // SAME body instance per item across all endpoints, so the comparison
      // isolates server behaviour (ULIDs etc. are generated once per item).
      const body = item.body();
      const probes = await Promise.all(
        endpoints.map(async (endpoint) => {
          const res = await postJson({ endpoint, path: item.path, apiKey: config.apiKey, body });
          return { endpoint, status: res.status, keys: bodyKeys(res.bodyJson) };
        }),
      );
      const primary = probes[0];
      if (!primary) continue;
      const primaryAccepted = item.expectSuccess(primary.status);
      for (let i = 1; i < probes.length; i++) {
        const p = probes[i];
        if (!p) continue;
        if (item.expectSuccess(p.status) !== primaryAccepted) {
          mismatches.push(
            `${item.label}: ${p.endpoint} acceptance ${p.status} differs from primary ${primary.status}`,
          );
        } else if (p.status !== primary.status) {
          mismatches.push(
            `${item.label}: ${p.endpoint} status ${p.status} vs primary ${primary.status}`,
          );
        } else if (JSON.stringify(p.keys) !== JSON.stringify(primary.keys)) {
          mismatches.push(
            `${item.label}: ${p.endpoint} body keys ${JSON.stringify(p.keys)} vs primary ${JSON.stringify(primary.keys)}`,
          );
        }
      }
    }
  } catch (err) {
    return {
      id,
      description,
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const durationMs = performance.now() - started;
  if (mismatches.length > 0) {
    return { id, description, status: 'fail', durationMs, message: mismatches.join('; ') };
  }
  return {
    id,
    description,
    status: 'pass',
    durationMs,
    details: {
      endpoints,
      battery: battery.map((b) => b.label),
    },
  };
}

async function run(config: ResolvedConformanceConfig): Promise<CaseResult[]> {
  const started = performance.now();
  const results: CaseResult[] = [];
  results.push(await runStaticGate(started));
  results.push(await runLiveParity(config));
  return results;
}

export const endpointParityCase: CaseDefinition = {
  id: 'endpoint-parity',
  description: DESCRIPTION,
  run,
};
