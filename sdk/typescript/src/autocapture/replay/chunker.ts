/**
 * Replay event chunker.
 *
 * Buffers rrweb events for one session and cuts them into chunks bounded by
 * size and age. A chunk is the JSON serialization of `{ sessionId, sequence,
 * events }` encoded as UTF-8. The cut policy:
 *
 *   - **size cut**: when adding the next event would push the *serialized*
 *     chunk past `softBytes`, the current buffer is cut first (so a chunk stays
 *     well under the 3 MiB schema cap). A single event larger than `softBytes`
 *     still forms its own chunk (it cannot be split) but is rejected if it
 *     would exceed `maxBytes` — replay is best-effort, so such an event is
 *     dropped rather than producing an over-cap chunk the server rejects.
 *   - **age cut**: a partial buffer older than `maxAgeMs` is cut on the next
 *     `maybeCutByAge()` poll (driven by a timer in the recorder).
 *
 * The chunker is transport-agnostic and synchronous; sha256 (async) is computed
 * by the caller on the produced bytes.
 */

import {
  REPLAY_CHUNK_MAX_AGE_MS,
  REPLAY_CHUNK_SOFT_BYTES,
  REPLAY_MAX_CHUNK_BYTES,
} from '../../constants.js';

/** A cut, ready-to-upload replay chunk. */
export interface ReplayChunk {
  /** Monotonic sequence number within the session (starts at 0). */
  readonly sequence: number;
  /** UTF-8 encoded chunk body. */
  readonly bytes: Uint8Array;
  /** Exact byte length (== bytes.length). */
  readonly byteLength: number;
  /** Number of rrweb events in this chunk. */
  readonly eventCount: number;
  /** Wall-clock ms when the chunk's first event was buffered. */
  readonly openedAtMs: number;
}

export interface ChunkerOptions {
  readonly sessionId: string;
  readonly softBytes?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

const encoder = new TextEncoder();

export class ReplayChunker {
  private readonly sessionId: string;
  private readonly softBytes: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  /** Buffered, not-yet-serialized rrweb events for the open chunk. */
  private buffer: unknown[] = [];
  /** Running estimate of the serialized size of `buffer` (bytes). */
  private bufferBytes = 0;
  private openedAtMs: number | null = null;
  /** Next sequence number to assign. */
  private nextSequence = 0;
  /** Count of events dropped because a single event exceeded the cap. */
  public droppedOversizeEvents = 0;

  constructor(opts: ChunkerOptions) {
    this.sessionId = opts.sessionId;
    this.softBytes = opts.softBytes ?? REPLAY_CHUNK_SOFT_BYTES;
    this.maxBytes = opts.maxBytes ?? REPLAY_MAX_CHUNK_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? REPLAY_CHUNK_MAX_AGE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Number of events currently buffered (not yet cut). */
  get pendingEvents(): number {
    return this.buffer.length;
  }

  /**
   * Add an rrweb event. Returns a chunk if adding the event triggered a
   * size-based cut (the cut happens *before* the new event so the new event
   * opens the next chunk), otherwise `null`. The very large single-event case
   * is handled by emitting the prior buffer (if any) then attempting the lone
   * event as its own chunk.
   */
  add(event: unknown): ReplayChunk | null {
    const eventBytes = approxBytes(event);

    // A single event larger than the hard cap can never form a valid chunk.
    if (eventBytes + EMPTY_ENVELOPE_BYTES > this.maxBytes) {
      this.droppedOversizeEvents += 1;
      return null;
    }

    let cut: ReplayChunk | null = null;
    // If the buffer is non-empty and the next event would push us past the
    // soft threshold, cut the current buffer first.
    if (
      this.buffer.length > 0 &&
      this.bufferBytes + eventBytes + 1 /* comma */ > this.softBytes
    ) {
      cut = this.cut();
    }

    if (this.buffer.length === 0) {
      this.openedAtMs = this.now();
      this.bufferBytes = EMPTY_ENVELOPE_BYTES;
    } else {
      this.bufferBytes += 1; // comma separator between events
    }
    this.buffer.push(event);
    this.bufferBytes += eventBytes;
    return cut;
  }

  /**
   * Cut a chunk if the open buffer is older than `maxAgeMs`. Returns the chunk
   * or `null` when there is nothing to cut / it is not yet old enough.
   */
  maybeCutByAge(): ReplayChunk | null {
    if (this.buffer.length === 0 || this.openedAtMs === null) return null;
    if (this.now() - this.openedAtMs < this.maxAgeMs) return null;
    return this.cut();
  }

  /** Force-cut whatever is buffered (used on stop / teardown). */
  flush(): ReplayChunk | null {
    if (this.buffer.length === 0) return null;
    return this.cut();
  }

  /** Serialize + reset the open buffer into a sequenced chunk. */
  private cut(): ReplayChunk {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const eventCount = this.buffer.length;
    const openedAtMs = this.openedAtMs ?? this.now();
    const body = JSON.stringify({
      sessionId: this.sessionId,
      sequence,
      events: this.buffer,
    });
    const bytes = encoder.encode(body);
    // Reset for the next chunk.
    this.buffer = [];
    this.bufferBytes = 0;
    this.openedAtMs = null;
    return {
      sequence,
      bytes,
      byteLength: bytes.length,
      eventCount,
      openedAtMs,
    };
  }
}

/**
 * Approximate the serialized byte size of an rrweb event without a full
 * `JSON.stringify` round-trip on the hot path. We use UTF-8 length of the
 * stringification — rrweb events are plain JSON, so this is exact for them and
 * cheap enough at replay volumes.
 */
function approxBytes(event: unknown): number {
  try {
    return encoder.encode(JSON.stringify(event)).length;
  } catch {
    // Non-serializable (shouldn't happen for rrweb events) — treat as small.
    return 0;
  }
}

/** Bytes of the fixed envelope `{"sessionId":"...","sequence":N,"events":[]}`. */
const EMPTY_ENVELOPE_BYTES = 64;
