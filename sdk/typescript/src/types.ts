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

/** Full on-wire envelope for a single event. */
export interface EventEnvelope {
  eventId: Ulid;
  sessionId?: Ulid;
  type: string;
  capturedAt: IsoDateTime;
  attributes?: EventAttributes;
  scrubber: ScrubberReport;
  clockSkewDetected?: boolean;
  sdk: SdkIdentity;
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
  /** Dot- or slash-separated event type identifier. */
  type: string;
  /** Optional session correlation ULID. */
  sessionId?: Ulid;
  /** Capture time override (defaults to now). */
  capturedAt?: Date | IsoDateTime;
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
