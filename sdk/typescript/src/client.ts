/**
 * `ResolveTraceClient` — the only class customer code needs to import.
 *
 * The constructor accepts exactly `{ apiKey, endpoint }` plus a small set of
 * strictly-local hooks. Any other option is rejected. See the public README
 * for the supported surface.
 */

import { resolveConfig } from './config.js';
import type { ResolvedConfig } from './config.js';
import { buildEnvelope } from './envelope.js';
import { SessionRequiredError } from './errors.js';
import { IdentityState } from './identity.js';
import { SessionManager } from './session.js';
import { Transport } from './transport.js';
import type {
  ClientOptions,
  Diagnostics,
  EventAttributes,
  EventInput,
  FlushOptions,
  FlushResult,
  SessionEndOptions,
  ShutdownOptions,
  Ulid,
} from './types.js';

/** Resolve a fetch implementation, preferring the user's injected one. */
function resolveFetch(cfg: ResolvedConfig): typeof fetch {
  if (cfg.transport) return cfg.transport;
  const g = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof g === 'function') {
    // Bind to `globalThis` so browsers that require a receiver keep working.
    return g.bind(globalThis);
  }
  throw new Error(
    'No global `fetch` is available in this runtime. Pass a fetch override via `transport` or upgrade to Node 18+.',
  );
}

/**
 * The dumb-client SDK: opaque `apiKey` in, events out.
 *
 * Customers never configure tenancy, environment, or region on this class;
 * every wire-affecting decision is encoded in their API key and resolved
 * server-side. See the project README for a high-level overview.
 */
export class ResolveTraceClient {
  private readonly config: ResolvedConfig;
  private readonly transport: Transport;
  private readonly identityState: IdentityState;
  private readonly sessionManager: SessionManager;

  /** Public session controls. */
  public readonly session: {
    readonly id: Ulid | null;
    end: (opts?: SessionEndOptions) => Promise<void>;
    restart: () => Ulid;
  };

  constructor(options: ClientOptions) {
    this.config = resolveConfig(options);
    const fetchImpl = resolveFetch(this.config);
    this.transport = new Transport(this.config, { fetchImpl });
    this.identityState = new IdentityState();
    this.sessionManager = new SessionManager({
      endpoint: this.config.endpoint,
      transport: {
        postSessionStart: (payload) => this.transport.postSessionStart(payload),
        postSessionEnd: (payload) => this.transport.postSessionEnd(payload),
      },
      identity: this.identityState,
      onError: this.config.onError,
      sessionInactivityMs: this.config.sessionInactivityMs,
      sessionMaxDurationMs: this.config.sessionMaxDurationMs,
      autoSession: this.config.autoSession,
      sessionAttributes: this.config.sessionAttributes,
    });
    // Wire transport's 409 recovery hook to the session manager.
    this.transport.setSessionUnknownHandler(async () => {
      await this.sessionManager.issueStart();
    });

    const mgr = this.sessionManager;
    this.session = Object.defineProperties({} as ResolveTraceClient['session'], {
      id: {
        enumerable: true,
        get: () => mgr.getId(),
      },
      end: {
        enumerable: true,
        value: (opts: SessionEndOptions = {}) => mgr.end(opts.timeoutMs),
      },
      restart: {
        enumerable: true,
        value: () => mgr.restart(),
      },
    });
  }

  /**
   * Enqueue an event. Returns the client-generated ULID assigned to the
   * event so the caller can log / correlate it without waiting for the
   * round-trip.
   */
  capture(event: EventInput): string {
    let sessionId: Ulid;
    try {
      sessionId = this.sessionManager.ensureStarted();
    } catch (err) {
      // autoSession: false with no active session → emit and drop.
      if (err instanceof SessionRequiredError) {
        if (this.config.onError) {
          try {
            this.config.onError(err);
          } catch {
            /* swallow */
          }
        }
        return '';
      }
      throw err;
    }
    this.sessionManager.noteActivity();

    const actor = this.identityState.toActor();
    const envelope = buildEnvelope(
      { ...event, sessionId },
      actor === undefined ? {} : { actor },
    );

    // Run the user-supplied `beforeSend` hook (strictly after Stage-1 scrub).
    if (this.config.beforeSend) {
      const transformed = this.runBeforeSend(envelope);
      if (transformed === null) {
        return envelope.eventId;
      }
      this.transport.enqueue(transformed);
      return transformed.eventId;
    }

    this.transport.enqueue(envelope);
    return envelope.eventId;
  }

  /** Convenience wrapper: `track("page_view", {path: "/home"})`. */
  track(name: string, attrs?: EventAttributes): string {
    return this.capture({ type: name, attributes: attrs });
  }

  /**
   * Set or clear the current identity decoration. Pass `null` for `userId`
   * to clear. Identity decorates subsequent events; it does NOT roll the
   * session and does NOT make a network call by itself.
   */
  identify(userId: string | null, traits?: Record<string, unknown>): void {
    if (userId === null) {
      this.identityState.clear();
      this.sessionManager.clearPendingIdentityForStart();
      return;
    }
    this.identityState.set(userId, traits);
    if (this.sessionManager.getId() === null) {
      // No session yet — the next /v1/session/start will include this identity.
      this.sessionManager.setPendingIdentityForStart(userId, traits);
    }
  }

  /** Forces the queue to drain immediately. Safe to call repeatedly. */
  async flush(opts: FlushOptions = {}): Promise<FlushResult> {
    return this.transport.flush(opts);
  }

  /**
   * Final flush + release of timers. After calling `shutdown()`, `capture()`
   * calls are dropped and `getDiagnostics()` reflects the drop count.
   */
  async shutdown(opts: ShutdownOptions = {}): Promise<void> {
    await this.transport.shutdown(opts);
    await this.sessionManager.shutdown(opts.timeoutMs);
  }

  /** Read-only counter snapshot for observability. */
  getDiagnostics(): Diagnostics {
    return this.transport.snapshot();
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  private runBeforeSend(envelope: ReturnType<typeof buildEnvelope>) {
    const hook = this.config.beforeSend;
    if (!hook) return envelope;
    try {
      const result = hook(envelope);
      if (result === undefined) return envelope;
      if (result === null) return null;
      return result;
    } catch (err) {
      if (this.config.onError) {
        try {
          this.config.onError(err instanceof Error ? err : new Error(String(err)));
        } catch {
          /* swallow */
        }
      }
      return envelope;
    }
  }
}

/**
 * Factory helper — mirrors the idiomatic `createClient({...})` pattern
 * customers expect from modern TS SDKs.
 */
export function createClient(options: ClientOptions): ResolveTraceClient {
  return new ResolveTraceClient(options);
}
