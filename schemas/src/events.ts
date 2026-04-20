/**
 * Event envelope schema — payload shape sent to `POST /v1/events`.
 *
 * Each request to the events endpoint is a batch: an array of event envelopes
 * wrapped in an outer object. The envelope carries the core event identity,
 * the captured payload, the client-side scrubber report, and optional
 * clock-skew and session correlation fields.
 *
 * See `../../api-spec/openapi.yaml` for the endpoint contract and
 * `./api-responses.ts` for rate-limit and error response shapes.
 */

import { Type, Static } from '@sinclair/typebox';

/* -------------------------------------------------------------------------- */
/* Module metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Module-level metadata consumed by `scripts/build-schemas.ts` — lands as
 * top-level `title` / `description` on the emitted `schemas/events.json`.
 */
export const MODULE_META = {
  title: 'ResolveTrace event envelope and batch',
  description:
    'Wire-format schemas for events sent to POST /v1/events, including the per-event envelope and batch request shape.',
} as const;

/* -------------------------------------------------------------------------- */
/* Primitive field factories                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ULID (Crockford base32, 26 chars). Generated client-side by the SDK at
 * capture time and preserved across retries.
 */
export const Ulid = () =>
  Type.String({
    format: 'ulid',
    pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
    description:
      'ULID (Crockford base32, 26 chars). Generated client-side by the SDK at capture time and preserved across retries.',
  });

/** ISO-8601 / RFC 3339 timestamp (UTC recommended). */
export const IsoDateTime = () =>
  Type.String({
    format: 'date-time',
    description: 'ISO-8601 / RFC 3339 timestamp (UTC recommended).',
  });

/* -------------------------------------------------------------------------- */
/* Scrubber report                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Client-side scrubber report, stamped on every outbound envelope. Allows the
 * backend to decide whether to re-apply any deterministic ruleset before
 * durable write.
 */
export const ScrubberReport = Type.Object(
  {
    version: Type.String({
      minLength: 1,
      maxLength: 64,
      description: 'SDK scrubber version string (e.g. "sdk@1.4.2").',
    }),
    rulesDigest: Type.String({
      pattern: '^sha256:[a-f0-9]{64}$',
      description: 'Hex-encoded SHA-256 of the scrubber ruleset applied.',
    }),
    applied: Type.Array(
      Type.String({ minLength: 1, maxLength: 128 }),
      {
        description:
          'List of rule identifiers the SDK applied (e.g. ["regex:email", "attr:data-rt-mask"]).',
        maxItems: 64,
      },
    ),
    budgetExceeded: Type.Boolean({
      description:
        'True when the SDK hit the per-event scrub budget and fell back to the overflow policy.',
    }),
    durationMs: Type.Optional(
      Type.Number({
        minimum: 0,
        description: 'Observed scrub duration in milliseconds.',
      }),
    ),
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/scrubber-report.json',
    additionalProperties: false,
    description: 'Client-side scrubber application report.',
  },
);
export type ScrubberReport = Static<typeof ScrubberReport>;

/* -------------------------------------------------------------------------- */
/* Event types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Event `type` is an open string (not a closed enum) so customers can emit
 * product-specific event names via `track()`. A small set of reserved names
 * is documented, but any non-empty string matching the pattern is accepted.
 */
export const EventType = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-zA-Z0-9_.\\-:/]+$',
  description:
    'Dot- or slash-separated event type identifier (e.g. "page_view", "dom.click", "app.checkout.completed").',
});

/**
 * Free-form attribute bag. Values are JSON scalars, arrays of scalars, or
 * nested objects of the same. Individual string fields are capped server-side
 * at 64 KiB; whole-event payload is capped at 256 KiB post-scrub.
 */
export const EventAttributes = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Unknown(),
  {
    description: 'Customer-provided attribute bag. Keys are camelCase strings.',
  },
);

/* -------------------------------------------------------------------------- */
/* SDK identity                                                               */
/* -------------------------------------------------------------------------- */

export const SdkIdentity = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      description: 'SDK package identifier (e.g. "@peaktek/resolvetrace-sdk").',
    }),
    version: Type.String({
      minLength: 1,
      maxLength: 32,
      description: 'SDK semver, e.g. "0.1.0".',
    }),
    runtime: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          'Free-form runtime identifier (e.g. "browser", "node-20", "python-3.12").',
      }),
    ),
  },
  {
    additionalProperties: false,
    description: 'SDK identity stamped on every envelope.',
  },
);
export type SdkIdentity = Static<typeof SdkIdentity>;

/* -------------------------------------------------------------------------- */
/* Event envelope                                                             */
/* -------------------------------------------------------------------------- */

export const EventEnvelope = Type.Object(
  {
    eventId: Ulid(),
    sessionId: Type.Optional(
      Type.String({
        format: 'ulid',
        pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
        description:
          'Optional session correlation ULID. Required on events that belong to a replay session.',
      }),
    ),
    type: EventType,
    capturedAt: Type.String({
      format: 'date-time',
      description:
        'Client wall-clock at capture time. The server preserves this and also records its own receive time.',
    }),
    attributes: Type.Optional(EventAttributes),
    scrubber: ScrubberReport,
    clockSkewDetected: Type.Optional(
      Type.Boolean({
        description:
          'Set by the server when the client timestamp is outside the accepted skew window. Clients should not set this.',
      }),
    ),
    sdk: SdkIdentity,
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/event-envelope.json',
    additionalProperties: false,
    title: 'EventEnvelope',
    description:
      'A single event envelope. Enclosed in the `events` array of a batch request body.',
  },
);
export type EventEnvelope = Static<typeof EventEnvelope>;

/* -------------------------------------------------------------------------- */
/* Batch request + response                                                   */
/* -------------------------------------------------------------------------- */

export const EventBatchRequest = Type.Object(
  {
    events: Type.Array(EventEnvelope, {
      minItems: 1,
      maxItems: 100,
      description:
        'Batch of event envelopes. Max 100 envelopes and 512 KiB uncompressed per batch.',
    }),
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/event-batch-request.json',
    additionalProperties: false,
    title: 'EventBatchRequest',
    description: 'Request body for `POST /v1/events`.',
  },
);
export type EventBatchRequest = Static<typeof EventBatchRequest>;

export const EventBatchAcceptedResponse = Type.Object(
  {
    accepted: Type.Integer({
      minimum: 0,
      description: 'Number of events accepted for processing.',
    }),
    duplicates: Type.Integer({
      minimum: 0,
      description:
        'Number of events matched in the idempotency window and processed as no-ops.',
    }),
    receivedAt: IsoDateTime(),
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/event-batch-accepted-response.json',
    additionalProperties: false,
    title: 'EventBatchAcceptedResponse',
    description: 'Success response body for `POST /v1/events` (HTTP 202).',
  },
);
export type EventBatchAcceptedResponse = Static<typeof EventBatchAcceptedResponse>;
