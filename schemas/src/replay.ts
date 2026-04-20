/**
 * Replay chunk upload schemas.
 *
 * Replay chunks are uploaded out-of-band via a short three-step flow:
 *   1. SDK posts `POST /v1/replay/signed-url` with chunk metadata and receives
 *      a short-lived presigned upload URL.
 *   2. SDK uploads the binary chunk directly to the signed URL.
 *   3. SDK posts `POST /v1/replay/complete` with a manifest entry declaring
 *      what was uploaded.
 *
 * This file defines the request/response shapes for steps 1 and 3. The raw
 * chunk body itself is an opaque binary blob and is not JSON-Schema-modelled.
 */

import { Type, Static } from '@sinclair/typebox';
import { Ulid, IsoDateTime, ScrubberReport } from './events';

/* -------------------------------------------------------------------------- */
/* Module metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Module-level metadata consumed by `scripts/build-schemas.ts` — lands as
 * top-level `title` / `description` on the emitted `schemas/replay.json`.
 */
export const MODULE_META = {
  title: 'ResolveTrace replay chunk upload flow',
  description:
    'Wire-format schemas for the two-step replay upload (POST /v1/replay/signed-url to obtain a pre-signed URL, POST /v1/replay/complete to finalize the chunk manifest).',
} as const;

const MAX_CHUNK_BYTES = 3 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Signed-URL request / response                                              */
/* -------------------------------------------------------------------------- */

export const ReplaySignedUrlRequest = Type.Object(
  {
    sessionId: Ulid(),
    sequence: Type.Integer({
      minimum: 0,
      description:
        'Monotonic chunk sequence number within the session, starting at 0. Uniqueness is per (session, sequence).',
    }),
    approxBytes: Type.Integer({
      minimum: 1,
      maximum: MAX_CHUNK_BYTES,
      description:
        'SDK estimate of chunk size, in bytes. Used to pre-validate against the chunk size ceiling.',
    }),
    contentType: Type.Literal('application/vnd.resolvetrace.replay+rrweb', {
      description: 'Content type of the chunk body. Must match the upload exactly.',
    }),
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/replay-signed-url-request.json',
    additionalProperties: false,
    title: 'ReplaySignedUrlRequest',
    description: 'Request body for `POST /v1/replay/signed-url`.',
  },
);
export type ReplaySignedUrlRequest = Static<typeof ReplaySignedUrlRequest>;

export const ReplaySignedUrlResponse = Type.Object(
  {
    uploadUrl: Type.String({
      format: 'uri',
      description: 'Short-lived presigned URL the SDK uploads the chunk to (HTTP PUT).',
    }),
    key: Type.String({
      minLength: 1,
      maxLength: 512,
      description: 'Canonical object key assigned to this chunk.',
    }),
    expiresAt: Type.String({
      format: 'date-time',
      description: 'RFC 3339 timestamp after which the signed URL is rejected.',
    }),
    maxBytes: Type.Integer({
      minimum: 1,
      maximum: MAX_CHUNK_BYTES,
      description:
        'Hard byte cap encoded into the signed URL. Uploads larger than this are rejected by the signature.',
    }),
    requiredHeaders: Type.Record(
      Type.String({ minLength: 1, maxLength: 64 }),
      Type.String({ minLength: 1, maxLength: 512 }),
      {
        description:
          'Headers the SDK must send with the PUT upload exactly as specified. Missing or altered values cause the upload to be rejected.',
      },
    ),
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/replay-signed-url-response.json',
    additionalProperties: false,
    title: 'ReplaySignedUrlResponse',
    description: 'Response body for `POST /v1/replay/signed-url` (HTTP 201).',
  },
);
export type ReplaySignedUrlResponse = Static<typeof ReplaySignedUrlResponse>;

/* -------------------------------------------------------------------------- */
/* Manifest completion                                                        */
/* -------------------------------------------------------------------------- */

export const ReplayManifestRequest = Type.Object(
  {
    sessionId: Ulid(),
    sequence: Type.Integer({ minimum: 0 }),
    key: Type.String({
      minLength: 1,
      maxLength: 512,
      description: 'Canonical key previously returned by `POST /v1/replay/signed-url`.',
    }),
    bytes: Type.Integer({
      minimum: 1,
      maximum: MAX_CHUNK_BYTES,
      description: 'Exact byte length of the chunk as uploaded.',
    }),
    sha256: Type.String({
      pattern: '^[a-f0-9]{64}$',
      description: 'Lower-case hex SHA-256 of the chunk body.',
    }),
    clientUploadedAt: IsoDateTime(),
    scrubber: ScrubberReport,
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/replay-manifest-request.json',
    additionalProperties: false,
    title: 'ReplayManifestRequest',
    description: 'Request body for `POST /v1/replay/complete`.',
  },
);
export type ReplayManifestRequest = Static<typeof ReplayManifestRequest>;

export const ReplayManifestResponse = Type.Object(
  {
    sessionId: Ulid(),
    sequence: Type.Integer({ minimum: 0 }),
    acceptedAt: IsoDateTime(),
    durable: Type.Boolean({
      description:
        'True once the manifest row has been durably written. Always true on a 200/201 response.',
    }),
  },
  {
    $id: 'https://schemas.resolvetrace.com/v1/replay-manifest-response.json',
    additionalProperties: false,
    title: 'ReplayManifestResponse',
    description: 'Response body for `POST /v1/replay/complete` (HTTP 200).',
  },
);
export type ReplayManifestResponse = Static<typeof ReplayManifestResponse>;
