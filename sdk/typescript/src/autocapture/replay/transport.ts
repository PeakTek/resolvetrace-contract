/**
 * Replay chunk upload transport — the 3-leg flow against the existing
 * `replay.json` endpoints:
 *
 *   1. `POST /v1/replay/signed-url`  → `{ uploadUrl, key, expiresAt, maxBytes,
 *                                          requiredHeaders }`
 *   2. `PUT  <uploadUrl>`            → the chunk body (with `requiredHeaders`)
 *   3. `POST /v1/replay/complete`    → the manifest `{ sessionId, sequence,
 *                                          key, bytes, sha256, clientUploadedAt,
 *                                          scrubber }`
 *
 * Idempotency: the `(sessionId, sequence)` pair is stable across retries. A
 * chunk's `sequence` is assigned once by the chunker and never changes, so a
 * retried upload re-uses the same coordinates and the server can dedupe. We
 * compute sha256 + byte length once per chunk and re-send them unchanged.
 *
 * Fire-and-forget: every leg is wrapped so a failure surfaces via `onError` and
 * is dropped — replay is best-effort and must never block or throw into the app.
 */

import {
  REPLAY_CHUNK_CONTENT_TYPE,
  REPLAY_COMPLETE_PATH,
  REPLAY_RETRY_BASE_MS,
  REPLAY_RETRY_MAX_ATTEMPTS,
  REPLAY_RETRY_MAX_WAIT_MS,
  REPLAY_RETRY_STATUS_CODES,
  REPLAY_SIGNED_URL_PATH,
  SCRUBBER_VERSION,
} from '../../constants.js';
import { sha256Hex } from './digest.js';
import type { ReplayChunk } from './chunker.js';

/** The masking-config report attached to each manifest (`scrubber` block). */
export interface ReplayScrubberReport {
  readonly version: string;
  readonly rulesDigest: string;
  readonly applied: string[];
  readonly budgetExceeded: boolean;
}

export interface ReplayManifestBody {
  readonly sessionId: string;
  readonly sequence: number;
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly clientUploadedAt: string;
  readonly scrubber: ReplayScrubberReport;
}

export interface ReplaySignedUrlBody {
  readonly sessionId: string;
  readonly sequence: number;
  readonly approxBytes: number;
  readonly contentType: typeof REPLAY_CHUNK_CONTENT_TYPE;
}

interface SignedUrlResponse {
  uploadUrl: string;
  key: string;
  expiresAt?: string;
  maxBytes?: number;
  requiredHeaders?: Record<string, string>;
}

export interface ReplayTransportDeps {
  readonly endpointUrl: URL;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  /** The masking-config digest report attached to every manifest. */
  readonly scrubber: ReplayScrubberReport;
  /** Surface non-fatal errors (best-effort). */
  reportError?(err: Error): void;
  /** Optional sleep override for tests. */
  sleep?(ms: number): Promise<void>;
  /** Optional clock override for tests. */
  now?(): number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function backoff(attempt: number): number {
  const cap = Math.min(
    REPLAY_RETRY_BASE_MS * Math.pow(2, attempt),
    REPLAY_RETRY_MAX_WAIT_MS,
  );
  return Math.floor(cap * secureRandomFloat());
}

/**
 * Uploads replay chunks. One instance per recording session (carries the
 * shared scrubber report); `sessionId` is passed per-chunk so a single instance
 * can serve a session lifecycle.
 */
export class ReplayTransport {
  private readonly deps: ReplayTransportDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: ReplayTransportDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Upload one chunk through all three legs. Never throws; resolves `true` on a
   * durable complete, `false` when the chunk was dropped after retries.
   */
  async upload(sessionId: string, chunk: ReplayChunk): Promise<boolean> {
    try {
      const sha256 = await sha256Hex(chunk.bytes);
      const signed = await this.getSignedUrl(sessionId, chunk);
      if (!signed) return false;
      const put = await this.putChunk(signed, chunk);
      if (!put) return false;
      return await this.complete(sessionId, chunk, signed.key, sha256);
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  // --- Leg 1: signed-url ---------------------------------------------------
  private async getSignedUrl(
    sessionId: string,
    chunk: ReplayChunk,
  ): Promise<SignedUrlResponse | null> {
    const url = new URL(REPLAY_SIGNED_URL_PATH, this.deps.endpointUrl).toString();
    const body: ReplaySignedUrlBody = {
      sessionId,
      sequence: chunk.sequence,
      approxBytes: chunk.byteLength,
      contentType: REPLAY_CHUNK_CONTENT_TYPE,
    };
    const res = await this.withRetry(() =>
      this.deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Authorization: `Bearer ${this.deps.apiKey}`,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!res || res.status < 200 || res.status >= 300) {
      this.report(new Error(`replay signed-url failed (${res?.status ?? 'network'})`));
      return null;
    }
    try {
      const parsed = (await res.json()) as SignedUrlResponse;
      if (
        !parsed ||
        typeof parsed.uploadUrl !== 'string' ||
        typeof parsed.key !== 'string'
      ) {
        this.report(new Error('replay signed-url response malformed'));
        return null;
      }
      return parsed;
    } catch (err) {
      this.report(err);
      return null;
    }
  }

  // --- Leg 2: PUT the chunk ------------------------------------------------
  private async putChunk(
    signed: SignedUrlResponse,
    chunk: ReplayChunk,
  ): Promise<boolean> {
    const headers: Record<string, string> = {
      'Content-Type': REPLAY_CHUNK_CONTENT_TYPE,
      ...(signed.requiredHeaders ?? {}),
    };
    const res = await this.withRetry(() =>
      this.deps.fetchImpl(signed.uploadUrl, {
        method: 'PUT',
        headers,
        // A Uint8Array is a valid BodyInit; copy so the body is independent of
        // any later chunker reuse.
        body: chunk.bytes.slice() as unknown as BodyInit,
      }),
    );
    if (!res || res.status < 200 || res.status >= 300) {
      this.report(new Error(`replay PUT failed (${res?.status ?? 'network'})`));
      return false;
    }
    return true;
  }

  // --- Leg 3: complete -----------------------------------------------------
  private async complete(
    sessionId: string,
    chunk: ReplayChunk,
    key: string,
    sha256: string,
  ): Promise<boolean> {
    const url = new URL(REPLAY_COMPLETE_PATH, this.deps.endpointUrl).toString();
    const manifest: ReplayManifestBody = {
      sessionId,
      sequence: chunk.sequence,
      key,
      bytes: chunk.byteLength,
      sha256,
      clientUploadedAt: new Date(this.now()).toISOString(),
      scrubber: this.deps.scrubber,
    };
    const res = await this.withRetry(() =>
      this.deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Authorization: `Bearer ${this.deps.apiKey}`,
        },
        body: JSON.stringify(manifest),
      }),
    );
    if (!res || res.status < 200 || res.status >= 300) {
      this.report(new Error(`replay complete failed (${res?.status ?? 'network'})`));
      return false;
    }
    return true;
  }

  /**
   * Run `op` with bounded exponential-backoff retry on network failure or a
   * retryable status. Returns the final `Response` (which may be a non-2xx the
   * caller inspects) or `null` when every attempt was a network error.
   */
  private async withRetry(op: () => Promise<Response>): Promise<Response | null> {
    let attempt = 0;
    for (;;) {
      let res: Response | null = null;
      try {
        res = await op();
      } catch (err) {
        this.report(err);
        res = null;
      }
      if (res && !REPLAY_RETRY_STATUS_CODES.includes(res.status)) {
        return res;
      }
      attempt += 1;
      if (attempt > REPLAY_RETRY_MAX_ATTEMPTS) {
        return res;
      }
      await this.sleep(backoff(attempt));
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

/** Re-export so callers building a scrubber report can pin the SDK version. */
export { SCRUBBER_VERSION };
