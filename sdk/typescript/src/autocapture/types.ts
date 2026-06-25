/**
 * Shared types for the browser auto-capture framework.
 *
 * The framework is an extensible registry of *capture sources*. A1 ships the
 * three frustration-signal sources (rage / dead / repeated-submit). A2 plugs
 * in error / network / perf sources by implementing the same `CaptureSource`
 * contract and adding them to the source list in `index.ts`.
 *
 * Sources never enqueue raw events and never touch the transport directly.
 * They emit through `ctx.emit(...)`, which routes to the client's `capture()`
 * so session correlation, page-context enrichment, and the Stage-1 scrubber
 * all apply — and which enforces the per-session volume ceiling.
 */

import type { ResolvedAutoCaptureConfig } from '../config.js';
import type { EventInput } from '../types.js';

/**
 * The host environment a capture source operates against. Sources MUST go
 * through this context rather than reaching for globals directly, so the
 * framework can substitute a simulated DOM in tests and so every emission is
 * bounded + scrubbed uniformly.
 */
export interface CaptureContext {
  /** Validated auto-capture config (thresholds, windows, flags, ceiling). */
  readonly config: ResolvedAutoCaptureConfig;
  /** User-supplied mask selectors (forwarded to the masked-selector helper). */
  readonly maskSelectors: ReadonlyArray<string>;
  /** The browser `document` (or a simulated stand-in in tests). */
  readonly document: Document;
  /** The browser `window` / global (or a simulated stand-in in tests). */
  readonly window: Window & typeof globalThis;
  /**
   * Emit an auto-captured event through the client's `capture()` pipeline.
   * Returns `false` when the per-session ceiling has been hit (the event was
   * dropped) so a source can short-circuit further work. NEVER throws.
   */
  emit(event: EventInput): boolean;
  /** Optional debug logger (no-op unless `debug` is enabled on the client). */
  readonly debug?: (msg: string, detail?: unknown) => void;
}

/**
 * A single auto-capture source. `install` wires up listeners/observers and
 * returns a teardown function; the framework calls every teardown on
 * `shutdown()`. `install` MUST wrap its own listener bodies in try/catch — a
 * capture failure must never break the host app.
 */
export interface CaptureSource {
  /** Stable identifier (for debug logging / dedupe). */
  readonly name: string;
  /** True when this source is enabled by the resolved config. */
  isEnabled(config: ResolvedAutoCaptureConfig): boolean;
  /** Wire up listeners; return a teardown. Must be self-contained + safe. */
  install(ctx: CaptureContext): Teardown;
}

/** Idempotent teardown for a capture source. */
export type Teardown = () => void;
