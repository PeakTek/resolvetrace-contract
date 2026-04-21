/**
 * Session lifecycle schemas — `POST /v1/session/start` and
 * `POST /v1/session/end`.
 *
 * Sessions group events and replay chunks under a common `sessionId` (ULID,
 * generated client-side). `/start` opens a session and is called once per
 * session. `/end` closes the session and signals that no further events or
 * replay chunks will be sent under this `sessionId`.
 */

import { Type, Static } from '@sinclair/typebox';
import { ULID_PATTERN } from './events.js';

/* -------------------------------------------------------------------------- */
/* Module metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Module-level metadata consumed by `scripts/build-schemas.ts` — lands as
 * top-level `title` / `description` on the emitted `schemas/session.json`.
 */
export const MODULE_META = {
  title: 'ResolveTrace session lifecycle',
  description:
    'Wire-format schemas for session start and end requests and responses.',
} as const;

/* -------------------------------------------------------------------------- */
/* Local primitive schemas (module-private; see schemas/README.md)            */
/* -------------------------------------------------------------------------- */

/**
 * Local ULID primitive. Kept in sync with `events.ts`'s `Ulid` via the shared
 * `ULID_PATTERN` string. The emitter inlines this schema at every use-site,
 * so each module's JSON is self-contained with no cross-module `$ref`s.
 */
const Ulid = Type.String({
  format: 'ulid',
  pattern: ULID_PATTERN,
  description:
    'ULID (Crockford base32, 26 chars). Generated client-side by the SDK at capture time and preserved across retries.',
});

/** Local ISO-8601 timestamp primitive. See the note on `Ulid` above. */
const IsoDateTime = Type.String({
  format: 'date-time',
  description: 'ISO-8601 / RFC 3339 timestamp (UTC recommended).',
});

/* -------------------------------------------------------------------------- */
/* Session metadata (non-PII)                                                 */
/* -------------------------------------------------------------------------- */

export const SessionViewport = Type.Object(
  {
    width: Type.Integer({ minimum: 0, maximum: 20000 }),
    height: Type.Integer({ minimum: 0, maximum: 20000 }),
    devicePixelRatio: Type.Optional(
      Type.Number({ minimum: 0, maximum: 16 }),
    ),
  },
  { additionalProperties: false },
);

export const SessionClient = Type.Object(
  {
    userAgent: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        description: 'Client User-Agent string as reported by the host environment.',
      }),
    ),
    locale: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 35,
        description: 'BCP 47 locale tag (e.g. "en-CA", "fr-FR").',
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: 'IANA timezone identifier (e.g. "America/Toronto"). Optional.',
      }),
    ),
    viewport: Type.Optional(SessionViewport),
  },
  {
    additionalProperties: false,
    description:
      'Non-PII client environment metadata attached to the session for analytics.',
  },
);
export type SessionClient = Static<typeof SessionClient>;

/* -------------------------------------------------------------------------- */
/* Session start                                                              */
/* -------------------------------------------------------------------------- */

export const ReleaseChannel = Type.Union(
  [
    Type.Literal('production'),
    Type.Literal('staging'),
    Type.Literal('development'),
    Type.Literal('canary'),
  ],
  {
    description:
      'Customer-reported release channel. The authoritative environment is derived from the API key, not this field.',
  },
);

export const SessionStartRequest = Type.Object(
  {
    sessionId: Ulid,
    startedAt: Type.String({
      format: 'date-time',
      description: 'Client wall-clock at session start.',
    }),
    appVersion: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: 'Customer-reported application version (free-form string).',
      }),
    ),
    releaseChannel: Type.Optional(ReleaseChannel),
    client: Type.Optional(SessionClient),
    userAnonId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          'Customer-provided anonymous user identifier. Opaque to the server; MUST NOT be a PII value.',
      }),
    ),
  },
  {
    additionalProperties: false,
    title: 'SessionStartRequest',
    description: 'Request body for `POST /v1/session/start`.',
  },
);
export type SessionStartRequest = Static<typeof SessionStartRequest>;

export const SessionStartResponse = Type.Object(
  {
    sessionId: Ulid,
    acceptedAt: IsoDateTime,
  },
  {
    additionalProperties: false,
    title: 'SessionStartResponse',
    description: 'Response body for `POST /v1/session/start` (HTTP 201).',
  },
);
export type SessionStartResponse = Static<typeof SessionStartResponse>;

/* -------------------------------------------------------------------------- */
/* Session end                                                                */
/* -------------------------------------------------------------------------- */

export const SessionEndReason = Type.Union(
  [
    Type.Literal('closed'),
    Type.Literal('visibility_hidden'),
    Type.Literal('beforeunload'),
    Type.Literal('timeout'),
    Type.Literal('shutdown'),
    Type.Literal('error'),
  ],
  {
    description:
      'Why the session ended. Informational; does not change server processing.',
  },
);

export const SessionEndRequest = Type.Object(
  {
    sessionId: Ulid,
    endedAt: Type.String({
      format: 'date-time',
      description: 'Client wall-clock at session end.',
    }),
    reason: SessionEndReason,
    eventCount: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Client-side count of events captured in this session. Used for reconciliation diagnostics.',
      }),
    ),
    replayChunkCount: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Client-side count of replay chunks uploaded in this session.',
      }),
    ),
  },
  {
    additionalProperties: false,
    title: 'SessionEndRequest',
    description: 'Request body for `POST /v1/session/end`.',
  },
);
export type SessionEndRequest = Static<typeof SessionEndRequest>;

export const SessionEndResponse = Type.Object(
  {
    sessionId: Ulid,
    acceptedAt: IsoDateTime,
  },
  {
    additionalProperties: false,
    title: 'SessionEndResponse',
    description: 'Response body for `POST /v1/session/end` (HTTP 200).',
  },
);
export type SessionEndResponse = Static<typeof SessionEndResponse>;
