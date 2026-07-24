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

import { REPLAY_CHUNK_MAX_AGE_MS, REPLAY_MAX_BUFFERED_BYTES } from '../../constants.js';
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

/** A buffered replay clip the host can curate before submit (`'review'` mode). */
export interface BufferedClipSummary {
  /** Stable per-clip id (monotonic within the recorder's lifetime). */
  readonly clipId: number;
  /** Wall-clock ms of the clip's first buffered chunk (approx). */
  readonly startedAtMs: number;
  /** Approx clip length in ms (last − first buffered chunk). */
  readonly durationMs: number;
  /** Total rrweb events buffered in the clip. */
  readonly eventCount: number;
  /** Total serialized bytes buffered in the clip. */
  readonly bytes: number;
  /** Number of buffered chunks. */
  readonly chunkCount: number;
  /** True if the memory cap dropped chunks from this clip. */
  readonly truncated: boolean;
}

/** Result of `submit()` — buffered chunks uploaded vs failed. */
export interface ReplaySubmitResult {
  readonly uploaded: number;
  readonly failed: number;
}

/**
 * One buffered capture span held in `'review'` mode until `submit()`. Internal:
 * the raw masked `chunks` never leave the recorder except through `submit()`.
 */
interface BufferedClip {
  readonly clipId: number;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly scrubber: ReplayScrubberReport;
  chunks: ReplayChunk[];
  bytes: number;
  truncated: boolean;
}

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
  /** Sleep override for the upload transport backoff (tests). */
  sleep?(ms: number): Promise<void>;
  /** Memory ceiling for buffered (`'review'` mode) replay before submit (tests). */
  maxBufferedBytes?: number;
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
  /** Session the recorder is bound to (set on every session change, whether or
   * not recording starts) — so a later manual `start()` knows which session. */
  private boundSessionId: string | null = null;
  /**
   * High-water mark for replay chunk sequence numbers. Chunks are keyed by
   * `(sessionId, sequence)` server-side, so the sequence must CONTINUE across
   * manual start/stop spans within one session — otherwise a later span reuses
   * `0, 1, …` and overwrites the earlier recording. Reset only when the session
   * itself changes (tracked by `replaySequenceSessionId`).
   */
  private replaySequence = 0;
  private replaySequenceSessionId: string | null = null;
  private starting = false;

  /**
   * Buffered clips held in `'review'` mode until `submit()` uploads (or
   * `discard()` drops) them — nothing here has reached the server. The open
   * span's clip is `currentClip`; completed clips remain in `buffered`.
   */
  private buffered: BufferedClip[] = [];
  private currentClip: BufferedClip | null = null;
  private clipCounter = 0;
  private bufferedBytes = 0;
  private readonly maxBufferedBytes: number;
  /** Observability: chunks dropped because the buffer cap was hit. */
  public droppedBufferedChunks = 0;

  /** Observability: chunks the recorder has cut this lifetime. */
  public chunksCut = 0;
  /** Observability: chunks successfully completed (durable). */
  public chunksUploaded = 0;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
    this.policy = deps.config;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? REPLAY_MAX_BUFFERED_BYTES;
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
   * Start recording for `sessionId`, subject to the resolved replay `mode` and
   * the full policy gate. `trigger` says who is asking: `'auto'` (the session
   * lifecycle) or `'manual'` (a `client.replay.start()` call). Recording only
   * begins when `mode === trigger` (so `'off'` never records, an auto-trigger
   * is ignored in `manual` mode, and an explicit start is ignored in `auto`).
   * No-op (resolves false) when ineligible. Never throws.
   */
  async start(
    sessionId: string,
    trigger: 'auto' | 'manual' = 'auto',
  ): Promise<boolean> {
    if (this.starting || this.isRecording) return this.isRecording;
    // Review mode: a new session abandons the previous session's buffered clips
    // (they belong to that session's report). Never resets the sequence mark.
    if (
      this.boundSessionId !== null &&
      this.boundSessionId !== sessionId &&
      this.buffered.length > 0
    ) {
      this.discardBuffer();
    }
    // Bind the session even if we don't record it (manual mode needs it later).
    this.boundSessionId = sessionId;
    this.starting = true;
    try {
      if (!isBrowser()) return false;

      // Apply the tenant-settings override hook (documented seam). Resolves the
      // effective policy, including `mode`.
      await this.applyPolicyProvider();

      // Mode gate: only the matching trigger records. `mode: 'off'` matches
      // neither trigger, so it never records. `'review'` is user-driven like
      // `'manual'` (it just buffers instead of uploading), so both record on
      // the `'manual'` trigger.
      const recordingTrigger =
        this.policy.mode === 'review' ? 'manual' : this.policy.mode;
      if (recordingTrigger !== trigger) return false;

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
        sleep: this.deps.sleep,
      });
      // Continue the chunk sequence across spans in the same session; reset only
      // when the session changes — so a second recording doesn't overwrite the
      // first (chunks are keyed by `(sessionId, sequence)` server-side).
      if (this.replaySequenceSessionId !== sessionId) {
        this.replaySequence = 0;
        this.replaySequenceSessionId = sessionId;
      }
      this.chunker = new ReplayChunker({
        sessionId,
        startSequence: this.replaySequence,
      });
      this.recordingSessionId = sessionId;
      // Review mode: open a new clip for this span. Cut chunks buffer into it
      // (see dispatchChunk) instead of uploading; submit() sends them later.
      if (this.policy.mode === 'review') {
        this.currentClip = {
          clipId: this.clipCounter++,
          sessionId,
          startedAtMs: Date.now(),
          scrubber,
          chunks: [],
          bytes: 0,
          truncated: false,
        };
        this.buffered.push(this.currentClip);
      }

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
        // A recorder failure must never surface in a customer's session. rrweb
        // routes any error thrown inside its own observers / DOM serialization
        // here; we send it to internal diagnostics (`reportError`, i.e. the
        // host `onError` callback) and return `true` so rrweb swallows it
        // instead of rethrowing to `window.onerror` — which the SDK's own
        // `error.js` auto-capture would otherwise record as a session event.
        errorHandler: (error: unknown) => {
          this.report(error);
          return true;
        },
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

  /**
   * Public manual-mode start (`client.replay.start()`). Begins a capture span
   * for the bound session — but ONLY when the resolved policy mode is
   * `'manual'`; a documented no-op in `'auto'`/`'off'`. Resolves to whether
   * recording is now active. Multiple spans per session are allowed.
   */
  async startManual(): Promise<boolean> {
    if (!this.boundSessionId) return false;
    return this.start(this.boundSessionId, 'manual');
  }

  /**
   * Public manual-mode stop (`client.replay.stop()`). Ends the current manual
   * capture span. No-op unless the resolved policy mode is `'manual'`, so it
   * never stops an `'auto'`-mode session recording.
   */
  stopManual(): void {
    if (this.policy.mode !== 'manual' && this.policy.mode !== 'review') return;
    this.stop();
  }

  /**
   * List the buffered clips awaiting submit (`'review'` mode). Summaries only —
   * the raw masked bytes never leave the recorder except through `submit()`.
   * Empty outside review mode. Never throws.
   */
  listClips(): BufferedClipSummary[] {
    if (this.policy.mode !== 'review') return [];
    return this.buffered.map((clip) => summarizeClip(clip));
  }

  /**
   * Drop one buffered clip by id (`'review'` mode); returns whether it existed.
   * Sequences are never renumbered (each chunk's sequence is baked into its
   * hashed body) — a removed clip simply leaves a gap the server tolerates, and
   * the sequence high-water mark is never rolled back. No-op outside review mode.
   */
  removeClip(clipId: number): boolean {
    if (this.policy.mode !== 'review') return false;
    const idx = this.buffered.findIndex((c) => c.clipId === clipId);
    if (idx === -1) return false;
    const [removed] = this.buffered.splice(idx, 1);
    if (removed) {
      this.bufferedBytes = Math.max(0, this.bufferedBytes - removed.bytes);
      if (this.currentClip === removed) this.currentClip = null;
    }
    return true;
  }

  /**
   * Finalize any open span and upload every buffered clip's chunks, in sequence
   * order (`'review'` mode). The buffer is drained synchronously first so a
   * re-entrant call can't double-upload. Never throws — resolves with per-chunk
   * counts. No-op (`{uploaded:0,failed:0}`) outside review mode.
   */
  async submit(): Promise<ReplaySubmitResult> {
    const empty: ReplaySubmitResult = { uploaded: 0, failed: 0 };
    try {
      if (this.policy.mode !== 'review') return empty;
      if (this.isRecording) this.stop(); // finalize the open span → tail buffered
      const clips = this.buffered;
      this.buffered = [];
      this.currentClip = null;
      this.bufferedBytes = 0;
      if (clips.length === 0) return empty;
      let uploaded = 0;
      let failed = 0;
      // Dense 0-based clip index (array position, not clipId — that gaps after
      // removeClip). The transport sends it only for clips beyond the first;
      // the backend may reject clipIndex > 0 unless multi-clip is granted.
      for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
        const clip = clips[clipIndex]!;
        const transport = new ReplayTransport({
          endpointUrl: this.deps.endpointUrl,
          apiKey: this.deps.apiKey,
          fetchImpl: this.deps.fetchImpl,
          scrubber: clip.scrubber,
          reportError: this.deps.reportError,
          sleep: this.deps.sleep,
        });
        for (const chunk of clip.chunks) {
          try {
            const ok = await transport.upload(clip.sessionId, chunk, clipIndex);
            if (ok) {
              uploaded += 1;
              this.chunksUploaded += 1;
            } else {
              failed += 1;
            }
          } catch (err) {
            failed += 1;
            this.report(err);
          }
        }
      }
      return { uploaded, failed };
    } catch (err) {
      this.report(err);
      return empty;
    }
  }

  /**
   * Discard all buffered clips without uploading (`'review'` mode); stops an
   * open span first. Never resets the sequence high-water mark. No-op outside
   * review mode. Never throws.
   */
  discard(): void {
    if (this.policy.mode !== 'review') return;
    try {
      if (this.isRecording) this.stop();
      this.discardBuffer();
    } catch (err) {
      this.report(err);
    }
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

  /** Fire-and-forget upload of a cut chunk (or buffer it in `'review'` mode). */
  private dispatchChunk(chunk: ReplayChunk): void {
    this.chunksCut += 1;
    // Review mode: hold the chunk in the open clip's buffer; nothing uploads
    // until submit(). The memory cap is enforced in bufferChunk().
    if (this.policy.mode === 'review') {
      this.bufferChunk(chunk);
      return;
    }
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

  /** Buffer a cut chunk under the open clip (`'review'` mode); enforce the cap. */
  private bufferChunk(chunk: ReplayChunk): void {
    const clip = this.currentClip;
    if (!clip) {
      this.report(new Error('replay: buffered chunk with no open clip; dropped.'));
      return;
    }
    // Cap growth rather than FIFO-evict, so already-recorded clips survive; do
    // NOT stop rrweb here (we're inside its emit path — reentrancy risk).
    if (this.bufferedBytes + chunk.byteLength > this.maxBufferedBytes) {
      if (!clip.truncated) {
        clip.truncated = true;
        this.report(new Error('replay: buffer cap reached; clip truncated.'));
      }
      this.droppedBufferedChunks += 1;
      return;
    }
    clip.chunks.push(chunk);
    clip.bytes += chunk.byteLength;
    this.bufferedBytes += chunk.byteLength;
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
    // Preserve the chunk-sequence high-water mark so the next span in this
    // session continues from here instead of overwriting from 0.
    if (this.chunker) this.replaySequence = this.chunker.nextSeq;
    this.chunker = null;
    this.transport = null;
    this.recordingSessionId = null;
    // Close the open review clip (it stays in `buffered` for curation); the
    // next span opens a fresh clip. Completed clips are untouched.
    this.currentClip = null;
  }

  /** Clear the buffered clips; never touches the sequence high-water mark. */
  private discardBuffer(): void {
    this.buffered = [];
    this.currentClip = null;
    this.bufferedBytes = 0;
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

/** Summarize a buffered clip for the curation UI (no raw bytes leak). */
function summarizeClip(clip: BufferedClip): BufferedClipSummary {
  let firstAt = clip.startedAtMs;
  let lastAt = clip.startedAtMs;
  if (clip.chunks.length > 0) {
    firstAt = clip.chunks[0]!.openedAtMs;
    lastAt = clip.chunks[clip.chunks.length - 1]!.openedAtMs;
  }
  let eventCount = 0;
  for (const c of clip.chunks) eventCount += c.eventCount;
  return {
    clipId: clip.clipId,
    startedAtMs: firstAt,
    durationMs: Math.max(0, lastAt - firstAt),
    eventCount,
    bytes: clip.bytes,
    chunkCount: clip.chunks.length,
    truncated: clip.truncated,
  };
}

/** Re-export the disabled default for callers that need a baseline. */
export { defaultReplayConfig };
