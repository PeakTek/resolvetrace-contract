/**
 * HTTP transport for the ResolveTrace SDK.
 *
 * Responsibilities:
 *   - Accept envelopes into an in-memory queue subject to configured caps.
 *   - Batch up to `MAX_BATCH_EVENTS` / `MAX_BATCH_BYTES` / `MAX_FLUSH_INTERVAL_MS`.
 *   - POST batches to `${endpoint}/v1/events` with a bearer token.
 *   - Retry idempotently using exponential backoff with full jitter.
 *   - Apply tail-drop backpressure with hysteresis when queue caps are hit.
 *   - Expose counters via `snapshot()` for `client.getDiagnostics()`.
 *
 * The transport is intentionally framework-agnostic; it depends only on the
 * global `fetch` (or an injected fetch-compatible override) and `AbortController`.
 */

import {
  BROWSER_QUEUE_MAX_BYTES,
  BROWSER_QUEUE_MAX_EVENTS,
  EVENTS_PATH,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_FLUSH_INTERVAL_MS,
  MAX_SINGLE_EVENT_BYTES,
  NODE_QUEUE_MAX_BYTES,
  NODE_QUEUE_MAX_EVENTS,
  QUEUE_RESUME_FRACTION,
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_WAIT_MS,
  RETRY_STATUS_CODES,
  SESSION_END_PATH,
  SESSION_START_PATH,
} from './constants.js';
import { redactAuth } from './config.js';
import type { ResolvedConfig } from './config.js';
import {
  SessionRecoveryFailedError,
  SessionUnknownError,
  TransportError,
} from './errors.js';
import { approximateJsonBytes } from './envelope.js';
import { isBrowser, nowMs } from './runtime.js';
import type {
  Diagnostics,
  EventEnvelope,
  FlushResult,
  SessionEndPayload,
  SessionStartPayload,
  SessionUnknownErrorBody,
  Ulid,
} from './types.js';

/** Size-tracked queue slot. */
interface QueueSlot {
  envelope: EventEnvelope;
  bytes: number;
}

/** Diagnostics-facing counters kept alongside the transport. */
interface Counters {
  eventsAccepted: number;
  eventsDroppedBackpressure: number;
  eventsDroppedPayloadTooLarge: number;
  eventsDroppedScrubOverflow: number;
  scrubOverflowCount: number;
  max429RetriesExhausted: number;
  lastError: { code: string; at: string } | null;
}

function makeCounters(): Counters {
  return {
    eventsAccepted: 0,
    eventsDroppedBackpressure: 0,
    eventsDroppedPayloadTooLarge: 0,
    eventsDroppedScrubOverflow: 0,
    scrubOverflowCount: 0,
    max429RetriesExhausted: 0,
    lastError: null,
  };
}

/** Cross-runtime random float in `[0, 1)` using CSPRNG. */
function secureRandomFloat(): number {
  const buf = new Uint32Array(1);
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(buf);
    return buf[0]! / 0x100000000;
  }
  // Deterministic non-secure fallback — only hit in environments that have no
  // crypto at all, which is also where ULID generation will have already
  // thrown. Kept so retry math does not itself throw.
  return (nowMs() % 1000) / 1000;
}

/** Exponential full-jitter backoff — see ADR-0001 §1. */
export function backoffDelay(attempt: number): number {
  const cap = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_WAIT_MS);
  return Math.floor(cap * secureRandomFloat());
}

/** Parse `Retry-After` (seconds or HTTP-date), clamped to RETRY_AFTER_MAX_MS. */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(0, ms - Date.now()), RETRY_AFTER_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Inspect a 409 response body to decide whether it is the typed
 * `session_unknown` shape. Returns the parsed body or `null` when the
 * payload does not match.
 */
async function parseSessionUnknownBody(
  response: Response,
): Promise<SessionUnknownErrorBody | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.error !== 'session_unknown') return null;
  const out: SessionUnknownErrorBody = { error: 'session_unknown' };
  // Prefer the camelCase server fields; accept legacy snake_case as a fallback
  // for older server builds still in deployment.
  const sessionIdField =
    typeof obj.sessionId === 'string'
      ? obj.sessionId
      : typeof obj.session_id === 'string'
        ? obj.session_id
        : null;
  if (sessionIdField !== null) out.sessionId = sessionIdField;
  const unresolvedField = Array.isArray(obj.unresolvedSessionIds)
    ? (obj.unresolvedSessionIds as unknown[])
    : Array.isArray(obj.unresolved_session_ids)
      ? (obj.unresolved_session_ids as unknown[])
      : null;
  if (unresolvedField !== null) {
    out.unresolvedSessionIds = unresolvedField.filter(
      (s): s is string => typeof s === 'string',
    );
  }
  if (typeof obj.message === 'string') out.message = obj.message;
  return out;
}

/** Pull the unresolved session IDs from a 409 body, falling back to the batch. */
function collectUnresolvedSessionIds(
  body: SessionUnknownErrorBody,
  batch: EventEnvelope[],
): Ulid[] {
  if (body.unresolvedSessionIds && body.unresolvedSessionIds.length > 0) {
    return [...body.unresolvedSessionIds];
  }
  if (body.sessionId) {
    return [body.sessionId];
  }
  // Last-resort: dedupe the session IDs visible on the batch.
  const seen = new Set<Ulid>();
  for (const env of batch) {
    if (env.sessionId) seen.add(env.sessionId);
  }
  return Array.from(seen);
}

/** Injected dependencies — broken out so tests can replace them. */
export interface TransportDeps {
  fetchImpl: typeof fetch;
  /** Optional sleep override for tests (defaults to `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional queue-cap override (defaults are derived from the runtime). */
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  /**
   * Recovery hook invoked when an events POST returns 409 with the typed
   * `session_unknown` body. The transport will retry the batch ONCE after
   * the hook resolves.
   */
  onSessionUnknown?: (unresolvedSessionIds: Ulid[]) => Promise<void>;
}

/** Resolve queue caps based on the detected runtime. */
function runtimeQueueCaps(): { maxEvents: number; maxBytes: number } {
  if (isBrowser()) {
    return { maxEvents: BROWSER_QUEUE_MAX_EVENTS, maxBytes: BROWSER_QUEUE_MAX_BYTES };
  }
  return { maxEvents: NODE_QUEUE_MAX_EVENTS, maxBytes: NODE_QUEUE_MAX_BYTES };
}

/**
 * Transport state machine. Not exported publicly — consumers use
 * `ResolveTraceClient` which owns an instance of this.
 */
export class Transport {
  private readonly config: ResolvedConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxQueueEvents: number;
  private readonly maxQueueBytes: number;
  private readonly onSessionUnknown:
    | ((unresolvedSessionIds: Ulid[]) => Promise<void>)
    | undefined;

  private queue: QueueSlot[] = [];
  private queueBytes = 0;
  /** True while the queue has crossed its cap; stays true until it falls back to `QUEUE_RESUME_FRACTION`. */
  private backpressured = false;

  private oldestEventAtMs: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** A running flush promise, or null if idle. */
  private flushInFlight: Promise<void> | null = null;

  private shutdownRequested = false;
  private counters: Counters = makeCounters();

  constructor(config: ResolvedConfig, deps: TransportDeps) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl;
    this.sleepImpl = deps.sleep ?? sleep;
    const caps = runtimeQueueCaps();
    this.maxQueueEvents = deps.maxQueueEvents ?? caps.maxEvents;
    this.maxQueueBytes = deps.maxQueueBytes ?? caps.maxBytes;
    this.onSessionUnknown = deps.onSessionUnknown;
  }

  /** Late-bind the recovery hook (used when the manager is constructed after the transport). */
  setSessionUnknownHandler(
    handler: (unresolvedSessionIds: Ulid[]) => Promise<void>,
  ): void {
    (this as unknown as { onSessionUnknown: typeof handler }).onSessionUnknown = handler;
  }

  /** Enqueue a fully-built envelope. Returns true when accepted, false when dropped. */
  enqueue(envelope: EventEnvelope): boolean {
    if (this.shutdownRequested) {
      this.recordError('client.shutdown');
      return false;
    }

    const bytes = approximateJsonBytes(envelope);

    if (bytes > MAX_SINGLE_EVENT_BYTES) {
      this.counters.eventsDroppedPayloadTooLarge++;
      this.recordError('transport.payload_too_large');
      return false;
    }

    if (envelope.scrubber.budgetExceeded) {
      this.counters.scrubOverflowCount++;
    }

    // Tail-drop when either cap is hit.
    if (
      this.backpressured ||
      this.queue.length >= this.maxQueueEvents ||
      this.queueBytes + bytes > this.maxQueueBytes
    ) {
      this.backpressured = true;
      this.counters.eventsDroppedBackpressure++;
      this.recordError('queue.backpressure');
      return false;
    }

    this.queue.push({ envelope, bytes });
    this.queueBytes += bytes;
    this.counters.eventsAccepted++;

    if (this.oldestEventAtMs === null) {
      this.oldestEventAtMs = nowMs();
      this.armFlushTimer();
    }

    if (
      this.queue.length >= MAX_BATCH_EVENTS ||
      this.queueBytes >= MAX_BATCH_BYTES
    ) {
      // Fire-and-forget — the scheduled flush will chain if one is in-flight.
      void this.flush();
    }

    return true;
  }

  /** Number of events currently buffered. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Approximate bytes currently buffered. */
  get bufferedBytes(): number {
    return this.queueBytes;
  }

  /** Return a serializable diagnostics snapshot. */
  snapshot(): Diagnostics {
    return {
      queueDepth: this.queue.length,
      queueBytes: this.queueBytes,
      eventsAccepted: this.counters.eventsAccepted,
      eventsDropped: {
        backpressure: this.counters.eventsDroppedBackpressure,
        scrubOverflow: this.counters.eventsDroppedScrubOverflow,
        payloadTooLarge: this.counters.eventsDroppedPayloadTooLarge,
      },
      lastError: this.counters.lastError,
      scrubOverflowCount: this.counters.scrubOverflowCount,
      max429RetriesExhaustedCount: this.counters.max429RetriesExhausted,
    };
  }

  /**
   * Force an immediate flush. Subsequent calls made while a flush is running
   * chain behind it, so the caller always sees the queue fully drained before
   * the returned promise resolves.
   */
  async flush(opts?: { timeoutMs?: number }): Promise<FlushResult> {
    const start = nowMs();
    let sent = 0;
    let dropped = 0;

    // Respect the timeout budget while there is something to do.
    while (this.queue.length > 0) {
      if (opts?.timeoutMs !== undefined && nowMs() - start > opts.timeoutMs) {
        return { completed: false, sent, dropped };
      }
      // Chain behind any in-flight flush.
      if (this.flushInFlight) {
        await this.flushInFlight;
        continue;
      }

      const batch = this.takeBatch();
      if (batch.length === 0) break;

      const pending = this.postBatchWithRecovery(batch)
        .then(() => {
          sent += batch.length;
        })
        .catch(() => {
          dropped += batch.length;
        })
        .finally(() => {
          this.flushInFlight = null;
          this.updateBackpressureHysteresis();
        });

      this.flushInFlight = pending;
      await pending;
    }

    return { completed: true, sent, dropped };
  }

  /**
   * Submit a batch, with one-shot `session_unknown` recovery: on the first
   * 409 we run the recovery hook (which re-issues session-start) and retry
   * exactly once. A second 409 surfaces `session.recovery_failed` via
   * `onError` and drops the batch.
   */
  private async postBatchWithRecovery(batch: EventEnvelope[]): Promise<void> {
    try {
      await this.postWithRetry(batch);
      return;
    } catch (err) {
      if (!(err instanceof SessionUnknownError)) throw err;
      if (!this.onSessionUnknown) throw err;
      try {
        await this.onSessionUnknown(err.unresolvedSessionIds);
      } catch (recoveryErr) {
        this.debugLog('session.recovery_failed', recoveryErr);
      }
      try {
        await this.postWithRetry(batch);
        return;
      } catch (retryErr) {
        if (retryErr instanceof SessionUnknownError) {
          this.counters.lastError = {
            code: 'session.recovery_failed',
            at: new Date().toISOString(),
          };
          if (this.config.onError) {
            try {
              this.config.onError(
                new SessionRecoveryFailedError(retryErr.unresolvedSessionIds),
              );
            } catch {
              /* swallow */
            }
          }
          throw retryErr;
        }
        throw retryErr;
      }
    }
  }

  /** Stop accepting events and return control once the queue is drained or timeout elapses. */
  async shutdown(opts?: { timeoutMs?: number }): Promise<void> {
    this.shutdownRequested = true;
    this.clearFlushTimer();
    await this.flush({ timeoutMs: opts?.timeoutMs ?? 10_000 });
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  private takeBatch(): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    let bytes = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (out.length >= MAX_BATCH_EVENTS) break;
      if (out.length > 0 && bytes + next.bytes > MAX_BATCH_BYTES) break;
      this.queue.shift();
      this.queueBytes -= next.bytes;
      out.push(next.envelope);
      bytes += next.bytes;
    }
    if (this.queue.length === 0) {
      this.oldestEventAtMs = null;
      this.clearFlushTimer();
    }
    this.updateBackpressureHysteresis();
    return out;
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, MAX_FLUSH_INTERVAL_MS);
    // In Node, don't keep the event loop alive on the SDK's behalf.
    const t = this.flushTimer as { unref?: () => void };
    if (typeof t?.unref === 'function') t.unref();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private updateBackpressureHysteresis(): void {
    if (!this.backpressured) return;
    const eventFrac = this.queue.length / this.maxQueueEvents;
    const byteFrac = this.queueBytes / this.maxQueueBytes;
    if (eventFrac <= QUEUE_RESUME_FRACTION && byteFrac <= QUEUE_RESUME_FRACTION) {
      this.backpressured = false;
    }
  }

  private async postWithRetry(batch: EventEnvelope[]): Promise<void> {
    const body = JSON.stringify({ events: batch });
    const url = new URL(EVENTS_PATH, this.config.endpointUrl).toString();

    let attempt = 0;
    for (;;) {
      let retryAfterMs: number | null = null;
      let hadError = false;
      let status: number | undefined;

      try {
        // Note: we deliberately do not set User-Agent — browsers forbid
        // overriding it and Node's fetch already stamps its own identifier.
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
        });

        status = response.status;

        if (response.status >= 200 && response.status < 300) {
          return;
        }

        // 409 with `session_unknown` is signalled to the caller (the client
        // owns the recovery path: re-issue session-start, retry once).
        if (response.status === 409) {
          const parsed = await parseSessionUnknownBody(response);
          if (parsed) {
            const ids = collectUnresolvedSessionIds(parsed, batch);
            this.counters.lastError = {
              code: 'session.unknown',
              at: new Date().toISOString(),
            };
            throw new SessionUnknownError(ids);
          }
        }

        if (RETRY_STATUS_CODES.includes(response.status)) {
          retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        } else {
          // Terminal error — no retry.
          const err = new TransportError(
            'transport.http',
            `Ingest responded ${response.status}`,
            response.status,
          );
          this.recordError('transport.http');
          throw err;
        }
      } catch (err) {
        if (err instanceof TransportError) throw err;
        if (err instanceof SessionUnknownError) throw err;
        hadError = true;
        this.debugLog('transport.network', err);
      }

      attempt++;
      if (attempt > RETRY_MAX_ATTEMPTS) {
        this.counters.max429RetriesExhausted++;
        this.recordError('transport.retries_exhausted');
        throw new TransportError(
          'transport.retries_exhausted',
          `Exceeded ${RETRY_MAX_ATTEMPTS} retries (last status: ${status ?? 'network'})`,
          status,
        );
      }

      const wait = retryAfterMs ?? backoffDelay(attempt);
      if (hadError) this.recordError('transport.network');
      await this.sleepImpl(wait);
    }
  }

  /**
   * POST a session-start payload. Best-effort — the caller fires-and-forgets
   * for performance, so this method swallows non-2xx responses into a
   * `TransportError` reported via `onError`. Idempotent server-side.
   */
  async postSessionStart(payload: SessionStartPayload): Promise<void> {
    const url = new URL(SESSION_START_PATH, this.config.endpointUrl).toString();
    await this.postSessionPayload(url, payload, 'session.start');
  }

  /** POST a session-end payload. Same fire-and-forget semantics as start. */
  async postSessionEnd(payload: SessionEndPayload): Promise<void> {
    const url = new URL(SESSION_END_PATH, this.config.endpointUrl).toString();
    await this.postSessionPayload(url, payload, 'session.end');
  }

  private async postSessionPayload(
    url: string,
    payload: unknown,
    label: string,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body,
      });
      if (response.status >= 200 && response.status < 300) {
        return;
      }
      this.recordError(`${label}.http`);
    } catch (err) {
      this.debugLog(`${label}.network`, err);
      this.recordError(`${label}.network`);
    }
  }

  private recordError(code: string): void {
    this.counters.lastError = { code, at: new Date().toISOString() };
    if (this.config.onError) {
      try {
        this.config.onError(new TransportError('transport.network', code));
      } catch {
        // onError callbacks must not be able to crash the SDK.
      }
    }
    this.debugLog(code);
  }

  private debugLog(code: string, err?: unknown): void {
    if (!this.config.debug) return;
    const prefix = `[resolvetrace] ${code}`;
    const redactedAuth = redactAuth(this.config.apiKey);
    if (err) {
      // eslint-disable-next-line no-console
      console.warn(prefix, { auth: redactedAuth, err });
    } else {
      // eslint-disable-next-line no-console
      console.warn(prefix, { auth: redactedAuth });
    }
  }
}
