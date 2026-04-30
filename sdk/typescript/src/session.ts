/**
 * Session manager: owns lifecycle of `session_id` for the SDK.
 *
 * Responsibilities:
 *   - Generate and persist a per-tab session ULID.
 *   - Transition between `Idle`, `Active`, and `Ending` states.
 *   - Trigger session start/end calls on the transport at the right moments.
 *   - Restore an existing session from `sessionStorage` (browser) when
 *     timeouts have not yet elapsed.
 *   - Hold the inactivity / max-duration timers and roll over the session
 *     when either fires.
 *   - Provide a hook the events transport can call after a 409 response so
 *     the same session ID is re-issued and the batch is retried once.
 *
 * The transport is dependency-injected so unit tests can stub out the
 * outbound HTTP layer entirely.
 */

import {
  DEFAULT_SESSION_INACTIVITY_MS,
  DEFAULT_SESSION_MAX_DURATION_MS,
  SESSION_STORAGE_FLUSH_INTERVAL_MS,
} from './constants.js';
import { ResolveTraceError, SessionRequiredError } from './errors.js';
import type { IdentityState } from './identity.js';
import { isBrowser } from './runtime.js';
import type {
  IsoDateTime,
  SessionEndPayload,
  SessionEndReason,
  SessionStartPayload,
  Ulid,
} from './types.js';
import { generateUlid } from './ulid.js';

/** Internal state machine label. */
export type SessionState = 'idle' | 'active' | 'ending';

/** Persisted session record stored in `sessionStorage`. */
interface StoredSession {
  session_id: Ulid;
  started_at: IsoDateTime;
  last_activity_at: IsoDateTime;
}

/** Transport surface the session manager uses. Kept narrow for tests. */
export interface SessionTransport {
  postSessionStart(payload: SessionStartPayload): Promise<void>;
  postSessionEnd(payload: SessionEndPayload): Promise<void>;
}

/** Constructor inputs for `SessionManager`. */
export interface SessionManagerOptions {
  endpoint: string;
  transport: SessionTransport;
  identity: IdentityState;
  onError?: (err: Error) => void;
  sessionInactivityMs?: number;
  sessionMaxDurationMs?: number;
  autoSession?: boolean;
  sessionAttributes?: () => Record<string, unknown>;
  /** Override `Date.now` for tests. */
  now?: () => number;
  /** Override `setTimeout` for tests / fake timers. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Companion to `setTimer`. */
  clearTimer?: (handle: unknown) => void;
}

/** Synchronous, non-cryptographic hash adequate for storage-key discrimination. */
function fnv1a16(input: string): string {
  // FNV-1a 32-bit; we only need the leading 16 hex chars.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Equivalent to h = (h * 16777619) >>> 0, expanded to avoid 32-bit overflow.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Mix with a second pass to widen the output to 64 bits worth of entropy.
  let g = 0xcbf29ce4;
  for (let i = input.length - 1; i >= 0; i--) {
    g ^= input.charCodeAt(i);
    g = (g + ((g << 1) + (g << 4) + (g << 7) + (g << 8) + (g << 24))) >>> 0;
  }
  const part1 = h.toString(16).padStart(8, '0');
  const part2 = g.toString(16).padStart(8, '0');
  return (part1 + part2).slice(0, 16);
}

/** Build the `sessionStorage` key for an endpoint. */
export function endpointStorageKey(endpoint: string): string {
  return `rt:session:${fnv1a16(endpoint)}`;
}

/** Try to acquire a `Storage`-shaped object for the current runtime. Returns null on access errors. */
function getSessionStorage(): Storage | null {
  if (!isBrowser()) return null;
  try {
    const ss = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!ss) return null;
    // Probe access — some embedded contexts throw on first read.
    ss.getItem('__rt_probe__');
    return ss;
  } catch {
    return null;
  }
}

/**
 * Session lifecycle owner. Construct exactly one per `ResolveTraceClient`.
 */
export class SessionManager {
  private readonly endpoint: string;
  private readonly transport: SessionTransport;
  private readonly identity: IdentityState;
  private readonly onError: ((err: Error) => void) | undefined;
  private readonly inactivityMs: number;
  private readonly maxDurationMs: number;
  private readonly autoSession: boolean;
  private readonly sessionAttributes: (() => Record<string, unknown>) | undefined;
  private readonly storageKey: string;

  private readonly nowFn: () => number;
  private readonly setTimerFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;

  private state: SessionState = 'idle';
  private currentId: Ulid | null = null;
  private startedAtMs: number | null = null;
  private lastActivityMs: number | null = null;
  private lastFlushedActivityMs: number | null = null;

  private inactivityTimer: unknown = null;
  private maxDurationTimer: unknown = null;

  /** Identity payload captured for inclusion in the next session-start body. */
  private pendingIdentityForStart: { userId: string; traits?: Record<string, unknown> } | null =
    null;
  private storageWarned = false;

  constructor(opts: SessionManagerOptions) {
    this.endpoint = opts.endpoint;
    this.transport = opts.transport;
    this.identity = opts.identity;
    this.onError = opts.onError;
    this.inactivityMs = opts.sessionInactivityMs ?? DEFAULT_SESSION_INACTIVITY_MS;
    this.maxDurationMs = opts.sessionMaxDurationMs ?? DEFAULT_SESSION_MAX_DURATION_MS;
    this.autoSession = opts.autoSession ?? true;
    this.sessionAttributes = opts.sessionAttributes;
    this.storageKey = endpointStorageKey(this.endpoint);

    this.nowFn = opts.now ?? (() => Date.now());
    this.setTimerFn =
      opts.setTimer ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms) as unknown as { unref?: () => void };
        if (typeof t?.unref === 'function') t.unref();
        return t;
      });
    this.clearTimerFn =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

    this.tryRestore();
  }

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  /** Current session ID, or `null` when no session is active. */
  getId(): Ulid | null {
    return this.currentId;
  }

  /** Current state. Useful for tests; not part of the public package API. */
  getState(): SessionState {
    return this.state;
  }

  /**
   * Ensure an active session exists. In auto-session mode, lazy-starts a
   * fresh session when none is held. Returns the session ULID.
   *
   * In `autoSession: false` mode, this method does NOT lazy-start; if no
   * session is active it throws a `session.required` error so the caller
   * can drop the event and surface the failure via `onError`.
   */
  ensureStarted(): Ulid {
    if (this.state === 'active' && this.currentId !== null) {
      return this.currentId;
    }
    if (!this.autoSession) {
      throw new SessionRequiredError();
    }
    return this.startNewSession({ persistAndPost: true });
  }

  /**
   * Synchronously generate a new session ID and return it. Old session
   * (if any) is ended and a new start is fired-and-forget.
   */
  restart(): Ulid {
    const oldId = this.currentId;
    if (oldId !== null) {
      this.fireSessionEnd(oldId, 'explicit');
    }
    this.clearTimers();
    this.state = 'idle';
    this.currentId = null;
    this.startedAtMs = null;
    this.lastActivityMs = null;
    this.lastFlushedActivityMs = null;
    return this.startNewSession({ persistAndPost: true });
  }

  /**
   * End the current session. Awaits the network call up to `timeoutMs`.
   * Safe to call when no session is active (no-op).
   */
  async end(timeoutMs?: number): Promise<void> {
    if (this.state === 'idle' || this.currentId === null) return;
    const id = this.currentId;
    this.state = 'ending';
    this.clearTimers();
    this.flushStoredSession();
    this.clearStoredSession();
    const payload: SessionEndPayload = {
      session_id: id,
      ended_at: new Date(this.nowFn()).toISOString(),
      ended_reason: 'explicit',
    };
    try {
      const post = this.transport.postSessionEnd(payload);
      if (timeoutMs !== undefined) {
        await Promise.race([post, this.timeoutPromise(timeoutMs)]);
      } else {
        await post;
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.state = 'idle';
      this.currentId = null;
      this.startedAtMs = null;
      this.lastActivityMs = null;
      this.lastFlushedActivityMs = null;
    }
  }

  /**
   * Bounded-end called from `client.shutdown()`. Awaits the network end
   * call but also accepts an outer timeout. Reason is `shutdown`.
   */
  async shutdown(timeoutMs?: number): Promise<void> {
    if (this.state === 'idle' || this.currentId === null) return;
    const id = this.currentId;
    this.state = 'ending';
    this.clearTimers();
    this.flushStoredSession();
    const payload: SessionEndPayload = {
      session_id: id,
      ended_at: new Date(this.nowFn()).toISOString(),
      ended_reason: 'shutdown',
    };
    try {
      const post = this.transport.postSessionEnd(payload);
      if (timeoutMs !== undefined) {
        await Promise.race([post, this.timeoutPromise(timeoutMs)]);
      } else {
        await post;
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.state = 'idle';
      this.currentId = null;
      this.startedAtMs = null;
      this.lastActivityMs = null;
      this.lastFlushedActivityMs = null;
    }
  }

  /** Note that an event was just captured; bumps the inactivity clock. */
  noteActivity(): void {
    if (this.state !== 'active') return;
    const now = this.nowFn();
    this.lastActivityMs = now;
    this.armInactivityTimer();
    if (
      this.lastFlushedActivityMs === null ||
      now - this.lastFlushedActivityMs >= SESSION_STORAGE_FLUSH_INTERVAL_MS
    ) {
      this.flushStoredSession();
    }
  }

  /** Record an identity decoration to fold into the next session-start body. */
  setPendingIdentityForStart(userId: string, traits?: Record<string, unknown>): void {
    this.pendingIdentityForStart = traits === undefined ? { userId } : { userId, traits };
  }

  /** Discard any pending identity-for-start (after it ships, or on identify(null)). */
  clearPendingIdentityForStart(): void {
    this.pendingIdentityForStart = null;
  }

  /**
   * Re-issue `/v1/session/start` for the current session ID. Used by the
   * 409 `session_unknown` recovery path. Idempotent server-side.
   */
  async issueStart(): Promise<void> {
    if (this.currentId === null) return;
    const payload = this.buildStartPayload(this.currentId, this.startedAtMs ?? this.nowFn());
    try {
      await this.transport.postSessionStart(payload);
    } catch (err) {
      this.reportError(err);
    }
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private startNewSession(opts: { persistAndPost: boolean }): Ulid {
    const now = new Date(this.nowFn());
    const id = generateUlid(now);
    this.currentId = id;
    this.startedAtMs = now.getTime();
    this.lastActivityMs = now.getTime();
    this.lastFlushedActivityMs = null;
    this.state = 'active';
    this.armInactivityTimer();
    this.armMaxDurationTimer();
    if (opts.persistAndPost) {
      this.flushStoredSession();
      // Fire-and-forget — caller proceeds with the events batch immediately.
      const payload = this.buildStartPayload(id, now.getTime());
      // Clear the pending-identity slot now that it's about to ship; identity
      // remains set on `IdentityState` and decorates subsequent events.
      this.pendingIdentityForStart = null;
      void this.transport.postSessionStart(payload).catch((err) => this.reportError(err));
    }
    return id;
  }

  private buildStartPayload(id: Ulid, startedAtMs: number): SessionStartPayload {
    const payload: SessionStartPayload = {
      session_id: id,
      started_at: new Date(startedAtMs).toISOString(),
    };
    if (isBrowser()) {
      const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
      const ua = nav?.userAgent;
      if (typeof ua === 'string' && ua.length > 0) {
        payload.user_agent = ua.slice(0, 512);
      }
    }
    const attrs: Record<string, unknown> = {};
    if (isBrowser()) {
      const loc = (globalThis as { location?: { href?: string } }).location;
      if (typeof loc?.href === 'string') {
        attrs.page_url = loc.href;
      }
      const win = globalThis as { innerWidth?: number; innerHeight?: number };
      if (typeof win.innerWidth === 'number' && typeof win.innerHeight === 'number') {
        attrs.viewport = `${win.innerWidth}x${win.innerHeight}`;
      }
    }
    if (this.sessionAttributes) {
      try {
        const extra = this.sessionAttributes();
        if (extra && typeof extra === 'object') {
          for (const [k, v] of Object.entries(extra)) {
            attrs[k] = v;
          }
        }
      } catch (err) {
        this.reportError(err);
      }
    }
    if (Object.keys(attrs).length > 0) {
      payload.attributes = attrs;
    }
    // Identity for the start payload: prefer the pending slot, otherwise
    // fall back to whatever identity is currently set on IdentityState.
    let identityBlock: { user_id: string; traits?: Record<string, unknown> } | null = null;
    if (this.pendingIdentityForStart !== null) {
      identityBlock =
        this.pendingIdentityForStart.traits === undefined
          ? { user_id: this.pendingIdentityForStart.userId }
          : {
              user_id: this.pendingIdentityForStart.userId,
              traits: { ...this.pendingIdentityForStart.traits },
            };
    } else {
      const snap = this.identity.get();
      if (snap !== null) {
        identityBlock =
          snap.traits === undefined
            ? { user_id: snap.userId }
            : { user_id: snap.userId, traits: { ...snap.traits } };
      }
    }
    if (identityBlock !== null) {
      payload.identify = identityBlock;
    }
    return payload;
  }

  private armInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      this.clearTimerFn(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.inactivityTimer = this.setTimerFn(() => {
      this.inactivityTimer = null;
      this.rollover('inactivity');
    }, this.inactivityMs);
  }

  private armMaxDurationTimer(): void {
    if (this.maxDurationTimer !== null) {
      this.clearTimerFn(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    this.maxDurationTimer = this.setTimerFn(() => {
      this.maxDurationTimer = null;
      this.rollover('max_duration');
    }, this.maxDurationMs);
  }

  private clearTimers(): void {
    if (this.inactivityTimer !== null) {
      this.clearTimerFn(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.maxDurationTimer !== null) {
      this.clearTimerFn(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  /**
   * Roll the current session over: fire end fire-and-forget, then drop to
   * idle so the next `ensureStarted` lazy-starts a fresh session.
   */
  private rollover(reason: 'inactivity' | 'max_duration'): void {
    const oldId = this.currentId;
    this.clearTimers();
    if (oldId !== null) {
      this.fireSessionEnd(oldId, reason);
    }
    this.clearStoredSession();
    this.state = 'idle';
    this.currentId = null;
    this.startedAtMs = null;
    this.lastActivityMs = null;
    this.lastFlushedActivityMs = null;
  }

  private fireSessionEnd(id: Ulid, reason: SessionEndReason): void {
    const payload: SessionEndPayload = {
      session_id: id,
      ended_at: new Date(this.nowFn()).toISOString(),
      ended_reason: reason,
    };
    void this.transport.postSessionEnd(payload).catch((err) => this.reportError(err));
  }

  // -- persistence ------------------------------------------------------

  private tryRestore(): void {
    const ss = getSessionStorage();
    if (!ss) {
      // Browser context with broken sessionStorage: warn once.
      if (isBrowser() && !this.storageWarned) {
        this.storageWarned = true;
        this.reportError(
          new ResolveTraceError(
            'session.storage_unavailable',
            'sessionStorage is unavailable; falling back to in-memory session state.',
          ),
        );
      }
      return;
    }
    let raw: string | null;
    try {
      raw = ss.getItem(this.storageKey);
    } catch {
      if (!this.storageWarned) {
        this.storageWarned = true;
        this.reportError(
          new ResolveTraceError(
            'session.storage_unavailable',
            'sessionStorage threw on read; falling back to in-memory session state.',
          ),
        );
      }
      return;
    }
    if (!raw) return;
    let parsed: StoredSession | null = null;
    try {
      parsed = JSON.parse(raw) as StoredSession;
    } catch {
      try {
        ss.removeItem(this.storageKey);
      } catch {
        /* ignore */
      }
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (
      typeof parsed.session_id !== 'string' ||
      typeof parsed.started_at !== 'string' ||
      typeof parsed.last_activity_at !== 'string'
    ) {
      return;
    }
    const startedMs = Date.parse(parsed.started_at);
    const lastMs = Date.parse(parsed.last_activity_at);
    const now = this.nowFn();
    if (
      Number.isNaN(startedMs) ||
      Number.isNaN(lastMs) ||
      now - lastMs > this.inactivityMs ||
      now - startedMs > this.maxDurationMs
    ) {
      try {
        ss.removeItem(this.storageKey);
      } catch {
        /* ignore */
      }
      return;
    }
    this.currentId = parsed.session_id;
    this.startedAtMs = startedMs;
    this.lastActivityMs = lastMs;
    this.lastFlushedActivityMs = lastMs;
    this.state = 'active';
    this.armInactivityTimer();
    this.armMaxDurationTimer();
  }

  private flushStoredSession(): void {
    const ss = getSessionStorage();
    if (!ss) return;
    if (this.currentId === null || this.startedAtMs === null) return;
    const last = this.lastActivityMs ?? this.startedAtMs;
    const stored: StoredSession = {
      session_id: this.currentId,
      started_at: new Date(this.startedAtMs).toISOString(),
      last_activity_at: new Date(last).toISOString(),
    };
    try {
      ss.setItem(this.storageKey, JSON.stringify(stored));
      this.lastFlushedActivityMs = last;
    } catch {
      if (!this.storageWarned) {
        this.storageWarned = true;
        this.reportError(
          new ResolveTraceError(
            'session.storage_unavailable',
            'sessionStorage threw on write; falling back to in-memory session state.',
          ),
        );
      }
    }
  }

  private clearStoredSession(): void {
    const ss = getSessionStorage();
    if (!ss) return;
    try {
      ss.removeItem(this.storageKey);
    } catch {
      /* swallow */
    }
  }

  // -- error / timing helpers ------------------------------------------

  private reportError(err: unknown): void {
    if (!this.onError) return;
    try {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* onError must not throw */
    }
  }

  private timeoutPromise(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms) as unknown as { unref?: () => void };
      if (typeof t?.unref === 'function') t.unref();
    });
  }
}
