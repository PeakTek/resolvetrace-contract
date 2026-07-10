/**
 * `ResolveTraceClient` — the only class customer code needs to import.
 *
 * The constructor accepts exactly `{ apiKey, endpoint }` plus a small set of
 * strictly-local hooks. Any other option is rejected. See the public README
 * for the supported surface.
 */

import { AutoCapture } from './autocapture/index.js';
import { resolveConfig } from './config.js';
import type { ResolvedConfig } from './config.js';
import { buildEnvelope } from './envelope.js';
import { SessionRequiredError } from './errors.js';
import { IdentityState } from './identity.js';
import {
  DEFAULT_RECENT_CONTEXT_SIZE,
  RecentContextBuffer,
} from './recent-context.js';
import { buildReportEvent } from './report.js';
import type { ReportProblemInput, ReportSource } from './report.js';
import { mountReportWidget } from './report-widget.js';
import type { ReportWidgetHandle } from './report-widget.js';
import { isBrowser } from './runtime.js';
import { SessionManager } from './session.js';
import { Transport } from './transport.js';
import type {
  ClientOptions,
  Diagnostics,
  EventAttributes,
  EventContext,
  EventInput,
  FlushOptions,
  FlushResult,
  SessionEndOptions,
  ShutdownOptions,
  Ulid,
} from './types.js';

/** Event types that receive automatic browser page-context enrichment. */
const PAGE_CONTEXT_EVENT_TYPES = new Set<string>(['page_view', 'view.start']);

/** Wire `type` for a submitted problem report. */
const REPORT_EVENT_TYPE = 'support.report_submitted';

/**
 * In a browser runtime, enrich page-oriented events with page URL + viewport.
 *
 * The structured event `context` block (see `EventContext` in the contract)
 * is the home for this data. But the contract requires the four core context
 * fields (`releaseVersion`, `locale`, `market`, `diagnosticsLevel`) whenever a
 * `context` object is present, and those cannot be derived from browser globals
 * alone. So the enricher behaves as follows:
 *
 *   - If the caller already supplied a top-level `context` (carrying the four
 *     required fields), the auto-captured `pageUrl` / `viewportWidth` /
 *     `viewportHeight` are merged INTO that top-level `context`, never
 *     overwriting any key the caller set. The result is a complete, valid
 *     `EventContext`.
 *   - If the caller did NOT supply a `context`, the auto-captured page fields
 *     ride under `attributes.context` (an unconstrained bag) instead, exactly
 *     as before. A partial top-level `context` would be rejected by the
 *     contract, so we never synthesize one.
 *
 * `pageUrl` is carried as an explicit optional field on `EventContext` (it is
 * not part of the abstract global-context vocabulary, which uses route names);
 * `viewportWidth` / `viewportHeight` are canonical context fields.
 */
function enrichPageContext(event: EventInput): EventInput {
  if (!isBrowser()) return event;
  if (!PAGE_CONTEXT_EVENT_TYPES.has(event.type)) return event;

  const page: Record<string, unknown> = {};
  const loc = (globalThis as { location?: { href?: string } }).location;
  if (typeof loc?.href === 'string') {
    page.pageUrl = loc.href;
  }
  const win = globalThis as { innerWidth?: number; innerHeight?: number };
  if (typeof win.innerWidth === 'number') {
    page.viewportWidth = win.innerWidth;
  }
  if (typeof win.innerHeight === 'number') {
    page.viewportHeight = win.innerHeight;
  }
  if (Object.keys(page).length === 0) return event;

  // Caller supplied a structured context → merge page fields into it (auto
  // fields fill gaps only; caller-set keys win). Yields a complete EventContext.
  if (event.context && typeof event.context === 'object') {
    return {
      ...event,
      context: { ...page, ...event.context } as EventContext,
    };
  }

  // No caller context → keep page fields on the unconstrained attributes bag,
  // so we never emit a partial (invalid) top-level context.
  const existingAttrs = event.attributes ?? {};
  const existingContext = existingAttrs['context'];
  const mergedContext =
    existingContext && typeof existingContext === 'object'
      ? { ...page, ...(existingContext as Record<string, unknown>) }
      : page;

  return {
    ...event,
    attributes: { ...existingAttrs, context: mergedContext },
  };
}

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
  private readonly autoCapture: AutoCapture;
  /** Last session id seen by `capture()`, used to reset the auto-capture ceiling. */
  private lastSeenSessionId: Ulid | null = null;
  /** Bounded breadcrumb trail of recent events, attached to problem reports. */
  private readonly recentContext = new RecentContextBuffer(
    DEFAULT_RECENT_CONTEXT_SIZE,
  );
  /** Auto-mounted report widget handle (browser-only; null when not mounted). */
  private reportWidgetHandle: ReportWidgetHandle | null = null;

  /** Public session controls. */
  public readonly session: {
    readonly id: Ulid | null;
    /**
     * Server-minted per-session support code for display ("Support code:
     * XXXXXXXX"). `null` until the first session-start resolves with one;
     * lives for the session's lifetime; replaced when a new session starts.
     */
    readonly supportCode: string | null;
    end: (opts?: SessionEndOptions) => Promise<void>;
    restart: () => Ulid;
  };

  /**
   * Public replay controls. In the default `'auto'` mode replay is
   * session-driven and these are no-ops; set `autoCapture.replay.mode:
   * 'manual'` and `start()` begins a capture span while `stop()` ends it.
   * Portable across deployments: calling them is always safe.
   *
   * `'manual'` mode — where a consent flow (e.g. a CMP) drives `start()`/
   * `stop()` — is host-configured and works on any deployment. Only the
   * server-side *enforcement* (admitting replay uploads only for sessions with
   * recorded end-user consent) is a **ResolveTrace Platform** capability; a
   * self-hosted OSS server has no consent gate, so it accepts host-triggered
   * manual uploads as-is (call `start()` only after consent). `start()`
   * resolves `true` only when a span actually began. See {@link ReplayMode}.
   */
  public readonly replay: {
    start: () => Promise<boolean>;
    stop: () => void;
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
    });
    // Wire transport's 409 recovery hook to the session manager.
    this.transport.setSessionUnknownHandler(async () => {
      await this.sessionManager.issueStart();
    });

    // Browser auto-capture (frustration signals; A2 adds error/network/perf).
    // Emits through `capture()` so scrubbing/session/context all apply. The
    // installer is a no-op outside a browser or when disabled.
    this.autoCapture = new AutoCapture({
      config: this.config,
      emit: (event) => {
        this.capture(event);
      },
      reportError: this.config.onError,
      // Replay (rrweb) upload transport + policy resolvers (browser-only).
      fetchImpl,
      currentRoute: () => {
        const loc = (globalThis as { location?: { pathname?: string } }).location;
        return typeof loc?.pathname === 'string' ? loc.pathname : undefined;
      },
      // No SDK-level diagnostics source today: returning undefined lets the
      // replay policy's own `minDiagnosticsLevel` default govern (A2's tenant
      // settings hook supplies the real level later).
      currentDiagnosticsLevel: () => undefined,
    });

    const mgr = this.sessionManager;
    this.session = Object.defineProperties({} as ResolveTraceClient['session'], {
      id: {
        enumerable: true,
        get: () => mgr.getId(),
      },
      supportCode: {
        enumerable: true,
        get: () => mgr.getSupportCode(),
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

    const ac = this.autoCapture;
    this.replay = Object.defineProperties({} as ResolveTraceClient['replay'], {
      start: { enumerable: true, value: () => ac.replayStart() },
      stop: { enumerable: true, value: () => ac.replayStop() },
    });

    // Install auto-capture last, once the client is fully wired. Browser-only;
    // no-op otherwise. Never throws into the constructor.
    try {
      this.autoCapture.install();
    } catch (err) {
      if (this.config.onError) {
        try {
          this.config.onError(err instanceof Error ? err : new Error(String(err)));
        } catch {
          /* swallow */
        }
      }
    }

    // Auto-mount the optional report widget when requested via config. Browser-
    // only and guarded inside `mountReportWidget`; never throws into the
    // constructor. Hosts can also mount it directly with `mountReportWidget`.
    if (this.config.reportWidget !== null) {
      try {
        this.reportWidgetHandle = mountReportWidget(
          {
            reportProblem: (input: ReportProblemInput) =>
              this.reportProblemInternal(input, 'widget'),
          },
          this.config.reportWidget,
        );
      } catch (err) {
        if (this.config.onError) {
          try {
            this.config.onError(err instanceof Error ? err : new Error(String(err)));
          } catch {
            /* swallow */
          }
        }
      }
    }
  }

  /**
   * Enqueue an event. Returns the client-generated ULID assigned to the
   * event so the caller can log / correlate it without waiting for the
   * round-trip.
   */
  capture(event: EventInput): string {
    // Auto-enrich page-oriented events with browser page context (URL +
    // viewport). No-op outside the browser and for non-page events.
    event = enrichPageContext(event);

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

    // A new session rolled (or first start) → reset the per-session ceiling so
    // auto-capture volume is bounded per session, not per process.
    if (sessionId !== this.lastSeenSessionId) {
      this.lastSeenSessionId = sessionId;
      this.autoCapture.resetSessionBudget();
      // Drive masked-replay capture to follow the session lifecycle (browser-
      // only; the recorder re-checks the full policy gate). Fire-and-forget.
      this.autoCapture.onSessionChanged(sessionId);
    }

    const actor = this.identityState.toActor();
    const envelope = buildEnvelope(
      { ...event, sessionId },
      actor === undefined ? {} : { actor },
    );

    // Record a metadata-only breadcrumb for this event so a later problem
    // report can attach recent context. The report event is excluded so it
    // never breadcrumbs itself. Never throws into capture().
    if (event.type !== REPORT_EVENT_TYPE) {
      try {
        this.recentContext.record(event, envelope.capturedAt);
      } catch {
        /* breadcrumb recording is best-effort */
      }
    }

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
   * Submit an in-app problem report. Emits the canonical
   * `support.report_submitted` event through `capture()` (so the Stage-1
   * scrubber + session all apply) carrying the user's description, the current
   * `session.supportCode` (when minted), and a short metadata-only breadcrumb
   * trail of recent events — scrubbed, with NO raw form content (doc-18
   * `report_controls`). Returns the client-generated event id (an empty string
   * if the event was dropped, e.g. `autoSession: false` with no session).
   *
   * Browser + node safe. Throws a `TypeError` only when `description` is
   * missing or blank — a contract the caller can rely on for client-side
   * validation.
   */
  reportProblem(input: ReportProblemInput): string {
    return this.reportProblemInternal(input, 'api');
  }

  /** Shared report path; `source` distinguishes the API from the widget. */
  private reportProblemInternal(
    input: ReportProblemInput,
    source: ReportSource,
  ): string {
    const event = buildReportEvent({
      input,
      supportCode: this.sessionManager.getSupportCode(),
      recentContext: this.recentContext.snapshot(),
      source,
    });
    return this.capture(event);
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
    // Tear down browser auto-capture first so no late listener fires during
    // the final flush. Idempotent + never throws.
    try {
      this.autoCapture.shutdown();
    } catch {
      /* swallow — teardown must never break shutdown */
    }
    // Tear down the auto-mounted report widget (idempotent; never throws).
    try {
      this.reportWidgetHandle?.destroy();
    } catch {
      /* swallow — teardown must never break shutdown */
    }
    this.reportWidgetHandle = null;
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
