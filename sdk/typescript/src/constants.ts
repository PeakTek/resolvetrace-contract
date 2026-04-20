/**
 * Pinned numeric envelope constants.
 *
 * These values are the SDK's public commitment about batching, retry, memory,
 * and payload caps. They cannot be raised at runtime; lowering some of them
 * via `ClientOptions` is permitted where explicitly documented.
 */

/** Package identity. Stamped into `envelope.sdk.*` on every event. */
export const SDK_NAME = '@peaktek/resolvetrace-sdk';
export const SDK_VERSION = '0.1.0';

/** Scrubber identity. Bumped when Stage-1 rules change in a user-visible way. */
export const SCRUBBER_VERSION = `sdk@${SDK_VERSION}`;

/** Batching caps. */
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 512 * 1024; // 512 KiB
export const MAX_FLUSH_INTERVAL_MS = 5_000;
export const MIN_FLUSH_INTERVAL_MS = 250;

/** Retry policy. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_WAIT_MS = 30_000;
export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_AFTER_MAX_MS = 60_000;
export const RETRY_STATUS_CODES: ReadonlyArray<number> = [429, 500, 502, 503, 504];

/** Scrub per-event budget. */
export const MAX_SCRUB_MS_PER_EVENT = 4;

/** beforeSend hook default budget (user-tunable downward only). */
export const DEFAULT_BEFORE_SEND_TIMEOUT_MS = 4;

/** In-memory queue caps (ADR-0001 §5). */
export const BROWSER_QUEUE_MAX_EVENTS = 500;
export const BROWSER_QUEUE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const NODE_QUEUE_MAX_EVENTS = 5_000;
export const NODE_QUEUE_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB

/** Queue hysteresis — resume intake when both axes fall to this fraction. */
export const QUEUE_RESUME_FRACTION = 0.9;

/** Payload size caps. */
export const MAX_SINGLE_EVENT_BYTES = 256 * 1024; // 256 KiB
export const MAX_STRING_FIELD_BYTES = 64 * 1024; // 64 KiB
export const MAX_API_KEY_BYTES = 4 * 1024; // 4 KiB

/** HTTP path for the batch ingest endpoint. */
export const EVENTS_PATH = '/v1/events';

/** Allowed option keys on the public constructor. */
export const ALLOWED_OPTION_KEYS: ReadonlySet<string> = new Set([
  'apiKey',
  'endpoint',
  'onError',
  'beforeSend',
  'beforeSendTimeoutMs',
  'debug',
  'transport',
  'maskSelectors',
]);
