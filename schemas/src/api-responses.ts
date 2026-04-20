/**
 * Standard API response shapes shared across all ingest endpoints.
 *
 * These schemas cover:
 *   - the canonical error envelope returned on 4xx and 5xx responses
 *   - the 429 rate-limit response body
 *   - the 503 service-unavailable shed response body
 *   - the standard rate-limit response headers
 *
 * All ingest endpoints return bodies conforming to one of these shapes for
 * non-2xx responses. Clients SHOULD key retry / backoff logic on `Retry-After`
 * and the `X-RateLimit-*` headers rather than parsing the body.
 */

import { Type, Static } from '@sinclair/typebox';

/* -------------------------------------------------------------------------- */
/* Module metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Module-level metadata consumed by `scripts/build-schemas.ts` — lands as
 * top-level `title` / `description` on the emitted `schemas/api-responses.json`.
 */
export const MODULE_META = {
  title: 'ResolveTrace standard API responses',
  description:
    'Shared error and rate-limit response envelopes returned across the ingest surface, including the 429 Too Many Requests body shape.',
} as const;

/* -------------------------------------------------------------------------- */
/* Shared error codes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `error` is an open string (machine-readable identifier). A non-exhaustive
 * list of the values clients should expect to see:
 *
 *   - `invalid_request`       — 400; body failed schema validation
 *   - `invalid_event_id`      — 400; `eventId` not a valid ULID
 *   - `clock_skew_out_of_window` — 400; client timestamp >±24h from server
 *   - `payload_too_large`     — 413; request exceeded a size cap
 *   - `unauthenticated`       — 401; missing / malformed Authorization
 *   - `invalid_api_key`       — 401; API key signature / expiry invalid
 *   - `forbidden`             — 403; key lacks required scope for this path
 *   - `session_not_found`     — 403 / 404; cross-tenant or unknown session
 *   - `rate_limit_exceeded`   — 429; per-tenant throttle
 *   - `service_unavailable_shed` — 503; global backpressure shed
 *   - `stage1_precondition_failed` — 409; replay chunk contained
 *                                   budget-exceeded events
 *   - `integrity_check_failed`  — 409; replay chunk checksum mismatch
 *   - `internal_error`        — 500; generic server error
 */
export const ErrorCode = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9_]*$',
  description: 'Machine-readable error identifier (snake_case).',
});

/* -------------------------------------------------------------------------- */
/* Standard error envelope                                                    */
/* -------------------------------------------------------------------------- */

export const ErrorResponse = Type.Object(
  {
    error: ErrorCode,
    message: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        description: 'Human-readable message. Never contains tenant-identifying data.',
      }),
    ),
    requestId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          'Per-request correlation identifier, echoed from the `X-Request-ID` response header. Include this when contacting support.',
      }),
    ),
    details: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: 64 }),
        Type.Unknown(),
        {
          description:
            'Optional structured details. Shape depends on `error`; consult endpoint docs.',
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    title: 'ErrorResponse',
    description:
      'Canonical error envelope returned by every ingest endpoint on non-2xx responses, unless a more specific schema is documented (e.g. 429).',
  },
);
export type ErrorResponse = Static<typeof ErrorResponse>;

/* -------------------------------------------------------------------------- */
/* Rate-limit exceeded (429)                                                  */
/* -------------------------------------------------------------------------- */

export const RateLimitClass = Type.Union(
  [
    Type.Literal('events'),
    Type.Literal('replay_signed_url'),
    Type.Literal('replay_complete'),
    Type.Literal('session'),
  ],
  { description: 'Which ingest request class tripped the limit.' },
);

export const RateLimitDimension = Type.Union(
  [
    Type.Literal('requests'),
    Type.Literal('events'),
    Type.Literal('bytes'),
  ],
  {
    description:
      'Which dimension of the class was exceeded — request count, event count, or payload bytes.',
  },
);

export const RateLimitScope = Type.Union(
  [Type.Literal('tenant'), Type.Literal('global')],
  {
    description:
      '`tenant` for 429 (per-tenant bucket); `global` for 503 (fleet-wide shed).',
  },
);

export const RateLimitErrorResponse = Type.Object(
  {
    error: Type.Union(
      [
        Type.Literal('rate_limit_exceeded'),
        Type.Literal('service_unavailable_shed'),
      ],
      { description: 'Rate-limit error identifier.' },
    ),
    retryAfterSeconds: Type.Integer({
      minimum: 0,
      maximum: 3600,
      description:
        'Integer seconds until the next request is expected to succeed. Mirrors the `Retry-After` header.',
    }),
    class: RateLimitClass,
    dimension: Type.Optional(RateLimitDimension),
    scope: RateLimitScope,
    requestId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128 }),
    ),
  },
  {
    additionalProperties: false,
    title: 'RateLimitErrorResponse',
    description:
      'Response body returned on HTTP 429 (per-tenant throttle) and HTTP 503 (global shed). Clients should honour the `Retry-After` header and back off with jitter.',
  },
);
export type RateLimitErrorResponse = Static<typeof RateLimitErrorResponse>;

/* -------------------------------------------------------------------------- */
/* Rate-limit headers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The following response headers are emitted by all ingest endpoints. They
 * are not part of the JSON body schema but are specified here as a typed
 * contract so SDK harnesses and OpenAPI tooling can reference a single source.
 */
export const RateLimitHeaders = Type.Object(
  {
    'Retry-After': Type.String({
      pattern: '^\\d+$',
      description: 'Integer seconds until the next request is expected to succeed.',
    }),
    'X-RateLimit-Limit': Type.String({
      pattern: '^\\d+$',
      description: 'Soft limit for the class/dimension that tripped.',
    }),
    'X-RateLimit-Remaining': Type.String({
      pattern: '^\\d+$',
      description: 'Remaining tokens in the current window (0 on 429).',
    }),
    'X-RateLimit-Reset': Type.String({
      pattern: '^\\d+$',
      description: 'Unix epoch seconds at which the next token is guaranteed available.',
    }),
  },
  {
    additionalProperties: true,
    title: 'RateLimitHeaders',
    description:
      'Standard rate-limit response headers emitted on every 429 response (and alongside 200 responses when a tenant is approaching its limit).',
  },
);
export type RateLimitHeaders = Static<typeof RateLimitHeaders>;
