/**
 * Barrel export for all authored TypeBox schema sources.
 *
 * Downstream TypeScript consumers import types and schema objects from this
 * entry point. The emitted JSON Schemas (one level up, `schemas/*.json`) are
 * the canonical artifacts consumed by the Python SDK, backend validators,
 * and the OpenAPI spec.
 *
 * Note: each module file exports a `MODULE_META` constant consumed by
 * `scripts/build-schemas.ts` via direct per-module imports. It is intentionally
 * not re-exported from this barrel — re-exporting four identically-named
 * symbols through `export *` would be ambiguous.
 */

export {
  ULID_PATTERN,
  Ulid,
  IsoDateTime,
  ScrubberReport,
  EventType,
  EventAttributes,
  SdkIdentity,
  EventEnvelope,
  EventBatchRequest,
  EventBatchAcceptedResponse,
} from './events.js';

export {
  ReplaySignedUrlRequest,
  ReplaySignedUrlResponse,
  ReplayManifestRequest,
  ReplayManifestResponse,
} from './replay.js';

export {
  SessionViewport,
  SessionClient,
  ReleaseChannel,
  SessionStartRequest,
  SessionStartResponse,
  SessionEndReason,
  SessionEndRequest,
  SessionEndResponse,
} from './session.js';

export {
  ErrorCode,
  ErrorResponse,
  RateLimitClass,
  RateLimitDimension,
  RateLimitScope,
  RateLimitErrorResponse,
  RateLimitHeaders,
} from './api-responses.js';
