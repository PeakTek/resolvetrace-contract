/**
 * Browser auto-capture lifecycle.
 *
 * The client constructs an `AutoCapture` instance after its own setup and (in a
 * browser, with auto-capture enabled) calls `install()`. `shutdown()` tears
 * everything down. Outside a browser, or when disabled, `install()` is a no-op.
 *
 * The framework owns:
 *   - the **source registry** (A1's three frustration sources today; A2 adds
 *     error / network / perf sources to `defaultSources()`),
 *   - the **emit gate**: every source emits through one bounded, scrubbed path
 *     (the client's `capture()`), with a per-session ceiling enforced here,
 *   - **teardown** of all installed sources.
 *
 * Nothing here is allowed to throw into the host app: `install()` and the emit
 * path swallow and report errors via the client's `onError` / debug logger.
 */

import type { ResolvedConfig } from '../config.js';
import { isBrowser } from '../runtime.js';
import type { DiagnosticsLevel, EventInput } from '../types.js';
import { ReplayRecorder } from './replay/index.js';
import type {
  BufferedClipSummary,
  ReplayPolicyProvider,
  ReplaySubmitResult,
  RrwebRecordFn,
} from './replay/index.js';
import { createApiSource } from './api.js';
import { createDeadClickSource } from './dead-click.js';
import { createErrorJsSource } from './error-js.js';
import { createErrorResourceSource } from './error-resource.js';
import { createLongTaskSource } from './long-task.js';
import { createRageClickSource } from './rage-click.js';
import { createRepeatedSubmitSource } from './repeated-submit.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

export type { CaptureContext, CaptureSource, Teardown } from './types.js';
export {
  describeTarget,
  describeForm,
  isInteractiveTarget,
  isMaskedTarget,
  MASKED_TOKEN,
} from './selector.js';

/** The capture sources installed by default. */
export function defaultSources(): CaptureSource[] {
  return [
    // Frustration signals (A1).
    createRageClickSource(),
    createDeadClickSource(),
    createRepeatedSubmitSource(),
    // Error / network / perf breadcrumbs (A2).
    createErrorJsSource(),
    createApiSource(),
    createErrorResourceSource(),
    createLongTaskSource(),
  ];
}

/** Dependencies the client injects so the framework can stay decoupled. */
export interface AutoCaptureDeps {
  /** Resolved client config (carries the validated `autoCapture` block). */
  readonly config: ResolvedConfig;
  /**
   * The client's single event ingress. Auto-capture emits through this so
   * scrubbing / session / context all apply — never a raw enqueue.
   */
  emit(event: EventInput): void;
  /** Surface a non-fatal capture error to the host app (best-effort). */
  reportError?(err: Error): void;
  /** Optional override of the source list (tests / A2 composition). */
  sources?: CaptureSource[];
  /**
   * fetch implementation for the replay upload transport. The client resolves
   * this from its config / global fetch and passes it through.
   */
  fetchImpl?: typeof fetch;
  /** Resolve the current diagnostics level (for replay level-gating). */
  currentDiagnosticsLevel?(): DiagnosticsLevel | undefined;
  /** Resolve the current route name (for the replay deny-list). */
  currentRoute?(): string | undefined;
  /** Documented tenant-settings policy hook for replay (Wave-24 A2 source). */
  replayPolicyProvider?: ReplayPolicyProvider;
  /** rrweb `record` override (tests). */
  rrwebRecord?: RrwebRecordFn;
}

export class AutoCapture {
  private readonly deps: AutoCaptureDeps;
  private readonly sources: CaptureSource[];
  private teardowns: Teardown[] = [];
  private installed = false;
  /** Auto-captured events emitted this session (against the ceiling). */
  private emittedCount = 0;
  /** Masked replay (rrweb) recorder; created on install in a browser. */
  private replay: ReplayRecorder | null = null;
  /** Session currently handed to the replay recorder. */
  private replaySessionId: string | null = null;

  constructor(deps: AutoCaptureDeps) {
    this.deps = deps;
    this.sources = deps.sources ?? defaultSources();
  }

  /**
   * Install all enabled capture sources. No-op outside a browser, when the
   * master switch is off, or if already installed. Never throws.
   */
  install(): void {
    if (this.installed) return;
    const ac = this.deps.config.autoCapture;
    if (!ac.enabled) return;
    if (!isBrowser()) return;

    const win = (globalThis as { window?: Window & typeof globalThis }).window;
    const doc = (globalThis as { document?: Document }).document;
    if (!win || !doc) return;

    const ctx: CaptureContext = {
      config: ac,
      maskSelectors: this.deps.config.maskSelectors,
      document: doc,
      window: win,
      emit: (event: EventInput): boolean => this.gatedEmit(event),
      debug: this.deps.config.debug
        ? (msg, detail) => {
            // eslint-disable-next-line no-console
            try {
              console.debug(`[resolvetrace:autocapture] ${msg}`, detail);
            } catch {
              /* ignore */
            }
          }
        : undefined,
    };

    for (const source of this.sources) {
      try {
        if (!source.isEnabled(ac)) continue;
        const teardown = source.install(ctx);
        this.teardowns.push(teardown);
      } catch (err) {
        this.report(err);
      }
    }

    // Masked replay recorder (browser-only; started per session). Built even
    // when the policy is disabled so a tenant-settings hook can enable it
    // later; `start()` re-checks the full gate (enabled/level/deny/sampling).
    try {
      const fetchImpl = this.deps.fetchImpl;
      if (fetchImpl) {
        this.replay = new ReplayRecorder({
          config: ac.replay,
          endpointUrl: this.deps.config.endpointUrl,
          apiKey: this.deps.config.apiKey,
          fetchImpl,
          currentDiagnosticsLevel: this.deps.currentDiagnosticsLevel,
          currentRoute: this.deps.currentRoute,
          policyProvider: this.deps.replayPolicyProvider,
          rrwebRecord: this.deps.rrwebRecord,
          reportError: this.deps.reportError,
        });
      }
    } catch (err) {
      this.report(err);
    }

    this.installed = true;
  }

  /**
   * Notify auto-capture that the active session changed. Drives the replay
   * recorder lifecycle: stop the old session's recording and start the new
   * one (subject to the policy gate). No-op when replay is unavailable.
   * Fire-and-forget; never throws.
   */
  onSessionChanged(sessionId: string): void {
    if (!this.replay) return;
    if (this.replaySessionId === sessionId) return;
    try {
      if (this.replay.isRecording) this.replay.stop();
      this.replaySessionId = sessionId;
      void this.replay.start(sessionId).catch((err) => this.report(err));
    } catch (err) {
      this.report(err);
    }
  }

  /** Tear down every installed source. Idempotent; never throws. */
  shutdown(): void {
    for (const teardown of this.teardowns) {
      try {
        teardown();
      } catch (err) {
        this.report(err);
      }
    }
    this.teardowns = [];
    // Stop + flush the replay recorder so the final partial chunk uploads.
    try {
      this.replay?.stop();
    } catch (err) {
      this.report(err);
    }
    this.replay = null;
    this.replaySessionId = null;
    this.installed = false;
  }

  /**
   * Public manual-mode replay start (`client.replay.start()`). Begins a capture
   * span when the resolved policy mode is `'manual'`; a no-op otherwise.
   * Fire-safe; never throws.
   */
  async replayStart(): Promise<boolean> {
    if (!this.replay) return false;
    try {
      return await this.replay.startManual();
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  /**
   * Public manual-mode replay stop (`client.replay.stop()`). Ends the current
   * manual span; a no-op in `'auto'`/`'off'`. Never throws.
   */
  replayStop(): void {
    if (!this.replay) return;
    try {
      this.replay.stopManual();
    } catch (err) {
      this.report(err);
    }
  }

  /** Public: buffered clips awaiting submit (`client.replay.listClips()`). */
  replayListClips(): BufferedClipSummary[] {
    if (!this.replay) return [];
    try {
      return this.replay.listClips();
    } catch (err) {
      this.report(err);
      return [];
    }
  }

  /** Public: drop a buffered clip by id (`client.replay.removeClip()`). */
  replayRemoveClip(clipId: number): boolean {
    if (!this.replay) return false;
    try {
      return this.replay.removeClip(clipId);
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  /** Public: upload buffered clips (`client.replay.submit()`). Never throws. */
  async replaySubmit(): Promise<ReplaySubmitResult> {
    if (!this.replay) return { uploaded: 0, failed: 0 };
    try {
      return await this.replay.submit();
    } catch (err) {
      this.report(err);
      return { uploaded: 0, failed: 0 };
    }
  }

  /** Public: discard buffered clips without uploading (`client.replay.discard()`). */
  replayDiscard(): void {
    if (!this.replay) return;
    try {
      this.replay.discard();
    } catch (err) {
      this.report(err);
    }
  }

  /** Test/observability hook: the live replay recorder, if any. */
  getReplayRecorder(): ReplayRecorder | null {
    return this.replay;
  }

  /**
   * Reset the per-session emit counter. The client calls this when a new
   * session starts so the ceiling is per-session, not per-process.
   */
  resetSessionBudget(): void {
    this.emittedCount = 0;
  }

  /** Test/observability hook: how many auto-events emitted this session. */
  getEmittedCount(): number {
    return this.emittedCount;
  }

  /**
   * The bounded emit gate. Enforces the per-session ceiling, then routes to the
   * client's `capture()`. Returns false when the ceiling was hit (dropped) so a
   * source can short-circuit. Never throws.
   */
  private gatedEmit(event: EventInput): boolean {
    try {
      const ceiling = this.deps.config.autoCapture.maxEventsPerSession;
      if (this.emittedCount >= ceiling) return false;
      this.emittedCount += 1;
      this.deps.emit(event);
      return true;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  private report(err: unknown): void {
    if (!this.deps.reportError) return;
    try {
      this.deps.reportError(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* swallow */
    }
  }
}
