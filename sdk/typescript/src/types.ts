/**
 * Public TypeScript types for the ResolveTrace SDK.
 *
 * These interfaces mirror the wire schemas published in `schemas/events.json`
 * at the root of this contract repository. They are hand-authored (rather than
 * derived from TypeBox) so the shipped SDK has zero runtime dependencies.
 */

/** ULID in Crockford base32 (26 chars, excluding I/L/O/U). */
export type Ulid = string;

/** ISO-8601 / RFC 3339 timestamp string. */
export type IsoDateTime = string;

/** A single attribute value on an event. */
export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | AttributeValue[]
  | { [key: string]: AttributeValue };

/** Free-form attribute bag supplied by the caller. */
export type EventAttributes = Record<string, unknown>;

/**
 * Canonical event vocabulary — the 14 reserved event-type names with a stable,
 * cross-producer shape. Wave 21+ capture features emit against these. Mirrors
 * `KnownEventType` in `schemas/events.json`.
 */
export type KnownEventType =
  | 'view.start'
  | 'view.end'
  | 'action.click'
  | 'action.submit'
  | 'action.navigation'
  | 'error.js'
  | 'error.api'
  | 'error.resource'
  | 'perf.api_latency'
  | 'perf.long_task'
  | 'ux.dead_click'
  | 'ux.rage_click'
  | 'ux.repeated_submit'
  | 'support.report_submitted';

/** Diagnostics collection level (mirrors the wire `diagnosticsLevel`). */
export type DiagnosticsLevel = 'essential' | 'standard' | 'assisted_support';

/** Event severity classification (mirrors the wire `severity`). */
export type Severity = 'info' | 'warn' | 'error';

/**
 * Shared per-event global context. Optional on the envelope; when supplied,
 * `releaseVersion`/`locale`/`market`/`diagnosticsLevel` are required. camelCase
 * wire form; mirrors `EventContext` in `schemas/events.json`.
 */
export interface EventContext {
  releaseVersion: string;
  locale: string;
  market: string;
  diagnosticsLevel: DiagnosticsLevel;
  routeName?: string;
  routeType?: string;
  componentId?: string;
  componentType?: string;
  browserFamily?: string;
  browserVersion?: string;
  osFamily?: string;
  deviceType?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  featureFlags?: Record<string, unknown>;
  experimentVariant?: string;
  networkState?: string;
  /** Raw page URL (browser producers). Not part of the abstract vocabulary. */
  pageUrl?: string;
  /** Support code (shape only; generation handled in a later wave). */
  supportCode?: string;
}

/** Per-event report stamped by the SDK-side scrubber. */
export interface ScrubberReport {
  /** SDK scrubber version string (e.g. "sdk@0.1.0"). */
  version: string;
  /** Hex-encoded SHA-256 of the ruleset applied, prefixed with "sha256:". */
  rulesDigest: string;
  /** Rule identifiers applied to this event (e.g. "regex:email", "attr:data-rt-mask"). */
  applied: string[];
  /** True when the SDK hit the per-event scrub budget and fell back to the overflow policy. */
  budgetExceeded: boolean;
  /** Observed scrub duration in milliseconds. */
  durationMs?: number;
}

/** SDK identity stamped on every envelope. */
export interface SdkIdentity {
  /** SDK package identifier (e.g. "@peaktek/resolvetrace-sdk"). */
  name: string;
  /** SDK semver, e.g. "0.1.0". */
  version: string;
  /** Free-form runtime identifier (e.g. "browser", "node-20"). */
  runtime?: string;
}

/** Caller-supplied identity decorator, populated by `client.identify(...)`. */
export interface ActorIdentity {
  /** Caller-provided opaque user identifier. */
  userId: string;
  /** Optional free-form trait bag. */
  traits?: Record<string, unknown>;
}

/** Full on-wire envelope for a single event. */
export interface EventEnvelope {
  /** Major of the shared event schema. The SDK stamps the current major (1). */
  schemaVersion: number;
  eventId: Ulid;
  /**
   * Session correlation ULID. Always present on envelopes built by the
   * client; remains optional on the wire schema for backward compatibility
   * with legacy callers that build envelopes by hand.
   */
  sessionId?: Ulid;
  type: string;
  capturedAt: IsoDateTime;
  /** Shared per-event global context (release/locale/market/diagnostics + more). */
  context?: EventContext;
  /** Severity classification (info | warn | error). */
  severity?: Severity;
  /** Duration in milliseconds, for events that measure one. */
  durationMs?: number;
  /** HTTP status code, for API-oriented events. */
  httpStatus?: number;
  attributes?: EventAttributes;
  scrubber: ScrubberReport;
  clockSkewDetected?: boolean;
  sdk: SdkIdentity;
  /** Identity decoration carried from `client.identify(...)`. */
  actor?: ActorIdentity;
}

/** Batch request body POSTed to `/v1/events`. */
export interface EventBatchRequest {
  events: EventEnvelope[];
}

/** Successful `/v1/events` response body. */
export interface EventBatchAcceptedResponse {
  accepted: number;
  duplicates: number;
  receivedAt: IsoDateTime;
}

/** User-facing input shape for `client.capture()`. */
export interface EventInput {
  /**
   * Event type identifier. A canonical `KnownEventType` is preferred for
   * interaction/error/perf/ux/support events; custom names remain accepted
   * outside the reserved canonical namespaces.
   */
  type: KnownEventType | (string & {});
  /** Optional session correlation ULID. */
  sessionId?: Ulid;
  /** Capture time override (defaults to now). */
  capturedAt?: Date | IsoDateTime;
  /** Shared per-event global context. */
  context?: EventContext;
  /** Severity classification. */
  severity?: Severity;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** HTTP status code. */
  httpStatus?: number;
  /** Arbitrary attribute bag. */
  attributes?: EventAttributes;
}

/** Counters surfaced by `client.getDiagnostics()`. Keys are cross-language-frozen (ADR-0007). */
export interface Diagnostics {
  queueDepth: number;
  queueBytes: number;
  eventsAccepted: number;
  eventsDropped: {
    backpressure: number;
    scrubOverflow: number;
    payloadTooLarge: number;
  };
  lastError: { code: string; at: IsoDateTime } | null;
  scrubOverflowCount: number;
  max429RetriesExhaustedCount: number;
}

/** CSS selectors applied by the SDK scrubber to mask matching elements. */
export type MaskSelector = string;

/** Reason the SDK ended a session. Mirrors the wire payload field. */
export type SessionEndReason =
  | 'inactivity'
  | 'max_duration'
  | 'explicit'
  | 'shutdown';

/** Body sent by the SDK on `POST /v1/session/start`. */
export interface SessionStartPayload {
  sessionId: Ulid;
  startedAt: IsoDateTime;
  client?: {
    userAgent?: string;
  };
  identify?: {
    userId: string;
    traits?: Record<string, unknown>;
  };
}

/** Body sent by the SDK on `POST /v1/session/end`. */
export interface SessionEndPayload {
  sessionId: Ulid;
  endedAt: IsoDateTime;
  reason: SessionEndReason;
}

/** Body returned by the server when an events batch references an unknown session. */
export interface SessionUnknownErrorBody {
  error: 'session_unknown';
  sessionId?: Ulid;
  unresolvedSessionIds?: Ulid[];
  message?: string;
}

/**
 * Browser auto-capture configuration.
 *
 * Auto-capture is browser-only and ON by default in a browser runtime; outside
 * a browser the installer is a no-op regardless of these values. Each signal
 * can be opted out individually, or the whole subsystem disabled with
 * `enabled: false`. Tunables let a host tighten/loosen the heuristics and the
 * per-session volume ceiling. All emitted events still flow through the normal
 * `capture()` pipeline (session, context enrichment, Stage-1 scrubber).
 *
 * A2 extends this shape with its own per-signal booleans + tunables for the
 * error / network / perf breadcrumb sources; keep the same conventions
 * (boolean flag named after the signal, tunables alongside).
 */
export interface AutoCaptureOptions {
  /** Master switch. When false, nothing is installed. Default `true`. */
  enabled?: boolean;

  // --- Frustration signals (Wave-21 A1) ------------------------------------
  /** Capture `ux.rage_click`. Default `true`. */
  rageClick?: boolean;
  /** Capture `ux.dead_click`. Default `true`. */
  deadClick?: boolean;
  /** Capture `ux.repeated_submit`. Default `true`. */
  repeatedSubmit?: boolean;

  // --- Heuristic tunables ---------------------------------------------------
  /** Clicks on the same masked target to trigger a rage burst. Default `3`. */
  rageClickThreshold?: number;
  /** Window (ms) within which rage clicks must occur. Default `1000`. */
  rageClickWindowMs?: number;
  /**
   * Window (ms) after a click with no DOM mutation / navigation / network
   * before it is flagged as a dead click. Default `2500`.
   */
  deadClickWindowMs?: number;
  /** Submits of the same form to trigger a repeated-submit signal. Default `2`. */
  repeatedSubmitThreshold?: number;
  /** Window (ms) within which repeated submits must occur. Default `3000`. */
  repeatedSubmitWindowMs?: number;

  // --- Bounding -------------------------------------------------------------
  /**
   * Hard ceiling on the number of auto-captured events emitted per session, so
   * a pathological page cannot flood ingest. Default `200`.
   */
  maxEventsPerSession?: number;
}

/** Options accepted by the `ResolveTraceClient` constructor. */
export interface ClientOptions {
  /** Opaque bearer token issued by the ResolveTrace control plane. */
  apiKey: string;
  /** Fully-qualified HTTPS endpoint (e.g. "https://ingest.resolvetrace.com"). */
  endpoint: string;
  /** Optional error callback for host-app logging. */
  onError?: (err: Error) => void;
  /** Optional pre-send hook. Runs AFTER Stage-1 scrubbing. */
  beforeSend?: (envelope: EventEnvelope) => EventEnvelope | null | undefined;
  /** Upper bound for `beforeSend` execution (ms). Default 4. */
  beforeSendTimeoutMs?: number;
  /** When true, log SDK-internal diagnostics to the console (with Authorization redacted). */
  debug?: boolean;
  /** Optional fetch override — for tests only. */
  transport?: typeof fetch;
  /** CSS selectors whose matched elements the scrubber should mask. */
  maskSelectors?: MaskSelector[];
  /**
   * Idle timeout (ms) before the current session is rolled. Defaults to
   * 30 minutes. May only be lowered relative to the default.
   */
  sessionInactivityMs?: number;
  /**
   * Hard upper bound (ms) on session duration before the session is rolled.
   * Defaults to 12 hours. May only be lowered relative to the default.
   */
  sessionMaxDurationMs?: number;
  /**
   * When `false`, the SDK will not lazy-start a session on the first capture.
   * The caller is then responsible for invoking `client.session.restart()`
   * before any `capture()`. Defaults to `true`.
   */
  autoSession?: boolean;
  /**
   * @deprecated No longer emitted on the wire. The `SessionStartRequest`
   * contract is `additionalProperties: false` and carries no `attributes`
   * field, so a session-start attribute bag is rejected with HTTP 400.
   * Per-page context now rides on the `page_view` event (see the SDK's
   * automatic page-context enrichment). A structured per-session `context`
   * block is planned for a future contract revision; this option is retained
   * for source compatibility but currently has no effect.
   */
  sessionAttributes?: () => Record<string, unknown>;
  /**
   * Browser auto-capture configuration. Browser-only and ON by default in a
   * browser runtime; no-op outside a browser. See `AutoCaptureOptions`.
   */
  autoCapture?: AutoCaptureOptions | boolean;
}

/** Options accepted by `client.flush()`. */
export interface FlushOptions {
  /** Upper bound on how long to wait for the in-flight batch. */
  timeoutMs?: number;
}

/** Shape returned by `flush()`. */
export interface FlushResult {
  /** Whether the flush completed before the timeout. */
  completed: boolean;
  /** Number of events successfully sent during this flush. */
  sent: number;
  /** Number of events dropped during this flush (backpressure, payload-too-large, etc.). */
  dropped: number;
}

/** Options accepted by `client.shutdown()`. */
export interface ShutdownOptions {
  timeoutMs?: number;
}

/** Options accepted by `client.session.end()`. */
export interface SessionEndOptions {
  timeoutMs?: number;
}
