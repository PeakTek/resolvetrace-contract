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

/**
 * Current major of the shared event schema. Stamped into `envelope.schemaVersion`
 * on every event. Consumers reject unsupported majors; additive changes stay
 * within a major.
 */
export const SCHEMA_VERSION = 1;

/**
 * Canonical event-type vocabulary. The keys are stable symbolic names for
 * Wave 21+ capture code to reference; the values are the wire `type` strings.
 * Mirrors `KnownEventType` in `schemas/events.json`.
 */
export const EVENT_TYPES = {
  VIEW_START: 'view.start',
  VIEW_END: 'view.end',
  ACTION_CLICK: 'action.click',
  ACTION_SUBMIT: 'action.submit',
  ACTION_NAVIGATION: 'action.navigation',
  ERROR_JS: 'error.js',
  ERROR_API: 'error.api',
  ERROR_RESOURCE: 'error.resource',
  PERF_API_LATENCY: 'perf.api_latency',
  PERF_LONG_TASK: 'perf.long_task',
  UX_DEAD_CLICK: 'ux.dead_click',
  UX_RAGE_CLICK: 'ux.rage_click',
  UX_REPEATED_SUBMIT: 'ux.repeated_submit',
  SUPPORT_REPORT_SUBMITTED: 'support.report_submitted',
} as const;

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

/** HTTP path for opening a session. */
export const SESSION_START_PATH = '/v1/session/start';

/** HTTP path for closing a session. */
export const SESSION_END_PATH = '/v1/session/end';

/** Default session inactivity (idle) timeout. May only be lowered. */
export const DEFAULT_SESSION_INACTIVITY_MS = 30 * 60 * 1000;

/** Default session max duration. May only be lowered. */
export const DEFAULT_SESSION_MAX_DURATION_MS = 12 * 60 * 60 * 1000;

/** Lower bound (inclusive) on either session timeout. */
export const MIN_SESSION_TIMEOUT_MS = 1_000;

/** Maximum frequency (ms) of sessionStorage flushes for `lastActivityAt`. */
export const SESSION_STORAGE_FLUSH_INTERVAL_MS = 5_000;

/** Auto-capture (browser-only) heuristic + bounding defaults (Wave-21). */
export const DEFAULT_RAGE_CLICK_THRESHOLD = 3;
export const DEFAULT_RAGE_CLICK_WINDOW_MS = 1_000;
export const DEFAULT_DEAD_CLICK_WINDOW_MS = 2_500;
export const DEFAULT_REPEATED_SUBMIT_THRESHOLD = 2;
export const DEFAULT_REPEATED_SUBMIT_WINDOW_MS = 3_000;
/** Per-session ceiling on auto-captured events (anti-flood). */
export const DEFAULT_AUTO_CAPTURE_MAX_EVENTS_PER_SESSION = 200;

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
  'sessionInactivityMs',
  'sessionMaxDurationMs',
  'autoSession',
  'sessionAttributes',
  'autoCapture',
]);

/** Allowed keys inside the `autoCapture` options object. */
export const ALLOWED_AUTOCAPTURE_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'rageClick',
  'deadClick',
  'repeatedSubmit',
  'rageClickThreshold',
  'rageClickWindowMs',
  'deadClickWindowMs',
  'repeatedSubmitThreshold',
  'repeatedSubmitWindowMs',
  'maxEventsPerSession',
]);
