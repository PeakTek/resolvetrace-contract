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
/* Shared primitive patterns                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Crockford base32 (26 chars, excluding I/L/O/U). Shared as a plain string so
 * each module that inlines a `Ulid`-shaped primitive stays in sync without
 * importing schema values across modules (which would cause the build emitter
 * to inline duplicate sub-schemas).
 */
export const ULID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';

/**
 * Current major version of the shared event schema. Producers stamp this on
 * every envelope (`schemaVersion`); consumers reject unsupported majors.
 * Additive changes stay within a major; a breaking change increments it.
 */
export const SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Primitive field schemas                                                    */
/* -------------------------------------------------------------------------- */

/**
 * ULID (Crockford base32, 26 chars). Generated client-side by the SDK at
 * capture time and preserved across retries.
 */
export const Ulid = Type.String({
  format: 'ulid',
  pattern: ULID_PATTERN,
  description:
    'ULID (Crockford base32, 26 chars). Generated client-side by the SDK at capture time and preserved across retries.',
});

/** ISO-8601 / RFC 3339 timestamp (UTC recommended). */
export const IsoDateTime = Type.String({
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
    additionalProperties: false,
    description: 'Client-side scrubber application report.',
  },
);
export type ScrubberReport = Static<typeof ScrubberReport>;

/* -------------------------------------------------------------------------- */
/* Event types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Canonical event vocabulary. These 14 names have a defined semantic meaning
 * and a stable shape across producers and consumers; capture features emit
 * against them so analytics, frustration signals, and support codes line up.
 *
 * The leading namespaces (`view.`, `action.`, `error.`, `perf.`, `ux.`,
 * `support.`) are RESERVED — a name in one of these namespaces that is not one
 * of these literals is rejected (see `CustomEventType`), so a product event
 * cannot shadow a canonical type with a divergent shape.
 */
export const KNOWN_EVENT_TYPES = [
  'view.start',
  'view.end',
  'action.click',
  'action.submit',
  'action.navigation',
  'error.js',
  'error.api',
  'error.resource',
  'perf.api_latency',
  'perf.long_task',
  'ux.dead_click',
  'ux.rage_click',
  'ux.repeated_submit',
  'support.report_submitted',
] as const;

/**
 * Reserved canonical namespaces. A custom (non-canonical) event name beginning
 * with any of these prefixes is rejected by `CustomEventType` so the canonical
 * vocabulary cannot be shadowed.
 */
export const RESERVED_EVENT_NAMESPACES = [
  'view.',
  'action.',
  'error.',
  'perf.',
  'ux.',
  'support.',
] as const;

/**
 * Union of the 14 canonical event-type literals. Producers SHOULD emit one of
 * these names for any interaction, error, performance, UX-signal, or support
 * event so downstream consumers can rely on a stable shape.
 */
export const KnownEventType = Type.Union(
  KNOWN_EVENT_TYPES.map((name) => Type.Literal(name)),
  {
    description:
      'Canonical event type. One of the 14 reserved names with defined semantics across producers and consumers.',
  },
);
export type KnownEventType = Static<typeof KnownEventType>;

/**
 * Customer-defined ("custom") event name. Retains the historical open pattern
 * — any non-empty dot/slash-separated identifier — EXCEPT names in a reserved
 * canonical namespace (`view. action. error. perf. ux. support.`), which are
 * excluded via a leading negative lookahead so customers cannot register a
 * divergent shape under a canonical prefix.
 *
 * Exported as its own definition for consumers that want to reason about the
 * custom-vs-canonical split directly; the on-wire `EventType` accepts the
 * canonical literals OR this custom form (see `EVENT_TYPE_PATTERN`).
 */
export const CustomEventType = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern:
    '^(?!(?:view|action|error|perf|ux|support)\\.)[a-zA-Z0-9_.\\-:/]+$',
  description:
    'Customer-defined event type. Same open form as before, but the canonical namespaces (view. action. error. perf. ux. support.) are reserved and rejected here.',
});
export type CustomEventType = Static<typeof CustomEventType>;

/**
 * Single regex encoding the open-vocabulary-with-reserved-core rule, so the
 * on-wire `type` stays a plain `string` (additive: only a `pattern` is added
 * to the pre-existing string field — not a type/shape change). A value matches
 * iff it is one of the 14 canonical literals OR a name that does not begin with
 * a reserved canonical namespace prefix.
 *
 *   ^(?: <canonical-literal-alternation>
 *        | (?!(?:view|action|error|perf|ux|support)\.) [allowed-chars]+
 *      )$
 */
const ESCAPED_KNOWN = KNOWN_EVENT_TYPES.map((n) =>
  n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('|');
export const EVENT_TYPE_PATTERN =
  `^(?:(?:${ESCAPED_KNOWN})` +
  `|(?!(?:view|action|error|perf|ux|support)\\.)[a-zA-Z0-9_.\\-:/]+)$`;

/**
 * Event `type` — an open vocabulary with a reserved canonical core. A value is
 * valid if it is one of the 14 canonical names (`KnownEventType`) OR a custom
 * name outside the reserved namespaces (`CustomEventType`). Everything that
 * validated before this taxonomy landed still validates; only NEW custom names
 * that try to shadow a canonical namespace are now rejected.
 *
 * Kept as a `string` (not a union) on the wire so the change is purely additive
 * over the prior open-string `type` — the canonical core is enforced through
 * the pattern. `KnownEventType` is exported separately for type-safe producers.
 */
export const EventType = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: EVENT_TYPE_PATTERN,
  title: 'EventType',
  description:
    'Dot- or slash-separated event type identifier. Open vocabulary with a reserved canonical core (e.g. "view.start", "action.click", or a custom "app.checkout.completed").',
});
export type EventType = Static<typeof EventType>;

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
/* Actor — caller-supplied identity decoration                                */
/* -------------------------------------------------------------------------- */

export const Actor = Type.Object(
  {
    userId: Type.String({
      minLength: 1,
      maxLength: 128,
      description:
        'Caller-provided opaque user identifier. Set by client.identify(...). Opaque to the server; MUST NOT be a PII value.',
    }),
    traits: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: 128 }),
        Type.Unknown(),
        {
          description: 'Free-form trait bag attached by client.identify(...).',
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    description: 'Caller-supplied identity decoration.',
  },
);
export type Actor = Static<typeof Actor>;

/* -------------------------------------------------------------------------- */
/* Global context                                                             */
/* -------------------------------------------------------------------------- */

/** Diagnostics collection level negotiated for the session / environment. */
export const DiagnosticsLevel = Type.Union(
  [
    Type.Literal('essential'),
    Type.Literal('standard'),
    Type.Literal('assisted_support'),
  ],
  {
    description:
      'Diagnostics collection level: essential | standard | assisted_support.',
  },
);
export type DiagnosticsLevel = Static<typeof DiagnosticsLevel>;

/**
 * Shared per-event global context (doc: canonical `global_context`). Carries
 * the release/locale/market/diagnostics fields every canonical event should
 * be attributable to, plus optional route/component/browser/device/network
 * descriptors. Optional on the envelope for backward compatibility; when
 * present, the four core fields are required so a populated context is always
 * attributable. camelCase wire form.
 *
 * `supportCode` is shape-only here (so `support.report_submitted` / `view.start`
 * can carry it); generation and lookup of support codes live in a later wave.
 */
export const EventContext = Type.Object(
  {
    releaseVersion: Type.String({
      minLength: 1,
      maxLength: 256,
      description: 'Producer release / build version (e.g. "web@2026.06.1").',
    }),
    locale: Type.String({
      minLength: 1,
      maxLength: 64,
      description: 'BCP-47 locale of the session (e.g. "en-CA").',
    }),
    market: Type.String({
      minLength: 1,
      maxLength: 64,
      description: 'Business market / region the session belongs to.',
    }),
    diagnosticsLevel: DiagnosticsLevel,
    routeName: Type.Optional(
      Type.String({
        maxLength: 256,
        description: 'Logical route / screen name (not the raw URL).',
      }),
    ),
    routeType: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'Route classification (e.g. "page", "modal", "tab").',
      }),
    ),
    componentId: Type.Optional(
      Type.String({ maxLength: 256, description: 'Stable component identifier.' }),
    ),
    componentType: Type.Optional(
      Type.String({ maxLength: 128, description: 'Component classification.' }),
    ),
    browserFamily: Type.Optional(
      Type.String({ maxLength: 64, description: 'Browser family (e.g. "Chrome").' }),
    ),
    browserVersion: Type.Optional(
      Type.String({ maxLength: 64, description: 'Browser version string.' }),
    ),
    osFamily: Type.Optional(
      Type.String({ maxLength: 64, description: 'OS family (e.g. "macOS").' }),
    ),
    deviceType: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'Device classification (e.g. "desktop", "mobile").',
      }),
    ),
    viewportWidth: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Viewport width in CSS pixels.' }),
    ),
    viewportHeight: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Viewport height in CSS pixels.' }),
    ),
    featureFlags: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: 128 }),
        Type.Unknown(),
        { description: 'Active feature-flag map at capture time.' },
      ),
    ),
    experimentVariant: Type.Optional(
      Type.String({
        maxLength: 128,
        description: 'Active experiment variant identifier.',
      }),
    ),
    networkState: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'Coarse network state (e.g. "online", "4g", "offline").',
      }),
    ),
    pageUrl: Type.Optional(
      Type.String({
        maxLength: 2048,
        description:
          'Current page URL. Not part of the abstract global_context vocabulary (which uses routeName/routeType); carried here as an explicit optional field for browser producers that capture the raw URL.',
      }),
    ),
    supportCode: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'Support code correlating user-visible reports to a session. Shape only — generation/lookup is handled in a later wave.',
      }),
    ),
  },
  {
    additionalProperties: false,
    title: 'EventContext',
    description:
      'Shared per-event global context. Optional on the envelope; when present, releaseVersion/locale/market/diagnosticsLevel are required.',
  },
);
export type EventContext = Static<typeof EventContext>;

/* -------------------------------------------------------------------------- */
/* Common optional event fields                                              */
/* -------------------------------------------------------------------------- */

/** Severity classification for an event. */
export const Severity = Type.Union(
  [Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')],
  { description: 'Event severity: info | warn | error.' },
);
export type Severity = Static<typeof Severity>;

/* -------------------------------------------------------------------------- */
/* Event envelope                                                             */
/* -------------------------------------------------------------------------- */

export const EventEnvelope = Type.Object(
  {
    schemaVersion: Type.Integer({
      minimum: 1,
      description:
        'Major version of the shared event schema this envelope conforms to. Producers stamp the current major (currently 1); consumers reject unsupported majors.',
    }),
    eventId: Ulid,
    sessionId: Type.Optional(
      Type.String({
        format: 'ulid',
        pattern: ULID_PATTERN,
        description:
          'Optional session correlation ULID. Required on events that belong to a replay session.',
      }),
    ),
    type: EventType,
    capturedAt: Type.String({
      format: 'date-time',
      description:
        'Client wall-clock at capture time (the canonical `occurred_at`). The server preserves this and also records its own receive time.',
    }),
    context: Type.Optional(EventContext),
    severity: Type.Optional(Severity),
    durationMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Duration in milliseconds for events that measure one (e.g. perf.api_latency, perf.long_task).',
      }),
    ),
    httpStatus: Type.Optional(
      Type.Integer({
        minimum: 100,
        maximum: 599,
        description: 'HTTP status code for API-oriented events (e.g. error.api).',
      }),
    ),
    attributes: Type.Optional(EventAttributes),
    scrubber: ScrubberReport,
    clockSkewDetected: Type.Optional(
      Type.Boolean({
        description:
          'Set by the server when the client timestamp is outside the accepted skew window. Clients should not set this.',
      }),
    ),
    sdk: SdkIdentity,
    actor: Type.Optional(Actor),
  },
  {
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
    receivedAt: IsoDateTime,
  },
  {
    additionalProperties: false,
    title: 'EventBatchAcceptedResponse',
    description: 'Success response body for `POST /v1/events` (HTTP 202).',
  },
);
export type EventBatchAcceptedResponse = Static<typeof EventBatchAcceptedResponse>;
