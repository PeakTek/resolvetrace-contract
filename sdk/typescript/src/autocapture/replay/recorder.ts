/**
 * Replay recorder — wraps `rrweb.record()` behind the doc-19 adapter boundary.
 *
 * Responsibilities:
 *   - resolve the effective policy (config now; tenant-settings hook later),
 *   - gate capture (browser-only, enabled, diagnostics-level, deny-list,
 *     per-session sampling),
 *   - start rrweb with the **hard-defaulted masking config** (mask-on-by-default),
 *   - feed events to the chunker; upload cut chunks fire-and-forget,
 *   - tie start/stop to the session lifecycle and tear down on `shutdown()`.
 *
 * rrweb is imported lazily via a dynamic `import('rrweb')` so the dependency is
 * only resolved in a browser, never in Node builds / the schema dumper, and so
 * it stays tree-shakeable. Everything is wrapped so a capture failure can never
 * break the host app.
 */

import { REPLAY_CHUNK_MAX_AGE_MS } from '../../constants.js';
import { isBrowser } from '../../runtime.js';
import type { DiagnosticsLevel } from '../../types.js';
import { ReplayChunker } from './chunker.js';
import type { ReplayChunk } from './chunker.js';
import { sha256PrefixedOfString } from './digest.js';
import {
  defaultReplayConfig,
  diagnosticsLevelAllows,
  routeIsDenied,
} from './policy.js';
import type { ResolvedReplayConfig } from './policy.js';
import { ReplayTransport, SCRUBBER_VERSION } from './transport.js';
import type { ReplayScrubberReport } from './transport.js';

/** The rrweb `record` surface the adapter depends on (kept narrow + injectable). */
export type RrwebRecordFn = (options: Record<string, unknown>) => (() => void) | undefined;

/**
 * Async policy hook. Returns a (possibly partial) policy override resolved from
 * a tenant-settings source (Wave-24 A2). Documented seam — not wired to a live
 * source yet. Returning `undefined` means "use the config-resolved policy".
 */
export type ReplayPolicyProvider = () =>
  | Promise<Partial<ResolvedReplayConfig> | undefined>
  | Partial<ResolvedReplayConfig>
  | undefined;

export interface RecorderDeps {
  readonly config: ResolvedReplayConfig;
  readonly endpointUrl: URL;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  /** Current route name resolver (for the deny-list). Defaults to location.pathname. */
  currentRoute?: () => string | undefined;
  /** Current diagnostics level resolver (for level gating). */
  currentDiagnosticsLevel?: () => DiagnosticsLevel | undefined;
  /** Tenant-settings policy hook (documented seam; optional). */
  policyProvider?: ReplayPolicyProvider;
  /** rrweb `record` override — injected in tests; resolved lazily otherwise. */
  rrwebRecord?: RrwebRecordFn;
  /** Sampling RNG override (tests). Returns [0, 1). */
  sampler?: () => number;
  reportError?(err: Error): void;
}

function secureRandomFloat(): number {
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g && typeof g.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    g.getRandomValues(buf);
    return buf[0]! / 0x100000000;
  }
  return Math.random();
}

/** Lazily resolve `rrweb.record` in a browser. Returns `null` if unavailable. */
async function resolveRrwebRecord(): Promise<RrwebRecordFn | null> {
  try {
    // Dynamic import keeps rrweb out of the Node path and tree-shakeable.
    const mod = (await import('rrweb')) as { record?: RrwebRecordFn };
    return typeof mod.record === 'function' ? mod.record : null;
  } catch {
    return null;
  }
}

export class ReplayRecorder {
  private readonly deps: RecorderDeps;
  private policy: ResolvedReplayConfig;
  private stopRrweb: (() => void) | null = null;
  private chunker: ReplayChunker | null = null;
  private transport: ReplayTransport | null = null;
  private ageTimer: ReturnType<typeof setInterval> | null = null;
  private recordingSessionId: string | null = null;
  private starting = false;

  /** Observability: chunks the recorder has cut this lifetime. */
  public chunksCut = 0;
  /** Observability: chunks successfully completed (durable). */
  public chunksUploaded = 0;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
    this.policy = deps.config;
  }

  /** True while rrweb is actively recording. */
  get isRecording(): boolean {
    return this.stopRrweb !== null;
  }

  /** The session id currently being recorded, if any. */
  get sessionId(): string | null {
    return this.recordingSessionId;
  }

  /**
   * Start recording for `sessionId`, subject to the full policy gate. No-op
   * (resolves false) when ineligible. Never throws.
   */
  async start(sessionId: string): Promise<boolean> {
    if (this.starting || this.isRecording) return this.isRecording;
    this.starting = true;
    try {
      if (!isBrowser()) return false;

      // Apply the tenant-settings override hook (documented seam).
      await this.applyPolicyProvider();

      if (!this.eligible()) return false;

      const record = this.deps.rrwebRecord ?? (await resolveRrwebRecord());
      if (!record) {
        this.report(new Error('rrweb is not available; replay capture disabled.'));
        return false;
      }

      const scrubber = await this.buildScrubberReport();
      this.transport = new ReplayTransport({
        endpointUrl: this.deps.endpointUrl,
        apiKey: this.deps.apiKey,
        fetchImpl: this.deps.fetchImpl,
        scrubber,
        reportError: this.deps.reportError,
      });
      this.chunker = new ReplayChunker({ sessionId });
      this.recordingSessionId = sessionId;

      const m = this.policy.masking;
      const stop = record({
        emit: (event: unknown) => this.onEvent(event),
        // doc-18 replay_defaults — mask-on-by-default (hard).
        maskAllInputs: m.maskAllInputs,
        maskTextSelector: m.maskTextSelector,
        maskInputOptions: m.maskInputOptions,
        maskTextFn: () => '***',
        maskInputFn: () => '***',
        maskAttributeFn: () => '***',
        blockSelector: m.blockSelector,
        recordCanvas: m.recordCanvas,
        collectFonts: m.collectFonts,
      });
      this.stopRrweb = typeof stop === 'function' ? stop : null;
      if (!this.stopRrweb) {
        this.report(new Error('rrweb.record returned no stop handle.'));
        this.teardownState();
        return false;
      }

      // Age-based cut poll.
      this.ageTimer = setInterval(() => {
        try {
          const chunk = this.chunker?.maybeCutByAge();
          if (chunk) this.dispatchChunk(chunk);
        } catch (err) {
          this.report(err);
        }
      }, REPLAY_CHUNK_MAX_AGE_MS);
      const t = this.ageTimer as { unref?: () => void };
      if (typeof t?.unref === 'function') t.unref();

      return true;
    } catch (err) {
      this.report(err);
      this.teardownState();
      return false;
    } finally {
      this.starting = false;
    }
  }

  /** Stop recording + flush the final partial chunk. Idempotent; never throws. */
  stop(): void {
    try {
      if (this.stopRrweb) {
        this.stopRrweb();
      }
    } catch (err) {
      this.report(err);
    }
    try {
      const tail = this.chunker?.flush();
      if (tail) this.dispatchChunk(tail);
    } catch (err) {
      this.report(err);
    }
    this.teardownState();
  }

  // --- internals -----------------------------------------------------------

  private onEvent(event: unknown): void {
    try {
      const chunk = this.chunker?.add(event);
      if (chunk) this.dispatchChunk(chunk);
    } catch (err) {
      this.report(err);
    }
  }

  /** Fire-and-forget upload of a cut chunk. */
  private dispatchChunk(chunk: ReplayChunk): void {
    this.chunksCut += 1;
    const sid = this.recordingSessionId;
    const transport = this.transport;
    if (!sid || !transport) return;
    void transport
      .upload(sid, chunk)
      .then((ok) => {
        if (ok) this.chunksUploaded += 1;
      })
      .catch((err) => this.report(err));
  }

  /** Evaluate the full eligibility gate (after policy provider merge). */
  private eligible(): boolean {
    if (!this.policy.enabled) return false;

    // Diagnostics-level gating applies only when a level source is wired AND
    // reports a concrete level. With no level source (today's SDK), the
    // policy's `enabled` + sampling are the operative gate; A2's tenant-settings
    // hook supplies the real level later.
    const level = this.deps.currentDiagnosticsLevel?.();
    if (level !== undefined && !diagnosticsLevelAllows(level, this.policy.minDiagnosticsLevel)) {
      return false;
    }

    const route = this.currentRoute();
    if (route !== undefined && routeIsDenied(route, this.policy.denyRoutes)) {
      return false;
    }

    // Per-session sampling — decided once, here, at start.
    const roll = (this.deps.sampler ?? secureRandomFloat)();
    if (roll >= this.policy.sampleRate) return false;

    return true;
  }

  private currentRoute(): string | undefined {
    if (this.deps.currentRoute) return this.deps.currentRoute();
    const loc = (globalThis as { location?: { pathname?: string } }).location;
    return typeof loc?.pathname === 'string' ? loc.pathname : undefined;
  }

  private async applyPolicyProvider(): Promise<void> {
    if (!this.deps.policyProvider) {
      this.policy = this.deps.config;
      return;
    }
    try {
      const override = await this.deps.policyProvider();
      if (override && typeof override === 'object') {
        // Merge override onto config; masking can only be replaced wholesale by
        // the trusted tenant source, and even then it stays the masked shape.
        this.policy = {
          ...this.deps.config,
          ...override,
          masking: override.masking ?? this.deps.config.masking,
        };
      } else {
        this.policy = this.deps.config;
      }
    } catch (err) {
      this.report(err);
      this.policy = this.deps.config;
    }
  }

  /** Build the manifest `scrubber` block: version + masking-config digest. */
  private async buildScrubberReport(): Promise<ReplayScrubberReport> {
    const m = this.policy.masking;
    // Canonical, stable serialization of the masking config for the digest.
    const canon = JSON.stringify({
      blockSelector: m.blockSelector,
      collectFonts: m.collectFonts,
      maskAllInputs: m.maskAllInputs,
      maskInputOptions: m.maskInputOptions,
      maskTextSelector: m.maskTextSelector,
      recordCanvas: m.recordCanvas,
    });
    let rulesDigest: string;
    try {
      rulesDigest = await sha256PrefixedOfString(canon);
    } catch {
      // Digest is an audit aid, not a control; fall back to a stable sentinel.
      rulesDigest = `sha256:${'0'.repeat(64)}`;
    }
    return {
      version: SCRUBBER_VERSION,
      rulesDigest,
      applied: [
        'replay:rrweb',
        'replay:maskAllInputs',
        'replay:maskText',
        'replay:blockSelector',
      ],
      budgetExceeded: false,
    };
  }

  private teardownState(): void {
    this.stopRrweb = null;
    if (this.ageTimer !== null) {
      clearInterval(this.ageTimer);
      this.ageTimer = null;
    }
    this.chunker = null;
    this.transport = null;
    this.recordingSessionId = null;
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

/** Re-export the disabled default for callers that need a baseline. */
export { defaultReplayConfig };
