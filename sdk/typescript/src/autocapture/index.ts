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
import type { EventInput } from '../types.js';
import { createDeadClickSource } from './dead-click.js';
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

/** The capture sources installed by default. A2 appends its sources here. */
export function defaultSources(): CaptureSource[] {
  return [
    createRageClickSource(),
    createDeadClickSource(),
    createRepeatedSubmitSource(),
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
}

export class AutoCapture {
  private readonly deps: AutoCaptureDeps;
  private readonly sources: CaptureSource[];
  private teardowns: Teardown[] = [];
  private installed = false;
  /** Auto-captured events emitted this session (against the ceiling). */
  private emittedCount = 0;

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
    this.installed = true;
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
    this.installed = false;
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
